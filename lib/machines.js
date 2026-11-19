/**
 * Where the servers come from.
 *
 * This plugin is deliberately independent of dsh-remote: servers are discovered
 * from the local OpenSSH client config (`~/.ssh/config`) and from targets the
 * user adds in the panel. Authentication therefore uses the same keys, agent
 * and `Host` aliases the user already has in a terminal.
 *
 * Supported config surface: `Host` aliases, `HostName`, `User`, `Port`,
 * `IdentityFile`, a `Host *` defaults block, and `Include` files. `ProxyJump` /
 * `ProxyCommand` are parsed but not implemented by the ssh2 transport.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { dshHome, expandPath, isDialableHost } from './util.js'

function localUsername() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || process.env.USER || 'root'
  }
}

/** Default path of the user's OpenSSH client config. */
export function defaultSshConfigFile() {
  return path.join(os.homedir(), '.ssh', 'config')
}

/** Split `Key value` / `Key=value` config lines without choking on spacing. */
function splitConfigLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq > 0 && /^[A-Za-z]+$/.test(trimmed.slice(0, eq).trim())) {
    return [trimmed.slice(0, eq).trim().toLowerCase(), trimmed.slice(eq + 1).trim()]
  }
  const space = trimmed.search(/\s/)
  if (space < 0) return null
  return [trimmed.slice(0, space).toLowerCase(), trimmed.slice(space + 1).trim()]
}

/** Remove one layer of matching single/double quotes. */
function unquote(value) {
  const v = String(value == null ? '' : value).trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** Expand the OpenSSH tokens we can resolve locally. */
function expandIdentity(file, entry) {
  let out = unquote(file)
  if (out === '') return ''
  out = out.replace(/%d/g, os.homedir())
  out = out.replace(/%h/g, entry.hostName || entry.alias || '')
  out = out.replace(/%r/g, entry.user || '')
  out = out.replace(/%u/g, localUsername())
  return expandPath(out)
}

/**
 * Parse an OpenSSH client config into concrete host blocks.
 *
 * Concrete blocks are merged with first-wins semantics, matching OpenSSH's
 * "first obtained value" rule. A `Host *` block supplies defaults for values
 * the concrete block omits.
 *
 * @param {string} text
 * @returns {Array<object>} concrete host entries
 */
export function parseSshConfig(text) {
  const blocks = []
  let current = null
  const finish = () => {
    if (current !== null && current.patterns.length > 0) blocks.push(current)
    current = null
  }
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const pair = splitConfigLine(rawLine)
    if (pair === null) continue
    const [key, value] = pair
    if (key === 'host') {
      finish()
      current = {
        patterns: value.split(/\s+/).filter(Boolean),
        hostName: '',
        user: '',
        port: 0,
        identityFile: '',
        proxyJump: '',
      }
      continue
    }
    if (key === 'match') {
      finish()
      continue
    }
    if (current === null) continue
    if (key === 'hostname') current.hostName = unquote(value)
    else if (key === 'user' && current.user === '') current.user = unquote(value)
    else if (key === 'port' && !current.port) current.port = Number.parseInt(value, 10) || 0
    else if (key === 'identityfile' && current.identityFile === '') current.identityFile = unquote(value)
    else if (key === 'proxyjump') current.proxyJump = unquote(value)
  }
  finish()

  // A `Host *` block is a defaults block, not a real entry.
  const defaults = { user: '', port: 0, identityFile: '', proxyJump: '' }
  for (const block of blocks) {
    if (!block.patterns.includes('*')) continue
    if (defaults.user === '' && block.user !== '') defaults.user = block.user
    if (!defaults.port && block.port) defaults.port = block.port
    if (defaults.identityFile === '' && block.identityFile !== '') defaults.identityFile = block.identityFile
    if (defaults.proxyJump === '' && block.proxyJump !== '') defaults.proxyJump = block.proxyJump
    break
  }

  const byAlias = new Map()
  for (const block of blocks) {
    for (const alias of block.patterns) {
      if (alias === '' || /[*?]/.test(alias)) continue
      const prev = byAlias.get(alias)
      const entry = {
        alias,
        hostName: block.hostName || defaults.hostName || '',
        user: block.user || defaults.user,
        port: block.port || defaults.port || 0,
        identityFile: block.identityFile || defaults.identityFile,
        proxyJump: block.proxyJump || defaults.proxyJump,
      }
      if (prev === undefined) {
        byAlias.set(alias, entry)
        continue
      }
      // First block wins for each field; later blocks only fill gaps.
      if (prev.hostName === '' && entry.hostName !== '') prev.hostName = entry.hostName
      if (prev.user === '' && entry.user !== '') prev.user = entry.user
      if (!prev.port && entry.port) prev.port = entry.port
      if (prev.identityFile === '' && entry.identityFile !== '') prev.identityFile = entry.identityFile
      if (prev.proxyJump === '' && entry.proxyJump !== '') prev.proxyJump = entry.proxyJump
    }
  }
  return [...byAlias.values()]
}

