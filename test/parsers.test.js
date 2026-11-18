import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseDcuPids,
  parseDcuSmi,
  parseGpuCsv,
  parseNpuSmi,
  parseNvidiaApps,
} from '../lib/gpu.js'
import { parsePsOutput } from '../lib/processes.js'
import { parseContainerInfo, parseNetDev, parseRemoteDetails, parseRemoteSnapshot } from '../lib/collect-remote.js'
import { loadHostPrefs, loadTargetAliases, setHostPrefs, setTargetAlias } from '../lib/manual-targets.js'

test('parseGpuCsv parses full NVIDIA output and maps compute capability', () => {
  const stdout = [
    '0, NVIDIA A100-SXM4-80GB, 76, 40960, 81920, 8.0, 58, 245.5, GPU-aaa',
    '1, Tesla V100-SXM2-32GB, 12, 2048, 32768, [N/A], 42, 65.0, GPU-bbb',
  ].join('\n')
  const gpus = parseGpuCsv(stdout)
  assert.equal(gpus.length, 2)
  assert.equal(gpus[0].type, 'gpu')
  assert.equal(gpus[0].vendor, 'NVIDIA')
  assert.equal(gpus[0].utilization, 76)
  assert.equal(gpus[0].memoryPercent, 50)
  assert.equal(gpus[0].temperature, 58)
  assert.equal(gpus[0].powerW, 245.5)
  assert.equal(gpus[0].uuid, 'GPU-aaa')
  assert.equal(gpus[1].computeCap, '7.0')
})

test('parseNvidiaApps maps gpu_uuid back to GPU index and memory percent', () => {
  const cards = parseGpuCsv('0, NVIDIA A100-SXM4-80GB, 50, 40960, 81920, 8.0, 55, 200, GPU-111')
  const procs = parseNvidiaApps('GPU-111, 23456, /usr/bin/python3, 20480', cards)
  assert.equal(procs.length, 1)
  assert.equal(procs[0].deviceIndex, 0)
  assert.equal(procs[0].pid, 23456)
  assert.equal(procs[0].memoryPercent, 25)
  assert.equal(procs[0].type, 'gpu')
})

test('parseNpuSmi parses Huawei Ascend NPU cards and bottom process list', () => {
  const npuOut = `
+------------------------------------------------------------------------------------------------+
| npu-smi 23.0.0                   Version: 23.0.0                                               |
+---------------------------+---------------+----------------------------------------------------+
| NPU   Name                | Health        | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
+===========================+===============+====================================================+
| 0     910B2               | OK            | 92.4        48                0    / 0             |
| 0                         | 0000:C1:00.0  | 85          2400 / 15000      32768 / 65536        |
+===========================+===============+====================================================+
| 1     910B2               | OK            | 68.0        41                0    / 0             |
| 0                         | 0000:C2:00.0  | 0           1200 / 15000      0     / 65536        |
+===========================+===============+====================================================+
+---------------------------+---------------+----------------------------------------------------+
| NPU   Chip                | Process id    | Process name             | Memory(MB)              |
+===========================+===============+====================================================+
| 0     0                   | 41203         | python3                  | 32000                   |
+===========================+===============+====================================================+
`
  const { cards, processes } = parseNpuSmi(npuOut)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].type, 'npu')
  assert.equal(cards[0].name, 'Ascend 910B2')
  assert.equal(cards[0].utilization, 85)
  assert.equal(cards[0].memoryPercent, 50)
  assert.equal(cards[0].temperature, 48)
  assert.equal(cards[0].powerW, 92.4)
  assert.equal(cards[0].memoryLabel, 'HBM')

  assert.equal(processes.length, 1)
  assert.equal(processes[0].type, 'npu')
  assert.equal(processes[0].deviceIndex, 0)
  assert.equal(processes[0].pid, 41203)
  assert.equal(processes[0].name, 'python3')
})

test('parseDcuSmi and parseDcuPids handle Hygon DCU JSON and pid table', () => {
  const jsonOut = JSON.stringify({
    card0: {
      'Card series': 'Hygon DCU K100',
      'DCU use (%)': '64',
      'VRAM Total Memory (B)': String(64 * 1024 ** 3),
      'VRAM Total Used Memory (B)': String(16 * 1024 ** 3),
      'Temperature (Sensor edge) (C)': '51.0',
      'Average Graphics Package Power (W)': '185.0',
    },
  })
  const cards = parseDcuSmi(jsonOut, 'dcu')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].type, 'dcu')
  assert.equal(cards[0].utilization, 64)
  assert.equal(cards[0].memoryPercent, 25)

  const pids = parseDcuPids('9876  vllm-worker  0  8192 MB', cards, 'dcu')
  assert.equal(pids.length, 1)
  assert.equal(pids[0].pid, 9876)
  assert.equal(pids[0].deviceIndex, 0)
  assert.equal(pids[0].memoryPercent, 12.5)

  const tableOut = [
    '0   44.0c   160.0W   12%   78%',
    'DCU[0] : Card series: Hygon Z100L',
  ].join('\n')
  const tableCards = parseDcuSmi(tableOut, 'dcu')
  assert.equal(tableCards.length, 1)
  assert.equal(tableCards[0].type, 'dcu')
  assert.equal(tableCards[0].name, 'Hygon Z100L')
  assert.equal(tableCards[0].utilization, 78)
  assert.equal(tableCards[0].memoryPercent, 12)
})

