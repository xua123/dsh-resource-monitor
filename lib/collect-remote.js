/**
 * Remote (Linux) metrics over SSH.
 *
 * One compact POSIX shell snippet emits labeled sections; parsing stays here so
 * the wire format is trivial to inspect when a host misbehaves. CPU usage is a
 * delta of two `/proc/stat` reads 250 ms apart, which avoids keeping state
 * between snapshots and works for any number of hosts independently.
 */
import { parseGpuCsv } from './gpu.js'
import { MonitorError, friendlyError } from './ssh.js'
import { percent, round1 } from './util.js'

const LABEL = '@@'

/**
 * The collector script. Deliberately POSIX-only, no sudo, no writes, and small
 * output: a dashboard refreshing every few seconds must not cost more than a
 * few milliseconds of the remote CPU.
 */
export const REMOTE_SCRIPT = [
  'export LC_ALL=C 2>/dev/null || true',
  `echo '${LABEL}HOST'; hostname 2>/dev/null`,
  `echo '${LABEL}OS'; if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; fi`,
  `echo '${LABEL}KERNEL'; uname -r 2>/dev/null`,
  `echo '${LABEL}UPTIME'; cut -d. -f1 /proc/uptime 2>/dev/null`,
  `echo '${LABEL}CPU1'; grep '^cpu ' /proc/stat 2>/dev/null`,
  'sleep 0.25',
  `echo '${LABEL}CPU2'; grep '^cpu ' /proc/stat 2>/dev/null`,
  `echo '${LABEL}MEM'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null`,
  `echo '${LABEL}LOAD'; cat /proc/loadavg 2>/dev/null`,
  `echo '${LABEL}NPROC'; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null`,
  `echo '${LABEL}DF'; (df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -P -k / 2>/dev/null) | tail -n +2`,
  `echo '${LABEL}GPU'; (nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap --format=csv,noheader,nounits 2>/dev/null || nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null) | head -8`,
  'true',
].join('\n')

/** Split labeled script output into a `{HOST: "...", CPU1: "..."}` record. */
export function parseSections(stdout) {
  const sections = {}
  let current = '__raw'
  for (const line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    if (line.startsWith(LABEL)) {
      current = line.slice(LABEL.length).trim()
      sections[current] = ''
      continue
    }
    if (!(current in sections)) sections[current] = ''
    sections[current] += line + '\n'
  }
  return sections
}

function parseCpuLine(line) {
  const text = String(line == null ? '' : line).trim()
  if (!text.startsWith('cpu')) return null
  const fields = text.split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10) || 0)
  if (fields.length < 4) return null
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  }
}

function parseCpu(first, second) {
  const a = parseCpuLine(first)
  const b = parseCpuLine(second)
  if (a === null || b === null) return { usage: null, cores: null, model: '' }
  const totalDelta = b.total - a.total
  const idleDelta = b.idle - a.idle
  const usage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : null
  return { usage: usage === null ? null : round1(usage), cores: null, model: '' }
}

function parseMeminfo(text) {
  const values = new Map()
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)/)
    if (match !== null) values.set(match[1], Number(match[2]) * 1024)
  }
  const total = values.get('MemTotal')
  if (!total) return { total: null, used: null, free: null, percent: null }
  const available = values.get('MemAvailable')
    ?? ((values.get('MemFree') || 0) + (values.get('Buffers') || 0) + (values.get('Cached') || 0))
  const used = Math.max(0, total - available)
  return { total, used, free: Math.max(0, available), percent: percent(used, total) }
}

function parseSwap(text) {
  const values = new Map()
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)/)
    if (match !== null) values.set(match[1], Number(match[2]) * 1024)
  }
  const total = values.get('SwapTotal')
  const free = values.get('SwapFree')
  if (!total || free === undefined || total <= 0) return null
  const used = Math.max(0, total - free)
  return { total, used, free, percent: percent(used, total) }
}

