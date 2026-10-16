import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonPipe, legacyDaemonStatus, localDaemonCall, localDaemonStatus, saveDaemonPort, savedDaemonPort } from './daemonEndpoint.js'
import { readDaemonRecord } from './daemonRecord.js'
import { listenLocalSocket, localSocketPath } from './localSocket.js'
import { ensureDaemonToken } from './windows/pipeAuth.js'
import { PipeUnproven } from './windows/pipeClient.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function directory(): string {
  const path = mkdtempSync('/tmp/hn-owner-')
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

describe('per-user daemon discovery', () => {
  it('never accepts another user\'s TCP status, including when this user has no socket', async () => {
    let foreignRequests = 0
    const foreign = createServer((_req, res) => { foreignRequests++; res.end(JSON.stringify({ machineId: 'other-account' })) })
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())))
    const port = (foreign.address() as { port: number }).port
    const userA = directory(), userB = directory()
    const a = await listenLocalSocket((_req, res) => res.end(JSON.stringify({ machineId: 'account-a' })), localSocketPath(userA, port)!)
    cleanup.push(a.close)
    expect(await localDaemonStatus(userB, port)).toBeNull()
    const b = await listenLocalSocket((_req, res) => res.end(JSON.stringify({ machineId: 'account-b', signedIn: false })), localSocketPath(userB, port)!)
    cleanup.push(b.close)
    expect(await localDaemonStatus(userA, port)).toEqual({ machineId: 'account-a' })
    expect(await localDaemonStatus(userB, port)).toEqual({ machineId: 'account-b', signedIn: false })
    expect(foreignRequests).toBe(0)
  })

  it('refuses a socket accessible to other OS users', async () => {
    const dir = directory(), port = 19418
    let requests = 0
    const socket = await listenLocalSocket((_req, res) => { requests++; res.end('{}') }, localSocketPath(dir, port)!)
    cleanup.push(socket.close)
    chmodSync(socket.path, 0o666)
    expect(await localDaemonStatus(dir, port)).toBeNull()
    expect(requests).toBe(0)
  })

  it('treats invalid status responses as unavailable', async () => {
    const dir = directory(), port = 19418
    let body = 'not json', status = 200
    const socket = await listenLocalSocket((_req, res) => { res.statusCode = status; res.end(body) }, localSocketPath(dir, port)!)
    cleanup.push(socket.close)
    expect(await localDaemonStatus(dir, port)).toBeNull()
    body = '[]'
    expect(await localDaemonStatus(dir, port)).toBeNull()
    body = '{}'; status = 503
    expect(await localDaemonStatus(dir, port)).toBeNull()
  })

  it('persists separate TCP port records per user and configured endpoint', () => {
    const a = directory(), b = directory()
    expect(savedDaemonPort(a, 18473)).toBe(18473)
    saveDaemonPort(a, 18473, 24567)
    expect(savedDaemonPort(a, 18473)).toBe(24567)
    expect(savedDaemonPort(b, 18473)).toBe(18473)
    expect(savedDaemonPort(a, 18474)).toBe(18474)
    const file = join(a, 'daemon-18473.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 24567 })
    for (const body of ['broken', '{}', '{"port":-1}', '{"port":65536}', '{"port":"24567"}']) {
      writeFileSync(file, body)
      expect(savedDaemonPort(a, 18473)).toBe(18473)
    }
  })

  it('records the Windows pipe and the core\'s pid beside the port, and reads only a pipe name back', () => {
    // os.tmpdir(), not directory()'s /tmp: this case runs on Windows too.
    const dir = mkdtempSync(join(tmpdir(), 'hn-record-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const pipe = `\\\\.\\pipe\\harness-${'a'.repeat(32)}`
    saveDaemonPort(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(JSON.parse(readFileSync(join(dir, 'daemon-18473.json'), 'utf8'))).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(savedDaemonPort(dir, 18473)).toBe(24567)
    writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 24567, pipe: 'C:\\evil', pid: -1 }))
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe: null, pid: null })
    saveDaemonPort(dir, 18473, 24568)
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24568, pipe: null, pid: null })
    expect(readDaemonRecord(dir, 18474)).toBeNull()
  })

  it('on Windows, reads back only a local Harness pipe, never a file or another computer\'s pipe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn-record-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const id = 'b'.repeat(32)
    const pipe = `\\\\.\\pipe\\harness-${id}`
    saveDaemonPort(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(readDaemonRecord(dir, 18473, 'win32')).toEqual({ port: 24567, pipe, pid: 4242 })
    for (const other of [`C:\\x\\harness-${id}`, `\\\\host\\pipe\\harness-${id}`, `\\\\.\\pipe\\evilharness-${id}`]) {
      writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 24567, pipe: other, pid: 4242 }))
      expect(readDaemonRecord(dir, 18473, 'win32')).toEqual({ port: 24567, pipe: null, pid: 4242 })
    }
  })

  it('accepts legacy CLI status only when both the saved PID and computer identity match', async () => {
    const status = { pid: 43210, computerId: 'this-user', machineId: 'signed-out-local' }
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end(JSON.stringify(status)) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    expect(await legacyDaemonStatus(port, null, 'this-user')).toBeNull()
    expect(requests).toBe(0)
    expect(await legacyDaemonStatus(port, 43211, 'this-user')).toBeNull()
    expect(await legacyDaemonStatus(port, 43210, 'other-user')).toBeNull()
    expect(await legacyDaemonStatus(port, 43210, 'this-user')).toEqual(status)
  })
})

