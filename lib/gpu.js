/**
 * Heterogeneous accelerator inspection (NVIDIA GPU, Huawei Ascend NPU, Hygon DCU / AMD GPU).
 *
 * All parsers are pure and tolerant of missing fields, older driver formats, or
 * absent hardware so a single host without accelerators—or with mixed tools—never
 * breaks snapshot collection.
 */
import { execFile } from 'node:child_process'
import { percent, round1 } from './util.js'

/** Query used by both the local collector and the remote shell snippet. */
export const GPU_QUERY = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap,temperature.gpu,power.draw,uuid',
  '--format=csv,noheader,nounits',
]

/** Fallback for older drivers that do not expose temperature/power/uuid/compute_cap. */
export const GPU_QUERY_NO_CC = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits',
]

/** NVIDIA compute-app query for VRAM process usage. */
export const GPU_APPS_QUERY = [
  '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
  '--format=csv,noheader,nounits',
]

const MAX_CARDS = 16
const MAX_PROCS = 100

/** Split one nvidia-smi CSV line, honoring double-quoted fields. */
function splitCsv(line) {
  const fields = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        value += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        value += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      fields.push(value.trim())
      value = ''
      continue
    }
    value += ch
  }
  fields.push(value.trim())
  return fields
}

function numberOrNull(text) {
  const value = String(text == null ? '' : text).trim()
  if (value === '' || /^(?:n\/a|na|-|--|\[(?:n\/a|not supported|unknown)\])$/i.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Compute-capability fallback for drivers whose `nvidia-smi` does not expose
 * `compute_cap` (common on older Tesla drivers). Values are the published CUDA
 * capabilities of these families.
 */
const COMPUTE_CAP_BY_NAME = [
  [/H200/i, '9.0'],
  [/H100/i, '9.0'],
  [/L40/i, '8.9'],
  [/\bL4\b/i, '8.9'],
  [/RTX\s*40\d0/i, '8.9'],
  [/\bA40\b/i, '8.6'],
  [/\bA10G?\b/i, '8.6'],
  [/RTX\s*30\d0/i, '8.6'],
  [/\bA100\b/i, '8.0'],
  [/\bA30\b/i, '8.0'],
  [/\bA800\b/i, '8.0'],
  [/RTX\s*20\d0/i, '7.5'],
  [/\bT4\b/i, '7.5'],
  [/\bV100\b/i, '7.0'],
  [/\bTitan\s*V\b/i, '7.0'],
  [/\bP100\b/i, '6.0'],
  [/\bP40\b/i, '6.1'],
  [/\bP4\b/i, '6.1'],
  [/GTX\s*1080/i, '6.1'],
  [/GTX\s*1070/i, '6.1'],
  [/GTX\s*1060/i, '6.1'],
  [/\bTitan\s*Xp\b/i, '6.1'],
]

/** Best-effort CUDA compute capability from a marketing name. */
export function inferComputeCap(name) {
  const text = String(name == null ? '' : name)
  for (const [pattern, value] of COMPUTE_CAP_BY_NAME) {
    if (pattern.test(text)) return value
  }
  return ''
}

function makeCard({
  type,
  vendor,
  index,
  uuid = '',
  name,
  utilization = null,
  memoryUsed = null,
  memoryTotal = null,
  temperature = null,
  powerW = null,
  computeCap = '',
  memoryLabel = '显存',
}) {
  return {
    type,
    vendor,
    index,
    uuid,
    name: String(name || '').trim().slice(0, 120),
    utilization: utilization === null ? null : round1(utilization),
    memoryUsed,
    memoryTotal,
    memoryPercent: percent(memoryUsed, memoryTotal),
    memoryLabel,
    temperature: temperature === null ? null : round1(temperature),
    powerW: powerW === null ? null : round1(powerW),
    computeCap,
  }
}

/**
 * Parse `nvidia-smi --query-gpu=...` output.
 *
 * @param {string} stdout
 * @returns {Array<object>} one entry per NVIDIA GPU
 */
export function parseGpuCsv(stdout) {
  const gpus = []
  for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^index\b/i.test(line) || /^no devices/i.test(line)) continue
    const fields = splitCsv(line)
    if (fields.length < 5) continue
    const index = numberOrNull(fields[0])
    const name = String(fields[1] || '').trim().slice(0, 120)
    if (name === '') continue
    const utilization = numberOrNull(fields[2])
    const memoryUsed = numberOrNull(fields[3])
    const memoryTotal = numberOrNull(fields[4])
    const computeCapRaw = fields.length >= 6 ? String(fields[5] || '').trim() : ''
    const computeCap = computeCapRaw === '' || /\[(?:n\/a|not supported)\]/i.test(computeCapRaw)
      ? inferComputeCap(name)
      : computeCapRaw
    const temperature = fields.length >= 7 ? numberOrNull(fields[6]) : null
    const powerW = fields.length >= 8 ? numberOrNull(fields[7]) : null
    const uuid = fields.length >= 9 ? String(fields[8] || '').trim() : ''
    const usedBytes = memoryUsed === null ? null : memoryUsed * 1024 * 1024
    const totalBytes = memoryTotal === null ? null : memoryTotal * 1024 * 1024
    gpus.push(makeCard({
      type: 'gpu',
      vendor: 'NVIDIA',
      index: index === null ? gpus.length : index,
      uuid,
      name,
      utilization,
      memoryUsed: usedBytes,
      memoryTotal: totalBytes,
      temperature,
      powerW,
      computeCap,
      memoryLabel: '显存',
    }))
    if (gpus.length >= MAX_CARDS) break
  }
  return gpus
}

