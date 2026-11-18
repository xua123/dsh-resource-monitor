/**
 * dsh-resource-monitor — host half.
 *
 * Owns three things:
 *   1. the SSH pool and the two collectors (local / remote),
 *   2. a short-lived snapshot cache so a burst of browser polls does not fan out
 *      into a burst of SSH commands,
 *   3. the small HTTP surface the browser half (and a plain browser tab) uses:
 *        GET  /dsh-resource-monitor/api/snapshot[?force=1]
 *        GET  /dsh-resource-monitor/api/targets
 *        POST /dsh-resource-monitor/api/targets
 *        DEL  /dsh-resource-monitor/api/targets/<id>
 *        GET  /dsh-resource-monitor/            → the standalone dashboard page
 *
 * The route deliberately lives outside `/plugins` (owned by dsh-client-modules)
 * and `/api` (owned by the API gateway) so it cannot shadow the plugin's own
 * client bundle.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { collectLocal, collectLocalDetails } from './collect-local.js'
import { collectRemote, collectRemoteDetails } from './collect-remote.js'
import { loadTargets, mergeTargets, toPublicTarget } from './machines.js'
import { addManualTarget, deleteManualTarget, hiddenTargetKey, hideTarget, loadHiddenTargets, loadManualTargets, loadTargetAliases, publicManualTarget, setTargetAlias, toSshTarget, unhideTarget } from './manual-targets.js'
import { SshPool, friendlyError } from './ssh.js'
import { createLimiter, dshHome, sleep, targetKey } from './util.js'

export const name = 'dsh-resource-monitor'

const PREFIX = '/dsh-resource-monitor'

/** Plugin defaults. Override any field from the profile's cordis config. */
const DEFAULTS = {
  /** Suggested browser refresh interval. */
  refreshMs: 10000,
  /** How long one collected snapshot is reused for non-forced requests. */
  cacheMs: 2500,
  /** Retry delay after a failed host, so an offline box is not dialed every poll. */
  errorCacheMs: 15000,
  includeSavedMachines: true,
  includeSshConfig: true,
  machinesFile: '',
  sshConfigFile: '',
  ignoreHosts: [],
  maxConcurrent: 6,
  commandTimeoutMs: 12000,
  connectTimeoutMs: 8000,
  idleCloseMs: 120000,
  hostKeyPolicy: 'tofu',
  showLocal: true,
  /** Hide hosts whose login failed, so the dashboard only shows useful cards. */
  hideAuthFailures: true,
  /** How long one browser request waits before returning "collecting" cards. */
  waitMs: 2500,
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  config.refreshMs = Math.max(1000, Number(config.refreshMs) || DEFAULTS.refreshMs)
  config.cacheMs = Math.max(500, Number(config.cacheMs) || DEFAULTS.cacheMs)
  config.errorCacheMs = Math.max(1000, Number(config.errorCacheMs) || DEFAULTS.errorCacheMs)
  config.maxConcurrent = Math.max(1, Math.min(16, Number(config.maxConcurrent) || DEFAULTS.maxConcurrent))
  config.commandTimeoutMs = Math.max(2000, Number(config.commandTimeoutMs) || DEFAULTS.commandTimeoutMs)
  config.connectTimeoutMs = Math.max(2000, Number(config.connectTimeoutMs) || DEFAULTS.connectTimeoutMs)
  config.idleCloseMs = Math.max(10000, Number(config.idleCloseMs) || DEFAULTS.idleCloseMs)
  config.waitMs = Math.max(500, Math.min(15000, Number(config.waitMs) || DEFAULTS.waitMs))
  config.showLocal = config.showLocal !== false
  config.hideAuthFailures = config.hideAuthFailures !== false
  config.includeSavedMachines = config.includeSavedMachines !== false
  config.includeSshConfig = config.includeSshConfig !== false
  config.ignoreHosts = Array.isArray(config.ignoreHosts) ? config.ignoreHosts : []
  return config
}

