/**
 * Remote (Linux) metrics over SSH.
 *
 * One compact POSIX shell snippet emits labeled sections; parsing stays here so
 * the wire format is trivial to inspect when a host misbehaves. CPU usage is a
 * delta of two `/proc/stat` reads 250 ms apart, which avoids keeping state
 * between snapshots and works for any number of hosts independently.
 */
import path from 'node:path'
import { parseDockerSection } from './docker.js'
import { parseDcuPids, parseDcuSmi, parseGpuCsv, parseNpuSmi, parseNvidiaApps } from './gpu.js'
import { parsePsOutput } from './processes.js'
import { MonitorError, friendlyError } from './ssh.js'
import { percent, round1 } from './util.js'

const LABEL = '@@'

const PATH_PREFIX = 'export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/Ascend/driver/tools:/usr/local/Ascend/ascend-toolkit/latest/bin:/opt/hyhal/bin:/opt/rocm/bin"'

/**
 * The collector script. Deliberately POSIX-only, no sudo, no writes, and small
 * output: a dashboard refreshing every few seconds must not cost more than a
 * few milliseconds of the remote CPU.
 */
export const REMOTE_SCRIPT = [
  'export LC_ALL=C 2>/dev/null || true',
  PATH_PREFIX,
  `echo '${LABEL}HOST'; hostname 2>/dev/null`,
  `echo '${LABEL}OS'; if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; fi`,
  `echo '${LABEL}KERNEL'; uname -r 2>/dev/null`,
  `echo '${LABEL}UPTIME'; cut -d. -f1 /proc/uptime 2>/dev/null`,
  `echo '${LABEL}CPU1'; grep '^cpu ' /proc/stat 2>/dev/null`,
  '(sleep 0.5 2>/dev/null || sleep 1 2>/dev/null)',
  `echo '${LABEL}CPU2'; grep '^cpu ' /proc/stat 2>/dev/null`,
  `echo '${LABEL}MEM'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null`,
  `echo '${LABEL}LOAD'; cat /proc/loadavg 2>/dev/null`,
  `echo '${LABEL}NPROC'; nproc --all 2>/dev/null || nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null`,
  `echo '${LABEL}CPU_MODEL'; grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-`,
  `echo '${LABEL}NET'; cat /proc/net/dev 2>/dev/null`,
  `echo '${LABEL}CONTAINER'; if [ -f /.dockerenv ] || grep -qaE 'docker|kubepods|containerd|lxc' /proc/1/cgroup 2>/dev/null; then echo 'yes'; else echo 'no'; fi; cat /sys/fs/cgroup/cpu.max 2>/dev/null || true; cat /sys/fs/cgroup/memory.max 2>/dev/null || true; cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || true; cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || true; cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true`,
  `echo '${LABEL}DF'; (df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -P -k / 2>/dev/null) | tail -n +2`,
  `echo '${LABEL}GPU'; if command -v nvidia-smi >/dev/null 2>&1; then (nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap,temperature.gpu,power.draw,power.limit,uuid --format=csv,noheader,nounits 2>/dev/null || nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null) | head -16; fi`,
  `echo '${LABEL}NPU'; if command -v npu-smi >/dev/null 2>&1; then npu-smi info 2>/dev/null; fi`,
  `echo '${LABEL}DCU'; if command -v hy-smi >/dev/null 2>&1; then hy-smi --showuse --showmeminfo vram --showtemp --showpower --showproductname --json 2>/dev/null || (hy-smi 2>/dev/null; hy-smi --showproductname 2>/dev/null); elif command -v rocm-smi >/dev/null 2>&1; then rocm-smi --showuse --showmeminfo vram --showtemp --showpower --showproductname --json 2>/dev/null || (rocm-smi 2>/dev/null; rocm-smi --showproductname 2>/dev/null); fi`,
  'true',
].join('\n')

/**
 * On-demand script for the node detail drawer: top processes and
 * GPU / NPU / DCU memory-consuming processes.
 */