/**
 * Parse `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory`.
 *
 * @param {string} stdout
 * @param {Array<object>} [cards]
 * @returns {Array<object>}
 */
export function parseNvidiaApps(stdout, cards = []) {
  const uuidToCard = new Map()
  for (const card of cards) {
    if (card.uuid) uuidToCard.set(card.uuid, card)
  }
  const procs = []
  for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^gpu_uuid\b/i.test(line) || /^no running/i.test(line)) continue
    const fields = splitCsv(line)
    if (fields.length < 4) continue
    const gpuUuid = String(fields[0] || '').trim()
    const pid = numberOrNull(fields[1])
    const name = String(fields[2] || '').trim()
    const usedMb = numberOrNull(fields[3])
    if (pid === null || name === '') continue
    const card = uuidToCard.get(gpuUuid)
    const memoryUsed = usedMb === null ? null : usedMb * 1024 * 1024
    const memoryTotal = card ? card.memoryTotal : null
    procs.push({
      type: 'gpu',
      vendor: 'NVIDIA',
      deviceIndex: card ? card.index : null,
      deviceName: card ? card.name : '',
      pid,
      name,
      memoryUsed,
      memoryPercent: percent(memoryUsed, memoryTotal),
    })
    if (procs.length >= MAX_PROCS) break
  }
  return procs
}

/**
 * Parse `npu-smi info` output for Huawei Ascend NPUs (both device cards and
 * bottom process list).
 *
 * @param {string} stdout
 * @returns {{ cards: Array<object>, processes: Array<object> }}
 */