function loadDashboardHtml() {
  try {
    return fs.readFileSync(new URL('../assets/dashboard.html', import.meta.url), 'utf8')
  } catch (error) {
    return `<!doctype html><meta charset="utf-8"><title>服务器资源</title>
<body style="font:14px/1.6 system-ui;padding:24px;background:#12151c;color:#e8ecf5">
<h1>服务器资源</h1><p>仪表盘页面缺失：${String(error && error.message)}</p></body>`
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

/**
 * Merge one collector result with its target into the public card shape.
 * Nothing credential-shaped is ever copied here.
 */
function remoteView(target, record) {
  const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
  return {
    ...toPublicTarget(target),
    status: record.error === null ? 'online' : 'offline',
    stale: record.error !== null && record.data !== null,
    error: record.error === null ? null : { code: record.error.code, message: record.error.message },
    lastSuccessAt: record.lastSuccessAt || null,
    hostname: data.hostname || '',
    osName: data.osName || '',
    kernel: data.kernel || '',
    platform: data.platform || 'linux',
    cpu: data.cpu || { usage: null, cores: null, model: '' },
    memory: data.memory || { total: null, used: null, percent: null },
    swap: data.swap || null,
    gpus: Array.isArray(data.gpus) ? data.gpus : [],
    disk: data.disk || { percent: null, mounts: [] },
    load: data.load || null,
    processes: data.processes || null,
    uptime: data.uptime ?? null,
    latencyMs: data.latencyMs ?? null,
    sampledAt: data.sampledAt || null,
  }
}

function localView(data, error) {
  if (data === null || data === undefined) {
    return {
      id: 'local',
      kind: 'local',
      source: 'local',
      name: '本机',
      host: '',
      status: 'offline',
      stale: false,
      error: { code: 'INTERNAL', message: error || '本机指标采集失败' },
      lastSuccessAt: null,
      cpu: { usage: null, cores: null, model: '' },
      memory: { total: null, used: null, percent: null },
      swap: null,
      gpus: [],
      disk: { percent: null, mounts: [] },
      load: null,
      uptime: null,
      latencyMs: 0,
      sampledAt: null,
    }
  }
  return {
    id: 'local',
    kind: 'local',
    source: 'local',
    name: data.hostname || '本机',
    host: data.hostname || '',
    status: 'online',
    stale: false,
    error: null,
    lastSuccessAt: data.sampledAt || Date.now(),
    ...data,
  }
}

/**
 * A card for a host whose first collection has not finished yet.
 * The browser shows it as "采集中" instead of pretending the host is offline.
 */
function pendingView(target) {
  return {
    ...toPublicTarget(target),
    status: 'connecting',
    stale: false,
    error: null,
    lastSuccessAt: null,
    hostname: '',
    osName: '',
    kernel: '',
    platform: 'linux',
    cpu: { usage: null, cores: null, model: '' },
    memory: { total: null, used: null, percent: null },
    swap: null,
    gpus: [],
    disk: { percent: null, mounts: [] },
    load: null,
    processes: null,
    uptime: null,
    latencyMs: null,
    sampledAt: null,
  }
}

/**
 * Collect one host at most once at a time, reusing a fresh cached record.
 *
 * @param {object} target
 * @param {object} config
 * @param {object} state
 * @param {boolean} force
 */
async function collectTarget(target, config, state, force) {
  const key = targetKey(target)
  const cached = state.metrics.get(key)
  const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.at
  const ttl = cached !== undefined && cached.error !== null ? config.errorCacheMs : config.cacheMs
  if (!force && cached !== undefined && age < ttl) return remoteView(target, cached)

  const running = state.inflight.get(key)
  if (running !== undefined) return running

  const task = (async () => {
    try {
      const data = await collectRemote(state.pool, target, { timeoutMs: config.commandTimeoutMs })
      const record = {
        at: Date.now(),
        data,
        error: null,
        lastSuccessAt: data.sampledAt || Date.now(),
      }
      state.metrics.set(key, record)
      return remoteView(target, record)
    } catch (error) {
      const message = friendlyError(error)
      const code = (error && error.code) || 'INTERNAL'
      const record = {
        at: Date.now(),
        // Keep the last good sample so a briefly unreachable host still shows
        // the load it had a moment ago, clearly marked as stale.
        data: cached === undefined ? null : cached.data,
        error: { code, message },
        lastSuccessAt: cached === undefined ? null : cached.lastSuccessAt,
      }
      state.metrics.set(key, record)
      return remoteView(target, record)
    }
  })()
  state.inflight.set(key, task)
  task.finally(() => {
    if (state.inflight.get(key) === task) state.inflight.delete(key)
  })
  return task
}

/** A host that failed authentication is hidden from the dashboard by default. */
function isAuthFailure(entry) {
  return entry.status === 'offline'
    && entry.error !== null
    && entry.error !== undefined
    && (entry.error.code === 'AUTH' || entry.error.code === 'NO_CREDENTIALS')
}

/**
 * Build one snapshot. Remote hosts are collected through a concurrency-limited
 * pool; per-host failures become card-level errors and never reject the whole
 * snapshot.
 */
async function buildSnapshot(config, state, { force = false } = {}) {
  const loaded = loadTargets(config)
  const manualTargets = loadManualTargets().map(toSshTarget)
  const hidden = new Set(loadHiddenTargets().map((entry) => entry.key))
  const merged = mergeTargets(loaded.targets, manualTargets)
  const targets = hidden.size === 0
    ? merged
    : merged.filter((target) => !hidden.has(hiddenTargetKey(target.host, target.port)))
  const limiter = createLimiter(config.maxConcurrent)
  const startedAt = Date.now()

  const localTask = (async () => {
    if (!config.showLocal) return null
    try {
      return localView(await collectLocal(), null)
    } catch (error) {
      return localView(null, friendlyError(error))
    }
  })()

  const remoteTasks = targets.map((target) => limiter(() => collectTarget(target, config, state, force)))

  // Don't let one dead host hold the whole dashboard hostage: wait a short
  // while, then answer with cards for what we have. Collection continues in the
  // background and the next poll picks the results up (per-target in-flight
  // promises prevent a second SSH attempt for the same host).
  const local = await localTask
  const aliases = loadTargetAliases()
  if (local !== null && aliases.local) {
    local.defaultName = local.name
    local.name = aliases.local
  }
  const raced = await Promise.race([
    Promise.all(remoteTasks),
    sleep(config.waitMs).then(() => null),
  ])
  const collected = raced === null
    ? targets.map((target) => {
      const key = targetKey(target)
      const cached = state.metrics.get(key)
      return cached === undefined ? pendingView(target) : remoteView(target, cached)
    })
    : raced
  collected.forEach((entry) => {
    if (aliases[entry.id]) {
      entry.defaultName = entry.name
      entry.name = aliases[entry.id]
    }
  })
  const allRemotes = collected.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  const hiddenAuth = config.hideAuthFailures ? allRemotes.filter(isAuthFailure) : []
  const remoteList = hiddenAuth.length > 0
    ? allRemotes.filter((entry) => !hiddenAuth.includes(entry))
    : allRemotes
  const online = remoteList.filter((entry) => entry.status === 'online').length + (local && local.status === 'online' ? 1 : 0)
  const collecting = remoteList.filter((entry) => entry.status === 'connecting').length
  const total = remoteList.length + (local === null ? 0 : 1)

  return {
    ok: true,
    generatedAt: Date.now(),
    tookMs: Date.now() - startedAt,
    refreshMs: config.refreshMs,
    cacheMs: config.cacheMs,
    local,
    remotes: remoteList,
    summary: {
      total,
      online,
      offline: total - online - collecting,
      collecting,
      hiddenAuth: hiddenAuth.length,
      hiddenRemoved: merged.length - targets.length,
    },
    sources: {
      saved: loaded.sources.saved,
      sshConfig: loaded.sources.sshConfig,
      manual: manualTargets.length,
      hidden: hidden.size,
      savedFile: loaded.sources.savedFile,
      sshConfigFile: loaded.sources.sshConfigFile,
    },
    home: dshHome(),
  }
}

/**
 * Build the runtime pieces without a Cordis context.
 *
 * Exported so the bundled dev server (`scripts/dev-server.mjs`) and tests use
 * exactly the same collectors, cache and SSH pool as the plugin itself.
 *
 * @param {object} [rawConfig]
 */
export function createMonitor(rawConfig) {
  const config = normalizeConfig(rawConfig)
  const state = {
    config,
    pool: new SshPool({
      idleCloseMs: config.idleCloseMs,
      connectTimeoutMs: config.connectTimeoutMs,
      hostKeyPolicy: config.hostKeyPolicy,
      log: (message) => {
        try {
          console.warn(`[dsh-resource-monitor] ${message}`)
        } catch {
          /* logging must never break collection */
        }
      },
    }),
    metrics: new Map(),
    inflight: new Map(),
    detailsCache: new Map(),
    detailsInflight: new Map(),
    cache: { at: 0, data: null, inflight: null },
    /** Guards POST/DELETE; injected into the dashboard page only. */
    token: crypto.randomBytes(24).toString('hex'),
  }

  /** Snapshot with de-duplicated concurrent builds and a short TTL. */
  const snapshot = async ({ force = false } = {}) => {
    const now = Date.now()
    if (!force && state.cache.data !== null && now - state.cache.at < config.cacheMs) {
      return state.cache.data
    }
    if (state.cache.inflight !== null) return state.cache.inflight
    state.cache.inflight = buildSnapshot(config, state, { force })
      .then((value) => {
        state.cache.at = Date.now()
        state.cache.data = value
        return value
      })
      .finally(() => {
        state.cache.inflight = null
      })
    return state.cache.inflight
  }

  /** On-demand process & accelerator process details for one host (`local` or target.id). */
  const hostDetails = async (hostId, { force = false } = {}) => {
    const id = String(hostId || '').trim()
    if (id === '') throw Object.assign(new Error('缺少主机 ID'), { statusCode: 400 })
    const now = Date.now()
    const cached = state.detailsCache.get(id)
    if (!force && cached !== undefined && now - cached.at < 1500) {
      return cached.data
    }
    const running = state.detailsInflight.get(id)
    if (running !== undefined) return running

    const task = (async () => {
      let data
      if (id === 'local') {
        if (!config.showLocal) throw Object.assign(new Error('本机监控已禁用'), { statusCode: 404 })
        data = await collectLocalDetails()
      } else {
        const loaded = loadTargets(config)
        const manualTargets = loadManualTargets().map(toSshTarget)
        const merged = mergeTargets(loaded.targets, manualTargets)
        const target = merged.find((item) => item.id === id)
        if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
        data = await collectRemoteDetails(state.pool, target, { timeoutMs: config.commandTimeoutMs })
      }
      const payload = { ok: true, hostId: id, ...data }
      state.detailsCache.set(id, { at: Date.now(), data: payload })
      return payload
    })()

    state.detailsInflight.set(id, task)
    task.finally(() => {
      if (state.detailsInflight.get(id) === task) state.detailsInflight.delete(id)
    })
    return task
  }

  return {
    config,
    state,
    snapshot,
    hostDetails,
    close: () => state.pool.closeAll(),
  }
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function tokenMatches(req, token) {
  const given = String(req.headers['x-monitor-token'] || '')
  if (given.length !== token.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))
  } catch {
    return false
  }
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const monitor = createMonitor(rawConfig)
  const { config, state, snapshot: getSnapshot, hostDetails: getHostDetails } = monitor

  ctx.effect(() => () => {
    monitor.close()
  }, 'dsh-resource-monitor: close SSH pool')

  const dashboardHtml = loadDashboardHtml()
  const invalidate = () => {
    state.cache.at = 0
    state.cache.data = null
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const method = String(req.method || 'GET').toUpperCase()
          const pathname = url.pathname.replace(/\/+$/, '') || '/'
          const isWrite = method === 'POST' || method === 'DELETE'

          if (isWrite && !tokenMatches(req, state.token)) {
            sendJson(res, 403, { ok: false, error: '无效的写入令牌，请刷新页面后重试' })
            return
          }

          if (pathname === `${PREFIX}/api/snapshot`) {
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
            const snapshot = await getSnapshot({ force })
            if (method === 'HEAD') {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end()
              return
            }
            sendJson(res, 200, snapshot)
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/details')) {
            if (method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/details'.length)
            const hostId = decodeURIComponent(rawId)
            const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
            const details = await getHostDetails(hostId, { force })
            sendJson(res, 200, details)
            return
          }

          if (pathname === `${PREFIX}/api/hidden`) {
            if (method === 'GET' || method === 'HEAD') {
              const targets = loadHiddenTargets()
              if (method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, { ok: true, targets })
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              try {
                const target = hideTarget(body.host, body.port)
                invalidate()
                sendJson(res, 201, { ok: true, target })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hidden/`)) {
            if (method !== 'DELETE') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const key = decodeURIComponent(pathname.slice(`${PREFIX}/api/hidden/`.length))
            try {
              unhideTarget(key)
              invalidate()
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 404, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/aliases`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            try {
              const alias = setTargetAlias(body.id, body.name)
              invalidate()
              sendJson(res, 200, { ok: true, alias })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/targets`) {
            if (method === 'GET' || method === 'HEAD') {
              const targets = loadManualTargets().map(publicManualTarget)
              if (method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, { ok: true, targets })
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              try {
                const target = addManualTarget(body)
                invalidate()
                sendJson(res, 201, { ok: true, target })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/targets/`)) {
            if (method !== 'DELETE') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const id = decodeURIComponent(pathname.slice(`${PREFIX}/api/targets/`.length))
            try {
              deleteManualTarget(id)
              invalidate()
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 404, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === PREFIX || pathname === `${PREFIX}/index.html`) {
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (method === 'HEAD') {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              res.end()
              return
            }
            sendHtml(res, 200, dashboardHtml.replaceAll('__MONITOR_TOKEN__', state.token))
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          const status = Number(error && error.statusCode) || 500
          try {
            sendJson(res, status, { ok: false, error: friendlyError(error), code: (error && error.code) || 'INTERNAL' })
          } catch {
            res.destroy()
          }
        }
      },
    }), 'dsh-resource-monitor: http routes')
  })

  // Expose a tiny read-only service so a future command or tool can ask for the
  // same snapshot without duplicating the collectors.
  try {
    ctx.provide('serverMonitor', {
      snapshot: (options) => getSnapshot(options),
      invalidate: () => {
        state.cache.at = 0
        state.cache.data = null
        state.metrics.clear()
      },
      config: () => ({ ...config }),
    })
  } catch {
    /* an older Cordis without ctx.provide simply loses the optional service */
  }
}
