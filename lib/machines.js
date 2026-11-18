/**
 * Where the servers come from.
 *
 * Two registries are merged, because a DSH user typically has both:
 *
 *  1. `dsh-remote`'s saved machines (`$DSH_HOME/remote-workspaces/machines.json`)
 *     — these carry the credentials the user already configured, including
 *     plaintext passwords when the record uses the `plain` credential backend.
 *     They never leave this process: only sanitized metric payloads reach the
 *     browser, and `toPublicTarget()` is the single gate for that.
 *  2. `~/.ssh/config` host blocks — so servers the user reaches from a terminal
 *     show up too, authenticated by key or agent.
 *
 * Records are de-duplicated by `host:port:user`; a saved machine wins because it
 * knows how to authenticate. Malformed records (a display name accidentally
 * stored in `host`) are dropped rather than dialed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshHome, expandPath, isDialableHost, readJsonFile } from './util.js'

function localUsername() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || process.env.USER || 'root'
  }
}

/** Default path of the dsh-remote machine registry. */
export function defaultMachinesFile() {
  return path.join(dshHome(), 'remote-workspaces', 'machines.json')
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

/**
 * Parse an OpenSSH client config into concrete host blocks.
 *
 * Wildcard blocks (`Host *`) are treated as defaults we deliberately do not
 * implement: the metric collector dials by explicit host, and silently applying
 * a `ProxyJump` or `User` default from a wildcard block would surprise more
 * than it helps. Concrete blocks are merged with first-wins semantics, matching
 * OpenSSH's "first obtained value" rule.
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
    else if (key === 'user') current.user = unquote(value)
    else if (key === 'port') current.port = Number.parseInt(value, 10) || 0
    else if (key === 'identityfile') current.identityFile = unquote(value)
    else if (key === 'proxyjump') current.proxyJump = unquote(value)
  }
  finish()

  const byAlias = new Map()
  for (const block of blocks) {
    for (const alias of block.patterns) {
      if (alias === '' || /[*?]/.test(alias)) continue
      const prev = byAlias.get(alias)
      if (prev === undefined) {
        byAlias.set(alias, { alias, ...block, patterns: undefined })
        continue
      }
      // First block wins for each field; later blocks only fill gaps.
      if (prev.hostName === '' && block.hostName !== '') prev.hostName = block.hostName
      if (prev.user === '' && block.user !== '') prev.user = block.user
      if (!prev.port && block.port) prev.port = block.port
      if (prev.identityFile === '' && block.identityFile !== '') prev.identityFile = block.identityFile
      if (prev.proxyJump === '' && block.proxyJump !== '') prev.proxyJump = block.proxyJump
    }
  }
  return [...byAlias.values()]
}

/** Read `~/.ssh/config` into concrete host entries. */
export function readSshConfigTargets(file = defaultSshConfigFile()) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return parseSshConfig(text).map((entry) => ({
    id: `ssh:${entry.alias}`,
    kind: 'remote',
    source: 'ssh-config',
    name: entry.alias,
    alias: entry.alias,
    host: entry.hostName || entry.alias,
    port: entry.port || 22,
    username: entry.user,
    password: '',
    privateKeyPath: entry.identityFile,
    passphrase: '',
    useAgent: false,
    useSshConfig: true,
    backend: 'native',
  }))
}

/**
 * Read dsh-remote's machine registry.
 *
 * The registry is read-only here: the plugin never rewrites it. Fields are
 * normalized because older records omit several of them, and `host` is
 * validated because a few records store a display label there.
 */