export function parseNpuSmi(stdout) {
  const text = String(stdout == null ? '' : stdout)
  const cards = []
  const processes = []
  if (text.trim() === '') return { cards, processes }

  const lines = text.split(/\r?\n/)
  let inProcessSection = false
  let pendingCard = null

  const flushPending = () => {
    if (pendingCard !== null) {
      cards.push(pendingCard)
      pendingCard = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || /^[+=\-|]+$/.test(line)) continue

    if (/Process id/i.test(line) && /Process name/i.test(line)) {
      flushPending()
      inProcessSection = true
      continue
    }

    if (inProcessSection) {
      if (/No running processes/i.test(line)) continue
      const cols = line.split('|').map((c) => c.trim()).filter(Boolean)
      if (cols.length < 3) continue
      const npuChipMatch = cols[0].match(/^(\d+)\s+(\d+)/)
      const pid = numberOrNull(cols[1])
      if (npuChipMatch === null || pid === null) continue
      const deviceIndex = Number(npuChipMatch[1])
      const procName = cols[2] || ''
      const memCol = cols[cols.length - 1] || ''
      const memVal = numberOrNull(memCol)
      const memoryUsed = memVal === null ? null : memVal * 1024 * 1024
      const card = cards.find((c) => c.index === deviceIndex)
      processes.push({
        type: 'npu',
        vendor: 'Huawei Ascend',
        deviceIndex,
        deviceName: card ? card.name : `NPU ${deviceIndex}`,
        pid,
        name: procName,
        memoryUsed,
        memoryPercent: percent(memoryUsed, card ? card.memoryTotal : null),
      })
      if (processes.length >= MAX_PROCS) break
      continue
    }

    if (!line.startsWith('|')) continue
    const cols = line.split('|').map((c) => c.trim()).filter(Boolean)
    if (cols.length < 3) continue

    // First line of an NPU row: "| 0   910B2 | OK | 25.4  45 | 0000:C1:00.0 | ..."
    const idNameMatch = cols[0].match(/^(\d+)\s+(.+)$/)
    if (idNameMatch !== null && !/NPU\s+Name/i.test(cols[0])) {
      flushPending()
      const index = Number(idNameMatch[1])
      const rawName = idNameMatch[2].trim()
      const name = /^Ascend/i.test(rawName) ? rawName : `Ascend ${rawName}`
      let powerW = null
      let temperature = null
      for (const col of cols.slice(1)) {
        const pt = col.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\b/)
        if (pt !== null) {
          powerW = Number(pt[1])
          temperature = Number(pt[2])
          break
        }
      }
      pendingCard = {
        index,
        name,
        powerW,
        temperature,
        utilization: null,
        memoryUsed: null,
        memoryTotal: null,
      }
      continue
    }

    // Second line of an NPU row: "| 0 | 0000:C1:00.0 | 85   2400 / 15000   32768 / 65536 |"
    if (pendingCard !== null && /^\d+$/.test(cols[0])) {
      const restCols = cols.slice(2).join(' ')
      const aicoreMatch = restCols.match(/^\s*(\d+(?:\.\d+)?)/)
      const aicore = aicoreMatch === null ? null : Number(aicoreMatch[1])
      let memUsedMb = null
      let memTotalMb = null
      // Prefer the last "used / total" pair (HBM-Usage on 910B, Memory-Usage on 310/310P)
      for (const memMatch of restCols.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)) {
        memUsedMb = Number(memMatch[1])
        memTotalMb = Number(memMatch[2])
      }
      pendingCard.utilization = aicore
      pendingCard.memoryUsed = memUsedMb === null ? null : memUsedMb * 1024 * 1024
      pendingCard.memoryTotal = memTotalMb === null ? null : memTotalMb * 1024 * 1024
      cards.push(makeCard({
        type: 'npu',
        vendor: 'Huawei Ascend',
        index: pendingCard.index,
        name: pendingCard.name,
        utilization: pendingCard.utilization,
        memoryUsed: pendingCard.memoryUsed,
        memoryTotal: pendingCard.memoryTotal,
        temperature: pendingCard.temperature,
        powerW: pendingCard.powerW,
        memoryLabel: 'HBM',
      }))
      pendingCard = null
      if (cards.length >= MAX_CARDS) break
    }
  }
  flushPending()
  return { cards, processes }
}

/**
 * Parse Hygon DCU (`hy-smi`) or AMD GPU (`rocm-smi`) output.
 * Supports JSON output (`--json`) as well as standard table text output.
 *
 * @param {string} stdout
 * @param {'dcu'|'gpu'} [defaultType='dcu']
 * @returns {Array<object>}
 */
