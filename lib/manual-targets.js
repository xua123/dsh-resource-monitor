/**
 * Manually added SSH targets.
 *
 * The plugin can monitor servers the user adds from the dashboard, not only the
 * machines already saved by dsh-remote or present in ~/.ssh/config. Records live
 * in `$DSH_HOME/server-monitor/targets.json`; pasted private keys are written to
 * `$DSH_HOME/server-monitor/keys/<id>.key` with owner-only permissions.
 *
 * Secrets never leave the host process: `publicManualTarget()` is the only shape
 * returned to the browser, and it only exposes booleans.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, expandPath, isDialableHost, readJsonFile, writeJsonFile } from './util.js'

/** Directory that owns manual targets, keys and the TOFU host-key store. */
export function monitorHome() {
  return path.join(dshHome(), 'server-monitor')
}

export function targetsFile() {
  return path.join(monitorHome(), 'targets.json')
}

export function keysDir() {
  return path.join(monitorHome(), 'keys')
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* Windows ignores POSIX modes; the user profile ACL still applies */
  }
}

function loadRawList() {
  const data = readJsonFile(targetsFile())
  const list = Array.isArray(data?.targets) ? data.targets : []
  return list.filter((entry) => entry !== null && typeof entry === 'object')
}

function saveRawList(list) {
  ensurePrivateDir(monitorHome())
  writeJsonFile(targetsFile(), { version: 1, targets: list })
  try {
    fs.chmodSync(targetsFile(), 0o600)
  } catch {
    /* see ensurePrivateDir */
  }
}

function normalizeStored(entry) {
  const auth = entry.auth === 'key' ? 'key' : 'password'
  return {
    id: String(entry.id || ''),
    name: String(entry.name || entry.host || '').slice(0, 80),
    host: String(entry.host || ''),
    port: Number(entry.port) || 22,
    username: String(entry.username || ''),
    auth,
    password: auth === 'password' ? String(entry.password || '') : '',
    privateKeyPath: auth === 'key' ? String(entry.privateKeyPath || '') : '',
    passphrase: auth === 'key' ? String(entry.passphrase || '') : '',
    createdAt: String(entry.createdAt || ''),
    updatedAt: String(entry.updatedAt || entry.createdAt || ''),
  }
}

/** All manual targets, with secrets, for the collector. */
export function loadManualTargets() {
  return loadRawList()
    .map(normalizeStored)
    .filter((entry) => entry.id !== '' && isDialableHost(entry.host) && entry.username !== '')
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max)
}

function writeKeyFile(id, text) {
  ensurePrivateDir(keysDir())
  const file = path.join(keysDir(), `${id}.key`)
  const body = text.endsWith('\n') ? text : `${text}\n`
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* see ensurePrivateDir */
  }
  return file
}

function removeKeyFile(file) {
  if (file === '') return
  const root = path.resolve(keysDir())
  const target = path.resolve(file)
  if (!target.startsWith(root + path.sep)) return
  try {
    fs.unlinkSync(target)
  } catch {
    /* already gone */
  }
}

/**
 * Add one server.
 *
 * @param {object} input
 * @param {string} [input.name]
 * @param {string} input.host
 * @param {number|string} [input.port]
 * @param {string} input.username
 * @param {'password'|'key'} [input.auth]
 * @param {string} [input.password]
 * @param {string} [input.privateKey] pasted key body
 * @param {string} [input.privateKeyPath] path to an existing key
 * @param {string} [input.passphrase]
 * @returns {object} public target
 */
export function addManualTarget(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const host = cleanText(source.host, 255)
  if (!isDialableHost(host)) throw new Error('服务器地址格式不正确')
  const port = Number(source.port) || 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535')
  const username = cleanText(source.username, 128)
  if (username === '' || /\s/.test(username)) throw new Error('请填写有效的 SSH 用户名')
  const auth = source.auth === 'key' ? 'key' : 'password'
  const name = cleanText(source.name, 80) || host
  const now = new Date().toISOString()
  const id = `manual-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`

  let password = ''
  let privateKeyPath = ''
  let passphrase = ''
  if (auth === 'password') {
    password = cleanText(source.password, 4096)
    if (password === '') throw new Error('请填写 SSH 密码')
  } else {
    const pasted = cleanText(source.privateKey, 128 * 1024)
    const keyPathInput = cleanText(source.privateKeyPath, 1024)
    if (pasted !== '') {
      privateKeyPath = writeKeyFile(id, pasted)
    } else if (keyPathInput !== '') {
      const expanded = expandPath(keyPathInput)
      let stat
      try {
        stat = fs.statSync(expanded)
      } catch {
        throw new Error(`私钥文件不存在：${expanded}`)
      }
      if (!stat.isFile()) throw new Error(`私钥路径不是文件：${expanded}`)
      privateKeyPath = expanded
    } else {
      throw new Error('请粘贴私钥、选择私钥文件，或填写私钥路径')
    }
    passphrase = cleanText(source.passphrase, 4096)
  }

  const record = {
    id,
    name,
    host,
    port,
    username,
    auth,
    password,
    privateKeyPath,
    passphrase,
    createdAt: now,
    updatedAt: now,
  }
  const list = loadRawList().map(normalizeStored)
  list.push(record)
  saveRawList(list)
  return publicManualTarget(record)
}

/** Delete one manual target and its owned key file. */
export function deleteManualTarget(id) {
  const clean = String(id == null ? '' : id).trim()
  const list = loadRawList().map(normalizeStored)
  const index = list.findIndex((entry) => entry.id === clean)
  if (index < 0) throw new Error('找不到该服务器')
  const [removed] = list.splice(index, 1)
  removeKeyFile(removed.privateKeyPath)
  saveRawList(list)
  return publicManualTarget(removed)
}

/** Browser-safe projection: no password, passphrase or key path. */
export function publicManualTarget(record) {
  return {
    id: record.id,
    name: record.name || record.host,
    host: record.host,
    port: Number(record.port) || 22,
    username: record.username,
    auth: record.auth === 'key' ? 'key' : 'password',
    hasPassword: record.auth !== 'key' && record.password !== '',
    hasKey: record.auth === 'key' && record.privateKeyPath !== '',
    createdAt: record.createdAt || '',
  }
}

/** Shape consumed by the SSH pool. */
export function toSshTarget(record) {
  return {
    id: `manual:${record.id}`,
    manualId: record.id,
    kind: 'remote',
    source: 'manual',
    name: record.name || record.host,
    alias: record.name || record.host,
    host: record.host,
    port: Number(record.port) || 22,
    username: record.username,
    password: record.password,
    privateKeyPath: record.privateKeyPath,
    passphrase: record.passphrase,
    saved: false,
    manual: true,
  }
}