export const REMOTE_DETAILS_SCRIPT = [
  'export LC_ALL=C 2>/dev/null || true',
  PATH_PREFIX,
  `echo '${LABEL}PS'; ps -eo pid=,user:24=,pcpu=,pmem=,rss=,stat=,comm= --sort=-pcpu 2>/dev/null | head -n 60`,
  `echo '${LABEL}GPU'; if command -v nvidia-smi >/dev/null 2>&1; then (nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap,temperature.gpu,power.draw,power.limit,uuid --format=csv,noheader,nounits 2>/dev/null || nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null) | head -16; fi`,
  `echo '${LABEL}GPU_PROC'; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null; fi`,
  `echo '${LABEL}NPU'; if command -v npu-smi >/dev/null 2>&1; then npu-smi info 2>/dev/null; fi`,
  `echo '${LABEL}DCU_KIND'; if command -v hy-smi >/dev/null 2>&1; then echo hy; elif command -v rocm-smi >/dev/null 2>&1; then echo rocm; fi`,
  `echo '${LABEL}DCU'; if command -v hy-smi >/dev/null 2>&1; then hy-smi --showuse --showmeminfo vram --showtemp --showpower --showproductname --json 2>/dev/null || (hy-smi 2>/dev/null; hy-smi --showproductname 2>/dev/null); elif command -v rocm-smi >/dev/null 2>&1; then rocm-smi --showuse --showmeminfo vram --showtemp --showpower --showproductname --json 2>/dev/null || (rocm-smi 2>/dev/null; rocm-smi --showproductname 2>/dev/null); fi`,
  `echo '${LABEL}DCU_PROC'; if command -v hy-smi >/dev/null 2>&1; then hy-smi --showpids 2>/dev/null; elif command -v rocm-smi >/dev/null 2>&1; then rocm-smi --showpids 2>/dev/null; fi`,
  `echo '${LABEL}DOCKER'; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo OK; docker images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}' 2>/dev/null | head -n 80; echo '::IMAGES_END'; docker ps --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -n 80; echo '::RUNNING_END'; docker ps -a --filter status=exited --filter status=created --filter status=dead --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -n 80; fi`,
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
    ?? ((values.get('MemFree') || 0) + (values.get('Buffers') || 0) + (values.get('Cached') || 0) + (values.get('SReclaimable') || 0))
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

/** Parse `/proc/net/dev` summing non-loopback interface RX/TX bytes. */
export function parseNetDev(text) {
  let rxBytes = 0
  let txBytes = 0
  let found = false
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const colon = rawLine.indexOf(':')
    if (colon < 0) continue
    const iface = rawLine.slice(0, colon).trim()
    if (iface === '' || iface === 'lo' || /^(?:veth|docker|br-|virbr)/.test(iface)) continue
    const fields = rawLine.slice(colon + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    const rx = Number(fields[0])
    const tx = Number(fields[8])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    rxBytes += rx
    txBytes += tx
    found = true
  }
  return found ? { rxBytes, txBytes, rxBps: null, txBps: null } : null
}

/** Parse container flag and optional cgroup v1/v2 CPU & memory limits. */
export function parseContainerInfo(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0 || lines[0] !== 'yes') return null
  let cpuLimit = null
  let memLimitBytes = null
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    // cgroup v2 cpu.max: "200000 100000" or "max 100000"
    const cpuMax = line.match(/^(\d+)\s+(\d+)$/)
    if (cpuMax !== null && Number(cpuMax[2]) > 0) {
      cpuLimit = round1(Number(cpuMax[1]) / Number(cpuMax[2]))
      continue
    }
    // cgroup v1 cfs_quota_us + cfs_period_us on adjacent lines
    if (/^-?\d+$/.test(line)) {
      const val = Number(line)
      if (val > 0 && val < 1e15 && lines[i + 1] && /^\d+$/.test(lines[i + 1])) {
        const nextVal = Number(lines[i + 1])
        if (nextVal > 0 && nextVal <= 1000000 && val >= 1000) {
          cpuLimit = round1(val / nextVal)
          i += 1
          continue
        }
      }
      if (val > 1024 * 1024 && val < 1e15) {
        memLimitBytes = val
      }
    }
  }
  return { isContainer: true, cpuLimit, memLimitBytes }
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
  const cores = Number.parseInt((sections.NPROC || '').trim().split(/\s+/)[0], 10)
  const cpuModel = (sections.CPU_MODEL || '').trim()
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
  const nvGpus = parseGpuCsv(sections.GPU)
  const npuResult = parseNpuSmi(sections.NPU)
  const dcuType = /dcu|hygon|k100|z100/i.test(sections.DCU || '') ? 'dcu' : 'gpu'
  const dcuCards = parseDcuSmi(sections.DCU, dcuType)
  const gpus = [...nvGpus, ...npuResult.cards, ...dcuCards]

  return {
    hostname: host || '',
    osName: osRelease || (kernel === '' ? 'Linux' : `Linux ${kernel}`),
    kernel,
    arch: '',
    platform: 'linux',
    cpu: { ...cpu, cores: Number.isFinite(cores) && cores > 0 ? cores : null, model: cpuModel || cpu.model },
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
    network: parseNetDev(sections.NET),
    container: parseContainerInfo(sections.CONTAINER),
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

/**
 * Build the tiny PID → service lookup command used after accelerator parsing.
 * Only numeric PIDs are interpolated, so this cannot inject shell syntax.
 */
function buildProcInfoCommand(pids) {
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(' ')
  return [
    'export LC_ALL=C 2>/dev/null || true',
    `for pid in ${safe}; do`,
    '  echo "@@PID $pid"',
    '  unit=""',
    '  if [ -r "/proc/$pid/cgroup" ]; then unit=$(sed -n "s#.*/\\([^/]*\\.service\\)$#\\1#p" "/proc/$pid/cgroup" | tail -n 1); fi',
    '  echo "unit=$unit"',
    '  comm=""',
    '  if [ -r "/proc/$pid/comm" ]; then comm=$(cat "/proc/$pid/comm" 2>/dev/null); fi',
    '  echo "comm=$comm"',
    '  args=""',
    '  if [ -r "/proc/$pid/cmdline" ]; then args=$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-240); fi',
    '  echo "args=$args"',
    'done',
  ].join('\n')
}

/** Parse `@@PID` blocks from `buildProcInfoCommand`. */
export function parseProcInfo(stdout) {
  const map = new Map()
  let current = null
  for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const pidMatch = rawLine.match(/^@@PID\s+(\d+)\s*$/)
    if (pidMatch !== null) {
      current = { pid: Number(pidMatch[1]), unit: '', comm: '', args: '' }
      map.set(current.pid, current)
      continue
    }
    if (current === null) continue
    const field = rawLine.match(/^(unit|comm|args)=(.*)$/)
    if (field !== null) current[field[1]] = field[2]
  }
  return map
}