export function readSavedTargets(file = defaultMachinesFile()) {
  const data = readJsonFile(file)
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data?.machines) ? data.machines : []
  const out = []
  for (const record of list) {
    if (record === null || typeof record !== 'object') continue
    const host = String(record.host == null ? '' : record.host).trim()
    if (!isDialableHost(host)) continue
    const username = String(record.username == null ? '' : record.username).trim()
    out.push({
      id: `saved:${String(record.id == null ? host : record.id)}`,
      kind: 'remote',
      source: 'dsh-remote',
      name: String(record.name == null ? '' : record.name).trim() || host,
      alias: String(record.name == null ? '' : record.name).trim() || host,
      host,
      port: Number(record.port) || 22,
      username,
      password: typeof record.password === 'string' ? record.password : '',
      privateKeyPath: String(record.privateKeyPath == null ? '' : record.privateKeyPath),
      passphrase: typeof record.passphrase === 'string' ? record.passphrase : '',
      useAgent: record.useAgent === true,
      useSshConfig: record.useSshConfig === true,
      backend: record.backend === 'openssh' ? 'openssh' : 'native',
      saved: true,
    })
  }
  return out
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
 * @returns {{targets: Array<object>, sources: {saved: number, sshConfig: number}}}
 */
export function loadTargets(config) {
  const machinesFile = config.machinesFile ? expandPath(config.machinesFile) : defaultMachinesFile()
  const sshConfigFile = config.sshConfigFile ? expandPath(config.sshConfigFile) : defaultSshConfigFile()

  const saved = config.includeSavedMachines === false ? [] : readSavedTargets(machinesFile)
  const fromConfig = config.includeSshConfig === false ? [] : readSshConfigTargets(sshConfigFile)
  const configByHost = new Map()
  for (const entry of fromConfig) configByHost.set(entry.host.toLowerCase(), entry)

  // Fill gaps in saved records from the user's ssh config (port/user/key).
  for (const entry of saved) {
    const hint = configByHost.get(entry.host.toLowerCase())
    if (hint === undefined) continue
    if (entry.username === '' && hint.username !== '') entry.username = hint.username
    if (!entry.port && hint.port) entry.port = hint.port
    if (entry.privateKeyPath === '' && hint.privateKeyPath !== '') entry.privateKeyPath = hint.privateKeyPath
  }

  const byKey = new Map()
  const rank = (entry) => {
    if (entry.saved === true && entry.password !== '') return 3
    if (entry.saved === true) return 2
    if (entry.privateKeyPath !== '') return 1
    return 0
  }
  const add = (entry) => {
    if (!isDialableHost(entry.host)) return
    if (entry.username === '') entry.username = localUsername()
    // Metrics describe a machine, not an account: three saved records for the
    // same host under root/deploy/ops must produce one card, not three.
    const key = `${String(entry.host).toLowerCase()}:${Number(entry.port) || 22}`
    const prev = byKey.get(key)
    if (prev === undefined) {
      byKey.set(key, entry)
      return
    }
    // Keep the record that can actually authenticate; merge missing credentials
    // from the loser so a key from ssh config still reaches the winner.
    const winner = rank(entry) > rank(prev) ? entry : prev
    const loser = winner === entry ? prev : entry
    if (winner.password === '' && loser.password !== '') winner.password = loser.password
    if (winner.privateKeyPath === '' && loser.privateKeyPath !== '') winner.privateKeyPath = loser.privateKeyPath
    if (winner.passphrase === '' && loser.passphrase !== '') winner.passphrase = loser.passphrase
    if (winner.username === '' && loser.username !== '') winner.username = loser.username
    if (winner.name === '' && loser.name !== '') winner.name = loser.name
    byKey.set(key, winner)
  }
  for (const entry of saved) add(entry)
  for (const entry of fromConfig) add(entry)

  const ignore = Array.isArray(config.ignoreHosts) ? config.ignoreHosts : []
  const targets = [...byKey.values()]
    .filter((entry) => !matchesAny(ignore, entry.host) && !matchesAny(ignore, entry.name))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))

  return {
    targets,
    sources: {
      saved: saved.length,
      sshConfig: fromConfig.length,
      savedFile: machinesFile,
      sshConfigFile,
    },
  }
}

/**
 * Merge manual targets over the discovered ones. A server the user explicitly
 * added from the dashboard wins over a stale dsh-remote / ssh-config record for
 * the same host and port, because it carries the credentials they just entered.
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
