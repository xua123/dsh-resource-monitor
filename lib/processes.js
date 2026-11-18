/**
 * System process list collection & parsing (top-style read-only view).
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import { percent, round1 } from './util.js'

const MAX_PROCESSES = 60

/**
 * Parse `ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,comm=` (or `args=`) output.
 *
 * @param {string} stdout
 * @returns {Array<object>}
 */
export function parsePsOutput(stdout) {
  const rows = []
  for (const rawLine of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = line.match(/^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const user = match[2]
    const cpuPercent = round1(Number(match[3]))
    const memPercent = round1(Number(match[4]))
    const rssKb = Number(match[5])
    const state = match[6]
    const command = match[7].trim().slice(0, 200)
    if (!Number.isFinite(pid) || command === '') continue
    rows.push({
      pid,
      user,
      cpuPercent: cpuPercent === null ? 0 : cpuPercent,
      memPercent: memPercent === null ? 0 : memPercent,
      rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      state,
      command,
    })
    if (rows.length >= MAX_PROCESSES) break
  }
  return rows
}

function execSafe(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''))
    })
  })
}

async function collectWindowsProcesses() {
  const totalMem = os.totalmem()
  const script = [
    '$p = Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 60 Id,ProcessName,CPU,WorkingSet64',
    '$p | ConvertTo-Json -Compress',
  ].join('; ')
  const stdout = await execSafe('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 3500)
  if (stdout.trim() === '') return []
  try {
    const parsed = JSON.parse(stdout)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter((item) => item && Number.isFinite(Number(item.Id)))
      .map((item) => {
        const rss = Number(item.WorkingSet64) || 0
        return {
          pid: Number(item.Id),
          user: '-',
          cpuPercent: item.CPU === null || item.CPU === undefined ? null : round1(Number(item.CPU)),
          cpuTimeSec: item.CPU === null || item.CPU === undefined ? null : round1(Number(item.CPU)),
          memPercent: percent(rss, totalMem) ?? 0,
          rssBytes: rss,
          state: 'R',
          command: String(item.ProcessName || '').slice(0, 200),
        }
      })
  } catch {
    return []
  }
}

/** Collect top system processes on the local host. */
export async function collectLocalProcesses() {
  if (process.platform === 'win32') {
    return collectWindowsProcesses()
  }
  const args = process.platform === 'darwin'
    ? ['-eo', 'pid=,user=,pcpu=,pmem=,rss=,stat=,comm=', '-r']
    : ['-eo', 'pid=,user:24=,pcpu=,pmem=,rss=,stat=,comm=', '--sort=-pcpu']
  const stdout = await execSafe('ps', args, 2500)
  return parsePsOutput(stdout)
}
