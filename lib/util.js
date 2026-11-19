/**
 * Small shared helpers for dsh-server-overseer.
 *
 * Everything here is pure data plumbing: path normalization, tolerant JSON
 * reads, percentage math and the one place that knows where DSH keeps its home
 * directory. No SSH, no HTTP, so the collectors and the route layer can both
 * import it without pulling the other half in.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Absolute DSH home. The desktop host exports DSH_HOME; fall back to ~/.dsh. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** Expand a leading `~` and resolve relative paths against `base`. */
export function expandPath(value, base = process.cwd()) {
  const raw = String(value == null ? '' : value).trim()
  if (raw === '') return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return path.isAbsolute(raw) ? raw : path.resolve(base, raw)
}

/** Read a JSON file, returning `undefined` for anything unreadable. */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically (best effort). Returns true when the bytes landed. */
export function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** Used/total as a 0..100 number with one decimal, or null when unknown. */
export function percent(used, total) {
  const u = Number(used)
  const t = Number(total)
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return null
  return Math.round(Math.min(100, Math.max(0, (u / t) * 100)) * 10) / 10
}

/** Round to one decimal without dragging -0 along. */
export function round1(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const r = Math.round(n * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** True for a hostname / IPv4 / IPv6 literal we are willing to dial. */
export function isDialableHost(host) {
  const h = String(host == null ? '' : host).trim()
  if (h === '' || h.length > 255) return false
  if (/\s/.test(h)) return false
  // Saved-machine records occasionally contain a display name in `host`
  // (e.g. "192.0.2.10（deploy）"). Dialing those can never work.
  return /^[A-Za-z0-9._:[\]-]+$/.test(h)
}

/** Stable, human-readable id for a target. */
export function targetKey(target) {
  return `${String(target.host || '').toLowerCase()}:${Number(target.port) || 22}:${String(target.username || '')}`
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

/** A tiny concurrency limiter: at most `limit` promises in flight. */
export function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1)
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max) return
    const job = queue.shift()
    if (job === undefined) return
    active += 1
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1
        next()
      })
  }
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    next()
  })
}
