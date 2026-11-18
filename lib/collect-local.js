/**
 * Local host metrics.
 *
 * Node gives us CPU, memory and uptime directly. Disks are read with
 * `fs.statfsSync`, which works on every platform Node supports (including
 * Windows drive letters), so no PowerShell/CIM round-trip is needed for the
 * normal refresh path. Volume enumeration is cached because probing a dead
 * mapped drive is the one call that can be slow.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { percent, round1, sleep } from './util.js'

const diskCache = { at: 0, mounts: [], platform: process.platform }

function cpuSnapshot() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { at: Date.now(), idle, total, cores: cpus.length, model: (cpus[0] && cpus[0].model) || '' }
}

let lastCpu = null

async function sampleCpu() {
  const first = cpuSnapshot()
  let previous = lastCpu
  if (previous === null || first.at - previous.at < 350) {
    // First call (or two requests in quick succession): take a short second
    // sample so a percentage exists without waiting for the next refresh.
    const wait = previous === null ? 180 : Math.max(60, 350 - (first.at - previous.at))
    await sleep(wait)
    const second = cpuSnapshot()
    previous = previous === null ? first : previous
    lastCpu = second
    return finishCpu(previous, second)
  }
  lastCpu = first
  return finishCpu(previous, first)
}

function finishCpu(previous, current) {
  const totalDelta = current.total - previous.total
  const idleDelta = current.idle - previous.idle
  const usage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : null
  return {
    usage: usage === null ? null : round1(usage),
    cores: current.cores,
    model: current.model,
  }
}

function statfsMount(mount) {
  try {
    const stats = fs.statfsSync(mount)
    const total = Number(stats.blocks) * Number(stats.bsize)
    if (!Number.isFinite(total) || total <= 0) return null
    const available = Number(stats.bavail) * Number(stats.bsize)
    const used = Math.max(0, total - available)
    return {
      mount,
      total,
      used,
      free: Math.max(0, available),
      percent: percent(used, total),
    }
  } catch {
    return null
  }
}

function windowsMounts() {
  const mounts = []
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const mount = `${letter}:`
    const info = statfsMount(`${mount}\\`)
    if (info !== null) {
      info.mount = mount
      mounts.push(info)
    }
  }
  return mounts
}

function posixMounts() {
  const seen = new Set()
  const mounts = []
  let table = ''
  try {
    table = fs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    table = ''
  }
  const pseudo = new Set([
    'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'overlay',
    'squashfs', 'ramfs', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf',
    'autofs', 'mqueue', 'hugetlbfs', 'fusectl', 'configfs', 'efivarfs', 'nsfs',
  ])
  for (const line of table.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [, mountPoint, fsType] = parts
    if (mountPoint.startsWith('/proc') || mountPoint.startsWith('/sys') || mountPoint.startsWith('/dev')) continue
    if (pseudo.has(fsType)) continue
    if (seen.has(mountPoint)) continue
    seen.add(mountPoint)
    const info = statfsMount(mountPoint)
    if (info !== null) mounts.push(info)
  }
  if (mounts.length === 0) {
    const root = statfsMount('/')
    if (root !== null) mounts.push(root)
  }
  return mounts
}

function readMounts() {
  const now = Date.now()
  if (diskCache.at !== 0 && now - diskCache.at < 30000) return diskCache.mounts
  const mounts = (process.platform === 'win32' ? windowsMounts() : posixMounts())
    .filter((mount) => mount.percent !== null)
    .sort((a, b) => b.percent - a.percent)
  diskCache.at = now
  diskCache.mounts = mounts
  return mounts
}

function memoryInfo() {
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  return { total, used, free, percent: percent(used, total) }
}

function swapInfo() {
  if (process.platform === 'win32') return null
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const read = (name) => {
      const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'))
      return match === null ? null : Number(match[1]) * 1024
    }
    const total = read('SwapTotal')
    const free = read('SwapFree')
    if (total === null || free === null || total <= 0) return null
    const used = Math.max(0, total - free)
    return { total, used, free, percent: percent(used, total) }
  } catch {
    return null
  }
}

function osName() {
  try {
    if (process.platform === 'win32') return os.version() || 'Windows'
    if (process.platform === 'darwin') return `macOS ${os.release()}`
    const pretty = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)
    if (pretty !== null) return pretty[1]
  } catch {
    /* fall through */
  }
  return `${os.type()} ${os.release()}`.trim()
}

function systemMountName(mounts) {
  if (process.platform === 'win32') {
    const systemDrive = String(process.env.SystemDrive || 'C:').replace(/\\$/, '')
    return mounts.find((mount) => mount.mount === systemDrive) || mounts[0]
  }
  return mounts.find((mount) => mount.mount === '/') || mounts[0]
}

/**
 * @returns {Promise<object>} a sanitized snapshot for the local machine
 */
export async function collectLocal() {
  const cpu = await sampleCpu()
  const mounts = readMounts()
  const primary = systemMountName(mounts)
  const peak = mounts.reduce((worst, mount) => (
    worst === undefined || mount.percent > worst.percent ? mount : worst
  ), undefined)

  return {
    hostname: os.hostname(),
    osName: osName(),
    kernel: os.release(),
    arch: os.arch(),
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    cpu,
    memory: memoryInfo(),
    swap: swapInfo(),
    disk: {
      percent: peak === undefined ? null : peak.percent,
      mount: peak === undefined ? '' : peak.mount,
      used: peak === undefined ? null : peak.used,
      total: peak === undefined ? null : peak.total,
      root: primary === undefined
        ? null
        : { mount: primary.mount, percent: primary.percent, used: primary.used, total: primary.total },
      mounts: mounts.slice(0, 8).map(({ mount, percent: p, used, total }) => ({ mount, percent: p, used, total })),
    },
    load: process.platform === 'win32' ? null : os.loadavg().map((value) => round1(value)),
    uptime: Math.round(os.uptime()),
    latencyMs: 0,
    sampledAt: Date.now(),
  }
}

/** Exposed for the standalone test server. */
export const __test = { statfsMount, readMounts, path }