test('parsePsOutput parses top processes including commands with spaces', () => {
  const psOut = [
    '  1024 root      123.4  12.5 2097152 Rl   python3 train.py --epochs 10',
    '  2048 deploy      2.1   0.5   65536 S    node server.js',
  ].join('\n')
  const procs = parsePsOutput(psOut)
  assert.equal(procs.length, 2)
  assert.equal(procs[0].pid, 1024)
  assert.equal(procs[0].cpuPercent, 123.4)
  assert.equal(procs[0].command, 'python3 train.py --epochs 10')
})

test('parseRemoteSnapshot and parseRemoteDetails integrate CPU, memory, and accelerators', () => {
  const snapOut = [
    '@@HOST', 'ai-node-01',
    '@@OS', '"Ubuntu 22.04.4 LTS"',
    '@@KERNEL', '5.15.0-91-generic',
    '@@UPTIME', '86400',
    '@@CPU1', 'cpu  100 0 50 850 0 0 0 0',
    '@@CPU2', 'cpu  200 0 100 1050 0 0 0 0',
    '@@MEM', 'MemTotal: 1000000 kB\nMemAvailable: 250000 kB',
    '@@LOAD', '1.20 0.85 0.60 2/345',
    '@@NPROC', '64',
    '@@DF', '/dev/nvme0n1p1 10485760 5242880 5242880 50% /',
    '@@GPU', '0, NVIDIA H100, 90, 40960, 81920, 9.0, 62, 350, GPU-h100',
  ].join('\n')

  const snap = parseRemoteSnapshot(snapOut, 18)
  assert.equal(snap.hostname, 'ai-node-01')
  assert.equal(snap.cpu.cores, 64)
  assert.equal(snap.memory.percent, 75)
  assert.equal(snap.gpus.length, 1)
  assert.equal(snap.gpus[0].type, 'gpu')

  const detailsOut = [
    '@@PS', ' 3333 aiuser 99.5 18.2 1048576 R python3 -m vllm',
    '@@GPU', '0, NVIDIA H100, 90, 40960, 81920, 9.0, 62, 350, GPU-h100',
    '@@GPU_PROC', 'GPU-h100, 3333, python3, 40960',
  ].join('\n')
  const details = parseRemoteDetails(detailsOut)
  assert.equal(details.processes.length, 1)
  assert.equal(details.acceleratorProcesses.length, 1)
  assert.equal(details.acceleratorProcesses[0].memoryPercent, 50)
})

test('setTargetAlias, loadTargetAliases, setHostPrefs and loadHostPrefs persist properly', () => {
  const prevHome = process.env.DSH_HOME
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mon-test-'))
  process.env.DSH_HOME = tmpDir
  try {
    setTargetAlias('node-1', 'A100 训练节点')
    assert.deepEqual({ ...loadTargetAliases() }, { 'node-1': 'A100 训练节点' })
    setTargetAlias('node-1', '   ')
    assert.deepEqual({ ...loadTargetAliases() }, {})

    setHostPrefs('node-1', { pinned: true, tags: ['训练', 'A100', '训练'] })
    assert.deepEqual({ ...loadHostPrefs() }, { 'node-1': { pinned: true, tags: ['训练', 'A100'] } })
    setHostPrefs('node-1', { pinned: false, tags: [] })
    assert.deepEqual({ ...loadHostPrefs() }, {})
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('parseNetDev sums physical interfaces and ignores lo/docker/veth', () => {
  const netOut = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets',
    '    lo: 1000000 100 0 0 0 0 0 0 1000000 100 0 0 0 0 0 0',
    'docker0: 500000 50 0 0 0 0 0 0 500000 50 0 0 0 0 0 0',
    '  eth0: 2048000 200 0 0 0 0 0 0 1024000 100 0 0 0 0 0 0',
  ].join('\n')
  const net = parseNetDev(netOut)
  assert.equal(net.rxBytes, 2048000)
  assert.equal(net.txBytes, 1024000)
})

test('parseContainerInfo parses cgroup v2 CPU and memory limits', () => {
  const cOut = ['yes', '400000 100000', String(16 * 1024 ** 3)].join('\n')
  const info = parseContainerInfo(cOut)
  assert.equal(info.isContainer, true)
  assert.equal(info.cpuLimit, 4)
  assert.equal(info.memLimitBytes, 16 * 1024 ** 3)
  assert.equal(parseContainerInfo('no\n'), null)
})