export function parseDcuSmi(stdout, defaultType = 'dcu') {
  const text = String(stdout == null ? '' : stdout).trim()
  if (text === '') return []

  // Try JSON format first (`hy-smi ... --json` or `rocm-smi ... --json`)
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text)
      const cards = []
      for (const [key, info] of Object.entries(json)) {
        if (!info || typeof info !== 'object') continue
        const idxMatch = key.match(/(\d+)$/)
        const index = idxMatch ? Number(idxMatch[1]) : cards.length
        const isDcu = defaultType === 'dcu' || /dcu/i.test(key) || /hygon|haiguang|k100|z100/i.test(JSON.stringify(info))
        const name = info['Card series'] || info['Card Series'] || info['Device Name'] || info['Product Name'] || (isDcu ? `Hygon DCU ${index}` : `AMD GPU ${index}`)
        const util = numberOrNull(info['DCU use (%)'] ?? info['GPU use (%)'] ?? info['GFX Activity'] ?? info['Utilization (%)'])
        const vramTotal = numberOrNull(info['VRAM Total Memory (B)'])
          ?? (numberOrNull(info['VRAM Total Memory (MB)']) !== null ? numberOrNull(info['VRAM Total Memory (MB)']) * 1024 * 1024 : null)
        const vramUsed = numberOrNull(info['VRAM Total Used Memory (B)'])
          ?? (numberOrNull(info['VRAM Total Used Memory (MB)']) !== null ? numberOrNull(info['VRAM Total Used Memory (MB)']) * 1024 * 1024 : null)
        const temp = numberOrNull(info['Temperature (Sensor edge) (C)'] ?? info['Temperature (Sensor junction) (C)'] ?? info['Temperature (C)'])
        const power = numberOrNull(info['Average Graphics Package Power (W)'] ?? info['Current Socket Graphics Package Power (W)'] ?? info['Power (W)'])
        cards.push(makeCard({
          type: isDcu ? 'dcu' : 'gpu',
          vendor: isDcu ? 'Hygon' : 'AMD',
          index,
          name,
          utilization: util,
          memoryUsed: vramUsed,
          memoryTotal: vramTotal,
          temperature: temp,
          powerW: power,
          memoryLabel: '显存',
        }))
        if (cards.length >= MAX_CARDS) break
      }
      if (cards.length > 0) return cards
    } catch {
      /* fall through to table parser */
    }
  }

  // Fallback: standard `hy-smi` / `rocm-smi` table output
  const cards = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^=/.test(line) || /^DCU\s+Temp/i.test(line) || /^GPU\s+Temp/i.test(line)) continue
    // Match lines starting with card index: "0    42.0c   55.0W   ...  12%   45%"
    const m = line.match(/^(\d+)\s+(.+)$/)
    if (m === null) continue
    const index = Number(m[1])
    const rest = m[2]
    const tempMatch = rest.match(/(\d+(?:\.\d+)?)\s*[cC]/)
    const powerMatch = rest.match(/(\d+(?:\.\d+)?)\s*[wW]/)
    const pcts = Array.from(rest.matchAll(/(\d+(?:\.\d+)?)\s*%/g)).map((x) => Number(x[1]))
    if (pcts.length === 0 && tempMatch === null) continue
    const memPct = pcts.length >= 2 ? pcts[pcts.length - 2] : null
    const util = pcts.length >= 1 ? pcts[pcts.length - 1] : null
    const isDcu = defaultType === 'dcu' || /dcu/i.test(text)
    const card = makeCard({
      type: isDcu ? 'dcu' : 'gpu',
      vendor: isDcu ? 'Hygon' : 'AMD',
      index,
      name: isDcu ? `Hygon DCU #${index}` : `AMD GPU #${index}`,
      utilization: util,
      memoryUsed: null,
      memoryTotal: null,
      temperature: tempMatch ? Number(tempMatch[1]) : null,
      powerW: powerMatch ? Number(powerMatch[1]) : null,
      memoryLabel: '显存',
    })
    if (memPct !== null) card.memoryPercent = round1(memPct)
    cards.push(card)
    if (cards.length >= MAX_CARDS) break
  }
  return cards
}

/**
 * Parse `hy-smi --showpids` / `rocm-smi --showpids` output.
 *
 * @param {string} stdout
 * @param {Array<object>} [cards]
 * @param {'dcu'|'gpu'} [defaultType='dcu']
 * @returns {Array<object>}
 */
