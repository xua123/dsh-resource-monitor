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
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap,temperature.gpu,power.draw,power.limit,uuid',
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
  powerLimit = null,
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
    powerLimit: powerLimit === null ? null : round1(powerLimit),
    powerPercent: powerW !== null && powerLimit !== null ? percent(powerW, powerLimit) : null,
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
    const powerLimit = fields.length >= 10 ? numberOrNull(fields[8]) : null
    const uuid = fields.length >= 10
      ? String(fields[9] || '').trim()
      : (fields.length >= 9 ? String(fields[8] || '').trim() : '')
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
      powerLimit,
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
    const card = uuidToCard.get(gpuUuid) || (cards.length === 1 ? cards[0] : null)
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
    if (pendingCard === null) return
    const card = makeCard({
      type: 'npu',
      vendor: 'Huawei Ascend',
      index: pendingCard.index,
      name: pendingCard.name,
      utilization: pendingCard.utilization,
      memoryUsed: pendingCard.memoryUsed,
      memoryTotal: pendingCard.memoryTotal,
      temperature: pendingCard.temperature,
      powerW: pendingCard.powerW,
      memoryLabel: pendingCard.memoryLabel,
    })
    card.npuId = pendingCard.npuId
    card.chipId = pendingCard.chipId
    cards.push(card)
    pendingCard = null
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
      const ids = cols[0].match(/^(\d+)\s+(\d+)$/)
      const pid = numberOrNull(cols[1])
      if (ids === null || pid === null) continue
      const npuId = Number(ids[1])
      const chipId = Number(ids[2])
      const procName = cols[2] || ''
      const memVal = numberOrNull(cols[cols.length - 1])
      const memoryUsed = memVal === null ? null : memVal * 1024 * 1024
      const card = cards.find((c) => c.npuId === npuId && c.chipId === chipId)
        || cards.find((c) => c.npuId === npuId)
      processes.push({
        type: 'npu',
        vendor: 'Huawei Ascend',
        deviceIndex: card ? card.index : npuId,
        deviceName: card ? card.name : `NPU ${npuId}`,
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

    // Second line of an NPU row: "| 0 0 | 0000:01:00.0 | 0  6359 / 44278 |"
    // (Chip / Device, AICore%, Memory used / total).
    const chipDevice = cols[0].match(/^(\d+)(?:\s+(\d+))?$/)
    if (pendingCard !== null && chipDevice !== null) {
      const restCols = cols.slice(2).join(' ')
      const aicoreMatch = restCols.match(/^\s*(\d+(?:\.\d+)?)/)
      let memUsedMb = null
      let memTotalMb = null
      for (const memMatch of restCols.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)) {
        memUsedMb = Number(memMatch[1])
        memTotalMb = Number(memMatch[2])
      }
      pendingCard.chipId = Number(chipDevice[1])
      pendingCard.index = chipDevice[2] === undefined ? pendingCard.index : Number(chipDevice[2])
      pendingCard.utilization = aicoreMatch === null ? null : Number(aicoreMatch[1])
      pendingCard.memoryUsed = memUsedMb === null ? null : memUsedMb * 1024 * 1024
      pendingCard.memoryTotal = memTotalMb === null ? null : memTotalMb * 1024 * 1024
      flushPending()
      continue
    }

    // First line of an NPU row: "| 0 310P3 | OK | NA 59 2034 / 2034 |"
    // or "| 0 910B2 | OK | 25.4 45 |".
    const idNameMatch = cols[0].match(/^(\d+)\s+(\D.*)$/)
    if (idNameMatch === null) continue
    flushPending()
    const npuId = Number(idNameMatch[1])
    const rawName = idNameMatch[2].trim()
    const name = /^Ascend/i.test(rawName) ? rawName : `Ascend ${rawName}`
    const joined = cols.slice(1).join(' ')
    let powerW = null
    let temperature = null
    const naTemp = joined.match(/\bNA\s+(\d+(?:\.\d+)?)/i)
    if (naTemp !== null) {
      temperature = Number(naTemp[1])
    } else {
      const pt = joined.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/)
      if (pt !== null) {
        powerW = Number(pt[1])
        temperature = Number(pt[2])
      }
    }
    pendingCard = {
      npuId,
      chipId: 0,
      index: npuId,
      name,
      powerW,
      temperature,
      utilization: null,
      memoryUsed: null,
      memoryTotal: null,
      memoryLabel: '显存',
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
  const cleaned = String(stdout == null ? '' : stdout).replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (cleaned === '') return []

  // Try JSON format first (`hy-smi ... --json` or `rocm-smi ... --json`).
  // Real hy-smi output can prepend ANSI-coloured error lines and contain empty
  // ", ," fields, so locate the object and repair those two quirks.
  const jsonStart = cleaned.indexOf('{')
  const jsonEnd = cleaned.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const body = cleaned.slice(jsonStart, jsonEnd + 1)
      .replace(/,\s*,/g, ',')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
    try {
      const json = JSON.parse(body)
      const cards = []
      for (const [key, info] of Object.entries(json)) {
        if (!info || typeof info !== 'object') continue
        const idxMatch = key.match(/(\d+)$/)
        const index = idxMatch ? Number(idxMatch[1]) : cards.length
        const isDcu = defaultType === 'dcu' || /dcu/i.test(key) || /hygon|haiguang|k100|z100/i.test(JSON.stringify(info))
        const name = info['Card Series'] || info['Card series'] || info['Device Name'] || info['Product Name'] || (isDcu ? `Hygon DCU ${index}` : `AMD GPU ${index}`)
        const util = numberOrNull(info['DCU use (%)'] ?? info['GPU use (%)'] ?? info['GFX Activity'] ?? info['Utilization (%)'])
        const totalB = numberOrNull(info['vram Total Memory (B)'] ?? info['VRAM Total Memory (B)'])
        const totalMb = numberOrNull(info['vram Total Memory (MiB)'] ?? info['VRAM Total Memory (MiB)'] ?? info['vram Total Memory (MB)'] ?? info['VRAM Total Memory (MB)'])
        const usedB = numberOrNull(info['vram Total Used Memory (B)'] ?? info['VRAM Total Used Memory (B)'])
        const usedMb = numberOrNull(info['vram Total Used Memory (MiB)'] ?? info['VRAM Total Used Memory (MiB)'] ?? info['vram Total Used Memory (MB)'] ?? info['VRAM Total Used Memory (MB)'])
        const vramTotal = totalB !== null ? totalB : (totalMb !== null ? totalMb * 1024 * 1024 : null)
        const vramUsed = usedB !== null ? usedB : (usedMb !== null ? usedMb * 1024 * 1024 : null)
        let temp = numberOrNull(info['Temperature (Sensor edge) (C)'] ?? info['Temperature (Sensor junction) (C)'] ?? info['Temperature (C)'])
        if (temp === null) {
          for (const [k, v] of Object.entries(info)) {
            if (/temperature/i.test(k)) {
              const n = numberOrNull(v)
              if (n !== null) { temp = n; break }
            }
          }
        }
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

  // Fallback: turquoise `hy-smi` blocks such as
  //   DCU[0] : DCU use (%): 0
  //   DCU[0] : vram Total Memory (MiB): 65520
  const blockCards = new Map()
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    const m = line.match(/^(?:DCU|GPU)\[(\d+)\]\s*:\s*(.+?)\s*:\s*(.+)$/i)
    if (m === null) continue
    const index = Number(m[1])
    const key = m[2].trim()
    const value = m[3].trim()
    let card = blockCards.get(index)
    if (card === undefined) {
      card = { index, name: '', utilization: null, memoryUsed: null, memoryTotal: null, temperature: null, powerW: null, isDcu: defaultType === 'dcu' }
      blockCards.set(index, card)
    }
    const n = numberOrNull(value)
    if (/card series|device name|product name/i.test(key)) card.name = value
    else if (/dcu use|gpu use|gfx activity|utilization/i.test(key)) card.utilization = n
    else if (/vram total used memory/i.test(key)) card.memoryUsed = n === null ? null : n * 1024 * 1024
    else if (/vram total memory/i.test(key)) card.memoryTotal = n === null ? null : n * 1024 * 1024
    else if (/temperature/i.test(key) && n !== null && card.temperature === null) card.temperature = n
    else if (/power/i.test(key)) card.powerW = n
  }
  const blockValues = [...blockCards.values()]
  if (blockValues.some((card) => card.utilization !== null || card.memoryTotal !== null || card.memoryUsed !== null)) {
    const cards = []
    for (const card of blockValues) {
      const isDcu = card.isDcu || /dcu K|hygon|haiguang|k100|z100/i.test(card.name)
      cards.push(makeCard({
        type: isDcu ? 'dcu' : 'gpu',
        vendor: isDcu ? 'Hygon' : 'AMD',
        index: card.index,
        name: card.name || (isDcu ? `Hygon DCU ${card.index}` : `AMD GPU ${card.index}`),
        utilization: card.utilization,
        memoryUsed: card.memoryUsed,
        memoryTotal: card.memoryTotal,
        temperature: card.temperature,
        powerW: card.powerW,
        memoryLabel: '显存',
      }))
      if (cards.length >= MAX_CARDS) break
    }
    return cards
  }

  // Last resort: numeric table output ("0  42.0c 55.0W ... 12% 45%").
  const productNames = new Map()
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const pm = rawLine.match(/(?:DCU|GPU|card)\[?(\d+)\]?\s*[:\-]\s*(?:Card\s*(?:series|model)|Device\s*Name|Product\s*Name)\s*:\s*(.+)$/i)
    if (pm !== null) {
      const nameVal = pm[2].trim()
      if (nameVal !== '' && !/^N\/A$/i.test(nameVal)) productNames.set(Number(pm[1]), nameVal)
    }
  }
  const cards = []
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^=/.test(line) || /^DCU\s+Temp/i.test(line) || /^GPU\s+Temp/i.test(line)) continue
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
    const isDcu = defaultType === 'dcu' || /dcu/i.test(cleaned)
    const fallbackName = isDcu ? `Hygon DCU #${index}` : `AMD GPU #${index}`
    const card = makeCard({
      type: isDcu ? 'dcu' : 'gpu',
      vendor: isDcu ? 'Hygon' : 'AMD',
      index,
      name: productNames.get(index) || fallbackName,
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
  const seen = new Set()

  // Real `hy-smi --showpids` is a block per process:
  //   PID: 2303650
  //     DCU Index: ['0']
  //     VRAM USED(MiB): 3843
  for (const block of text.split(/(?=^PID:)/m)) {
    const pidMatch = block.match(/^PID:\s*(\d+)/m)
    if (pidMatch === null) continue
    const pid = Number(pidMatch[1])
    const idxMatch = block.match(/DCU Index:\s*\[?['"]?(\d+)/i)
    const deviceIndex = idxMatch === null ? 0 : Number(idxMatch[1])
    const memMatch = block.match(/VRAM USED\(MiB\):\s*(\d+(?:\.\d+)?)/i)
    const memoryUsed = memMatch === null ? null : Number(memMatch[1]) * 1024 * 1024
    const nameMatch = block.match(/Process name\s*[:\t]\s*(.+)/i)
    const name = nameMatch === null ? `PID ${pid}` : nameMatch[1].trim()
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
    seen.add(pid)
    if (procs.length >= MAX_PROCS) return procs
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || /^=/.test(line) || /^PID\s+/i.test(line) || /No KFD PIDs/i.test(line)) continue
    // Format A: "PID    Process Name    DCUs    VRAM Used (B)"
    const m = line.match(/^(\d+)\s+(\S+)\s+(\d+(?:,\d+)*)\s+(\d+(?:\.\d+)?)\s*([KMGT]?i?B)?/i)
    if (m === null) continue
    const pid = Number(m[1])
    if (seen.has(pid)) continue
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