/** Expand `Include` patterns (`~`, `*`) into local files. */
function expandInclude(value) {
  const raw = expandPath(unquote(value))
  if (raw === '') return []
  if (!/[*?]/.test(raw)) return [raw]
  const dir = path.dirname(raw)
  const base = path.basename(raw)
  const re = new RegExp(`^${base.split('').map((ch) => {
    if (ch === '*') return '.*'
    if (ch === '?') return '.'
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')}$`, 'i')
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && re.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** Read a config file plus its `Include` files (depth-limited). */
function readConfigTree(file, depth = 0, seen = new Set()) {
  if (depth > 5) return ''
  const resolved = path.resolve(file)
  if (seen.has(resolved)) return ''
  seen.add(resolved)
  let text = ''
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch {
    return ''
  }
  const included = []
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*Include\s+(.+)$/i)
    if (match === null) continue
    for (const child of expandInclude(match[1])) {
      const childText = readConfigTree(child, depth + 1, seen)
      if (childText !== '') included.push(childText)
    }
  }
  return included.length === 0 ? text : `${text}\n${included.join('\n')}`
}

/** Read `~/.ssh/config` into concrete host entries. */
export function readSshConfigTargets(file = defaultSshConfigFile()) {
  const text = readConfigTree(file)
  if (text === '') return []
  return parseSshConfig(text).map((entry) => {
    const host = entry.hostName || entry.alias
    return {
      id: `ssh:${entry.alias}`,
      kind: 'remote',
      source: 'ssh-config',
      name: entry.alias,
      alias: entry.alias,
      host,
      port: entry.port || 22,
      username: entry.user,
      password: '',
      privateKeyPath: entry.identityFile === '' ? '' : expandIdentity(entry.identityFile, entry),
      passphrase: '',
      useAgent: false,
      useSshConfig: true,
      backend: 'native',
    }
  })
}

/** Glob-ish host filter: exact match, or `*` / `?` wildcards. */
function matchesAny(patterns, value) {
  const v = String(value == null ? '' : value).toLowerCase()
  for (const pattern of patterns) {
    const p = String(pattern == null ? '' : pattern).trim().toLowerCase()
    if (p === '') continue
    if (p === v) return true
    if (!/[*?]/.test(p)) continue
    const re = new RegExp(`^${p.split('').map((ch) => {
      if (ch === '*') return '.*'
      if (ch === '?') return '.'
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')}$`, 'i')
    if (re.test(v)) return true
  }
  return false
}

/**
 * Build the effective target list for one snapshot.
 *
 * @param {object} config normalized plugin config
 * @returns {{targets: Array<object>, sources: {sshConfig: number, sshConfigFile: string}}}
 */
export function loadTargets(config) {
  const sshConfigFile = config.sshConfigFile ? expandPath(config.sshConfigFile) : defaultSshConfigFile()
  const discovered = config.includeSshConfig === false ? [] : readSshConfigTargets(sshConfigFile)

  const byKey = new Map()
  for (const entry of discovered) {
    if (!isDialableHost(entry.host)) continue
    if (entry.username === '') entry.username = localUsername()
    const key = `${String(entry.host).toLowerCase()}:${Number(entry.port) || 22}`
    if (!byKey.has(key)) byKey.set(key, entry)
  }

  const ignore = Array.isArray(config.ignoreHosts) ? config.ignoreHosts : []
  const targets = [...byKey.values()]
    .filter((entry) => !matchesAny(ignore, entry.host) && !matchesAny(ignore, entry.name))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))

  return {
    targets,
    sources: {
      sshConfig: discovered.length,
      sshConfigFile,
    },
  }
}

/**
 * Merge manual targets over the discovered ones. A server the user explicitly
 * added from the dashboard wins over an ssh-config record for the same host and
 * port, because it carries the credentials they just entered.
 *
 * @param {Array<object>} base
 * @param {Array<object>} extra
 * @returns {Array<object>}
 */