describe('the daemon over its Windows pipe', () => {
  const alive = { alive: () => true }
  /** A data folder as the Windows core leaves it: a token, a record naming its pipe and pid, and the pipe served. */
  async function windowsDaemon(handler: Parameters<typeof listenLocalSocket>[0], port = 19418) {
    const dir = directory()
    const token = ensureDaemonToken(dir)
    const pipe = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const server = await listenLocalSocket(handler, pipe, { token })
    cleanup.push(server.close)
    saveDaemonPort(dir, port, 24567, { pipe, pid: process.pid })
    return { dir, token, pipe, port }
  }
  const options = { platform: 'win32' as const, pipe: (dir: string, port: number) => daemonPipe(dir, port, alive) }

  it('is found by its record and token, unless its process is proven gone', async () => {
    const { dir, token, pipe, port } = await windowsDaemon((_req, res) => res.end('{}'))
    const found = await daemonPipe(dir, port, alive)
    expect(found?.pipe).toBe(pipe)
    expect(found?.token.equals(token)).toBe(true)
    expect(await daemonPipe(dir, port, { alive: () => false })).toBeNull()
    expect(await daemonPipe(dir, port + 1, alive)).toBeNull()
    saveDaemonPort(dir, port, 24567)
    expect(await daemonPipe(dir, port, alive)).toBeNull()
    expect(await daemonPipe(directory(), port, alive)).toBeNull()
  })

  it('answers status over the pipe, and nothing for an answer without the proof', async () => {
    const { dir, port } = await windowsDaemon((_req, res) => res.end(JSON.stringify({ machineId: 'account-a' })))
    expect(await localDaemonStatus(dir, port, options)).toEqual({ machineId: 'account-a' })
    expect(await localDaemonStatus(directory(), port, options)).toBeNull()
    const foreign = await localDaemonStatus(dir, port, { platform: 'win32', pipe: async (d, p) => ({ ...(await daemonPipe(d, p, alive))!, token: randomBytes(32) }) })
    expect(foreign).toBeNull()
  })

  it('makes control calls over the pipe, falls back to TCP only where nothing is there, and never after an unproven answer', async () => {
    let got = ''
    const { dir, port, pipe } = await windowsDaemon((req, res) => {
      got = `${req.method} ${req.url} ${req.headers['x-adapter-local']}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const tcp = vi.fn(async () => new Response('{"tcp":true}', { status: 200 }))
    const call = (o: Partial<Parameters<typeof localDaemonCall>[5]> = {}) =>
      localDaemonCall(dir, port, 'POST', '/api/pair', { code: '1' }, { ...options, tcpPort: 1, fetch: tcp as typeof fetch, ...o })
    const over = await call()
    expect(await over.json()).toEqual({ ok: true })
    expect(got).toBe('POST /api/pair 1')
    expect(tcp).not.toHaveBeenCalled()
    // No pipe to reach: as on every other OS.
    expect(await (await call({ pipe: async () => null })).json()).toEqual({ tcp: true })
    expect(await (await call({ platform: 'darwin' })).json()).toEqual({ tcp: true })
    // A recorded pipe nothing listens on any more.
    const gone = join(directory(), `harness-${randomBytes(16).toString('hex')}`)
    expect(await (await call({ pipe: async () => ({ pipe: gone, token: randomBytes(32) }) })).json()).toEqual({ tcp: true })
    expect(tcp).toHaveBeenCalledTimes(3)
    await expect(call({ pipe: async () => ({ pipe, token: randomBytes(32) }) })).rejects.toBeInstanceOf(PipeUnproven)
    expect(tcp).toHaveBeenCalledTimes(3)
  })
})