/** Prefer a systemd service name; fall back to a friendly executable name. */
export function friendlyProcName(info, pid) {
  if (info === null || info === undefined) return ''
  const unit = String(info.unit || '').replace(/\.service$/, '').trim()
  if (unit !== '' && !/^(docker-|kubepods|user@|session-|init\.scope$)/i.test(unit)) return unit
  const comm = String(info.comm || '').trim()
  const args = String(info.args || '').trim()
  if (/^python/.test(comm) || comm === 'node') {
    const tokens = args.split(/\s+/).filter(Boolean)
    const script = tokens.find((token) => /\.(py|js|mjs)$/.test(token))
    if (script !== undefined) return path.basename(script)
    const moduleName = tokens.find((token) => /^(vllm|uvicorn|gunicorn|torchrun|deepspeed|accelerate|llama)/i.test(token))
    if (moduleName !== undefined) return moduleName.split('.')[0]
  }
  if (comm !== '') return comm
  return `PID ${pid}`
}

function enrichAcceleratorProcesses(processes, infoMap) {
  for (const process of processes) {
    const info = infoMap.get(Number(process.pid))
    if (info === undefined) continue
    const name = friendlyProcName(info, process.pid)
    if (name !== '') process.name = name
    process.serviceName = name
    process.unit = info.unit || ''
  }
}

/** Parse `REMOTE_DETAILS_SCRIPT` stdout into top processes + accelerator processes. */
export function parseRemoteDetails(stdout) {
  const sections = parseSections(stdout)
  const processes = parsePsOutput(sections.PS)
  const nvCards = parseGpuCsv(sections.GPU)
  const nvProcs = parseNvidiaApps(sections.GPU_PROC, nvCards)
  const npu = parseNpuSmi(sections.NPU)
  const dcuKind = (sections.DCU_KIND || '').trim() === 'hy' ? 'dcu' : 'gpu'
  const dcuCards = parseDcuSmi(sections.DCU, dcuKind)
  const dcuProcs = parseDcuPids(sections.DCU_PROC, dcuCards, dcuKind)
  return {
    processes,
    accelerators: [...nvCards, ...npu.cards, ...dcuCards],
    acceleratorProcesses: [...nvProcs, ...npu.processes, ...dcuProcs],
    docker: parseDockerSection(sections.DOCKER),
    sampledAt: Date.now(),
  }
}

/**
 * Collect on-demand detailed processes & accelerator memory processes for one remote host.
 *
 * @param {{exec: Function}} pool
 * @param {object} target
 * @param {{timeoutMs?: number}} [options]
 */
export async function collectRemoteDetails(pool, target, options = {}) {
  let result
  try {
    result = await pool.exec(target, REMOTE_DETAILS_SCRIPT, { timeoutMs: options.timeoutMs })
  } catch (error) {
    throw error instanceof MonitorError ? error : new MonitorError('INTERNAL', friendlyError(error), { cause: error })
  }
  if (result.code !== 0 && result.stdout.trim() === '') {
    const detail = result.stderr.trim().split(/\r?\n/)[0] || `退出码 ${result.code}`
    throw new MonitorError('INTERNAL', `远程进程采集失败：${detail}`)
  }
  const parsed = parseRemoteDetails(result.stdout)
  const pids = [...new Set(parsed.acceleratorProcesses
    .map((process) => Number(process.pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0))]
  if (pids.length > 0) {
    try {
      const infoResult = await pool.exec(target, buildProcInfoCommand(pids), {
        timeoutMs: Math.min(options.timeoutMs || 12000, 8000),
      })
      if (infoResult.code === 0 || infoResult.stdout.trim() !== '') {
        enrichAcceleratorProcesses(parsed.acceleratorProcesses, parseProcInfo(infoResult.stdout))
      }
    } catch {
      /* service-name enrichment is best effort; keep the accelerator table usable */
    }
  }
  return parsed
}