export function mergeTargets(base, extra) {
  const byKey = new Map()
  for (const entry of base) byKey.set(`${String(entry.host).toLowerCase()}:${Number(entry.port) || 22}`, entry)
  for (const entry of extra) byKey.set(`${String(entry.host).toLowerCase()}:${Number(entry.port) || 22}`, entry)
  return [...byKey.values()]
}

const sessionHostCache = new Map()

function readSessionCwd(sessionDir) {
  let names
  try {
    names = fs.readdirSync(sessionDir)
  } catch {
    return ''
  }
  const file = names.find((name) => name.endsWith('.zstd'))
  if (file === undefined) return ''
  try {
    if (typeof zlib.zstdDecompressSync !== 'function') return ''
    const raw = zlib.zstdDecompressSync(fs.readFileSync(path.join(sessionDir, file))).toString('utf8')
    const first = JSON.parse(raw.split('\n')[0])
    return typeof first.cwd === 'string' ? first.cwd : ''
  } catch {
    return ''
  }
}

/** Find the ssh-config target whose address appears in the workspace path. */
function matchWorkspaceTarget(cwd, sessionDirName) {
  const targets = readSshConfigTargets()
  const cwdIps = String(cwd).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
  const dirIps = (String(sessionDirName).match(/(?:\d{1,3}-){3}\d{1,3}/g) || [])
    .map((value) => value.replace(/-/g, '.'))
  const haystack = `${cwd} ${sessionDirName}`.toLowerCase()
  for (const target of targets) {
    const host = target.host.toLowerCase()
    if (cwdIps.includes(host) || dirIps.includes(host) || haystack.includes(host)) return target
  }
  for (const target of targets) {
    const alias = String(target.alias || '').toLowerCase()
    if (alias.length >= 4 && haystack.includes(alias)) return target
  }
  return null
}

/**
 * Resolve a DSH session to the server its workspace is linked to.
 *
 * Uses only DSH's own session metadata (the `cwd` header inside the session
 * file) plus the local ssh config. It does not read dsh-remote's registry or
 * mirror metadata: a remote mirror path such as
 * `.../remote-workspaces/203.0.113.10-test-22/git` is matched against the ssh
 * config HostName. A workspace that has no matching ssh target is treated as
 * local.
 */
export function resolveWorkspaceSession(sessionId) {
  const clean = String(sessionId == null ? '' : sessionId).trim()
  if (clean === '') return null
  const id = clean.startsWith('session-') ? clean : `session-${clean}`
  const cached = sessionHostCache.get(id)
  if (cached !== undefined && Date.now() - cached.at < 5000) return cached.value

  let dirs
  try {
    dirs = fs.readdirSync(path.join(dshHome(), 'sessions'), { withFileTypes: true })
  } catch {
    return null
  }
  for (const dirent of dirs) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const sessionDir = path.join(dshHome(), 'sessions', dirent.name, id)
    if (!fs.existsSync(sessionDir)) continue
    const cwd = readSessionCwd(sessionDir)
    const target = matchWorkspaceTarget(cwd, dirent.name)
    let value
    if (target !== null) {
      value = {
        local: false,
        host: target.host,
        id: target.id,
        username: target.username,
        path: cwd,
      }
    } else if (/[\\/]remote-workspaces[\\/]/i.test(cwd) || /remote-workspaces/i.test(dirent.name)) {
      value = { local: false, host: '', path: cwd }
    } else {
      value = { local: true, path: cwd }
    }
    sessionHostCache.set(id, { at: Date.now(), value })
    return value
  }
  return null
}

export function resolveWorkspacePath(localPath) {
  const raw = String(localPath == null ? '' : localPath).trim()
  if (raw === '') return null
  const target = matchWorkspaceTarget(raw, '')
  if (target !== null) {
    return { local: false, host: target.host, id: target.id, username: target.username, path: raw }
  }
  if (/[\\/]remote-workspaces[\\/]/i.test(raw)) return { local: false, host: '', path: raw }
  return { local: true, path: raw }
}

/** Strip credentials before a target is allowed anywhere near the browser. */
export function toPublicTarget(target) {
  return {
    id: target.id,
    kind: target.kind,
    source: target.source,
    name: target.name,
    alias: target.alias || '',
    host: target.host,
    port: Number(target.port) || 22,
    username: target.username || '',
    ...(target.manualId ? { manualId: target.manualId } : {}),
  }
}