export function parseDcuPids(stdout, cards = [], defaultType = 'dcu') {
  const text = String(stdout == null ? '' : stdout)
  const procs = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^=/.test(line) || /^PID\s+/i.test(line) || /No KFD PIDs/i.test(line)) continue
    // Format A: "PID    Process Name    DCUs    VRAM Used (B)"
    // e.g. "12345  python3         0       4294967296" or "12345  python3  1  2048 MB"
    const m = line.match(/^(\d+)\s+(\S+)\s+(\d+(?:,\d+)*)\s+(\d+(?:\.\d+)?)\s*([KMGT]?i?B)?/i)
    if (m === null) continue
    const pid = Number(m[1])
    const name = m[2]
    const deviceIndex = Number(m[3].split(',')[0])
    const rawMem = Number(m[4])
    const unit = (m[5] || 'B').toUpperCase()
    const mul = unit.startsWith('G') ? 1024 ** 3
      : unit.startsWith('M') ? 1024 ** 2
      : unit.startsWith('K') ? 1024
      : 1
    const memoryUsed = Number.isFinite(rawMem) ? Math.round(rawMem * mul) : null
    const card = cards.find((c) => c.index === deviceIndex)
    procs.push({
      type: card ? card.type : defaultType,
      vendor: card ? card.vendor : (defaultType === 'dcu' ? 'Hygon' : 'AMD'),
      deviceIndex,
      deviceName: card ? card.name : `${defaultType.toUpperCase()} #${deviceIndex}`,
      pid,
      name,
      memoryUsed,
      memoryPercent: percent(memoryUsed, card ? card.memoryTotal : null),
    })
    if (procs.length >= MAX_PROCS) break
  }
  return procs
}

function execSafe(cmd, args, timeout = 1800) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''))
    })
  })
}

/** Collect all local accelerators (NVIDIA GPU, Huawei NPU, Hygon DCU / AMD GPU). */
export async function collectLocalAccelerators({ withProcesses = false } = {}) {
  const cards = []
  const processes = []

  // 1. NVIDIA GPU
  let nvOut = await execSafe('nvidia-smi', GPU_QUERY)
  if (nvOut.trim() === '') nvOut = await execSafe('nvidia-smi', GPU_QUERY_NO_CC)
  const nvCards = parseGpuCsv(nvOut)
  cards.push(...nvCards)
  if (withProcesses && nvCards.length > 0) {
    const nvAppsOut = await execSafe('nvidia-smi', GPU_APPS_QUERY)
    processes.push(...parseNvidiaApps(nvAppsOut, nvCards))
  }

  // 2. Huawei Ascend NPU
  const npuOut = await execSafe('npu-smi', ['info'])
  if (npuOut.trim() !== '') {
    const parsedNpu = parseNpuSmi(npuOut)
    cards.push(...parsedNpu.cards)
    if (withProcesses) processes.push(...parsedNpu.processes)
  }

  // 3. Hygon DCU / AMD GPU (Linux hosts primarily)
  if (process.platform !== 'win32') {
    let dcuOut = await execSafe('hy-smi', ['--showuse', '--showmeminfo', 'vram', '--showtemp', '--showpower', '--showproductname', '--json'])
    let dcuCmd = 'hy-smi'
    let dcuType = 'dcu'
    if (dcuOut.trim() === '') {
      dcuOut = await execSafe('hy-smi', [])
    }
    if (dcuOut.trim() === '') {
      dcuCmd = 'rocm-smi'
      dcuType = 'gpu'
      dcuOut = await execSafe('rocm-smi', ['--showuse', '--showmeminfo', 'vram', '--showtemp', '--showpower', '--showproductname', '--json'])
      if (dcuOut.trim() === '') dcuOut = await execSafe('rocm-smi', [])
    }
    const dcuCards = parseDcuSmi(dcuOut, dcuType)
    cards.push(...dcuCards)
    if (withProcesses && dcuCards.length > 0) {
      const pidsOut = await execSafe(dcuCmd, ['--showpids'])
      processes.push(...parseDcuPids(pidsOut, dcuCards, dcuType))
    }
  }

  return { cards, processes }
}
