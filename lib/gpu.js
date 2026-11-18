/**
 * NVIDIA GPU inspection.
 *
 * `nvidia-smi` is the only portable source here: it works on Windows and Linux,
 * reports utilization, VRAM and the CUDA compute capability, and fails cleanly
 * on machines without an NVIDIA driver. AMD/Intel GPUs are intentionally out of
 * scope for now.
 */
import { percent } from './util.js'

/** Query used by both the local collector and the remote shell snippet. */
export const GPU_QUERY = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,compute_cap',
  '--format=csv,noheader,nounits',
]

/** Fallback for older drivers that do not know `compute_cap`. */
export const GPU_QUERY_NO_CC = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits',
]

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
  if (value === '' || /\[(?:n\/a|not supported|unknown)\]/i.test(value)) return null
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

/**
 * Parse `nvidia-smi --query-gpu=...` output.
 *
 * @param {string} stdout
 * @returns {Array<object>} one entry per GPU
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
    const usedBytes = memoryUsed === null ? null : memoryUsed * 1024 * 1024
    const totalBytes = memoryTotal === null ? null : memoryTotal * 1024 * 1024
    gpus.push({
      index: index === null ? gpus.length : index,
      name,
      utilization: utilization === null ? null : Math.round(utilization * 10) / 10,
      memoryUsed: usedBytes,
      memoryTotal: totalBytes,
      memoryPercent: percent(usedBytes, totalBytes),
      computeCap,
    })
    if (gpus.length >= 8) break
  }
  return gpus
}