function parseMounts(text) {
  const seen = new Set()
  const mounts = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || /^Filesystem\s+/i.test(trimmed)) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 6) continue
    const totalKb = Number(parts[1])
    const usedKb = Number(parts[2])
    const availableKb = Number(parts[3])
    if (!Number.isFinite(totalKb) || totalKb <= 0) continue
    const mountPoint = parts.slice(5).join(' ')
    if (mountPoint === '' || seen.has(mountPoint)) continue
    // Only real, user-visible filesystems: skip udev shims and bind-mount noise.
    if (mountPoint.startsWith('/run/') || mountPoint === '/run') continue
    if (totalKb < 16 * 1024) continue
    seen.add(mountPoint)
    const total = totalKb * 1024
    const used = (Number.isFinite(usedKb) ? usedKb : Math.max(0, totalKb - availableKb)) * 1024
    mounts.push({ mount: mountPoint, total, used, percent: percent(used, total) })
  }
  mounts.sort((a, b) => (b.percent || 0) - (a.percent || 0))
  return mounts
}

function stripQuotes(value) {
  const text = String(value == null ? '' : value).trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

/**
 * Turn one script run into the same shape the local collector returns.
 *
 * @param {string} stdout
 * @param {number} latencyMs
 * @returns {object}
 */
export function parseRemoteSnapshot(stdout, latencyMs = 0) {
  const sections = parseSections(stdout)
  const host = (sections.HOST || '').trim()
  const cpu = parseCpu(sections.CPU1, sections.CPU2)
  const memory = parseMeminfo(sections.MEM)
  const swap = parseSwap(sections.MEM)
  const mounts = parseMounts(sections.DF)
  const loadLine = (sections.LOAD || '').trim().split(/\s+/)
  const load = loadLine.length >= 3 && loadLine.slice(0, 3).every((value) => Number.isFinite(Number(value)))
    ? loadLine.slice(0, 3).map((value) => round1(Number(value)))
    : null
  const processInfo = loadLine.length >= 4 && /^\d+\/\d+$/.test(loadLine[3])
    ? { running: Number(loadLine[3].split('/')[0]), total: Number(loadLine[3].split('/')[1]) }
    : null
  const cores = Number.parseInt((sections.NPROC || '').trim(), 10)
  const uptime = Number.parseInt((sections.UPTIME || '').trim(), 10)
  const kernel = (sections.KERNEL || '').trim()
  const osRelease = stripQuotes(sections.OS)

  if (host === '' && cpu.usage === null && memory.total === null) {
    throw new MonitorError('UNSUPPORTED', '该主机没有返回 Linux 指标（目前仅支持 Linux 远程主机）')
  }

  const root = mounts.find((mount) => mount.mount === '/')
  const primary = root || mounts.reduce((best, mount) => (
    best === undefined || mount.total > best.total ? mount : best
  ), undefined)
  const peak = mounts[0]
  const gpus = parseGpuCsv(sections.GPU)

  return {
    hostname: host || '',
    osName: osRelease || (kernel === '' ? 'Linux' : `Linux ${kernel}`),
    kernel,
    arch: '',
    platform: 'linux',
    cpu: { ...cpu, cores: Number.isFinite(cores) && cores > 0 ? cores : null },
    memory,
    swap,
    gpus,
    disk: {
      percent: peak === undefined ? null : peak.percent,
      mount: peak === undefined ? '' : peak.mount,
      used: peak === undefined ? null : peak.used,
      total: peak === undefined ? null : peak.total,
      root: primary === undefined ? null : { mount: primary.mount, percent: primary.percent, used: primary.used, total: primary.total },
      mounts: mounts.slice(0, 8),
    },
    load,
    processes: processInfo,
    uptime: Number.isFinite(uptime) ? uptime : null,
    latencyMs,
    sampledAt: Date.now(),
  }
}

/**
 * Collect one remote host. Throws a MonitorError when the host is unreachable
 * or unrecognized so the snapshot can carry a readable per-card reason.
 *
 * @param {{exec: Function}} pool
 * @param {object} target
 * @param {{timeoutMs?: number}} [options]
 */
export async function collectRemote(pool, target, options = {}) {
  let result
  try {
    result = await pool.exec(target, REMOTE_SCRIPT, { timeoutMs: options.timeoutMs })
  } catch (error) {
    throw error instanceof MonitorError ? error : new MonitorError('INTERNAL', friendlyError(error), { cause: error })
  }
  if (result.code !== 0 && result.stdout.trim() === '') {
    const detail = result.stderr.trim().split(/\r?\n/)[0] || `退出码 ${result.code}`
    throw new MonitorError('INTERNAL', `远程命令失败：${detail}`)
  }
  return parseRemoteSnapshot(result.stdout, result.ms)
}
