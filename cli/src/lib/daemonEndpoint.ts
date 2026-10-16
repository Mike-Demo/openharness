import { request } from 'node:http'
import { lstatSync } from 'node:fs'
import { localSocketPath } from './localSocket.js'
import { readDaemonRecord, writeDaemonRecord, type DaemonPipeRecord } from './daemonRecord.js'

// The configured port names the private socket. TCP may use another port when a different OS
// user's daemon already holds that number; remember it in THIS user's data directory (lib/daemonRecord.ts).
export function savedDaemonPort(dataDir: string, configuredPort: number): number {
  return readDaemonRecord(dataDir, configuredPort)?.port ?? configuredPort
}

/** [pipe]: on Windows, the daemon's pipe and the core's pid, which a client cannot derive. */
export function saveDaemonPort(dataDir: string, configuredPort: number, port: number, pipe?: DaemonPipeRecord): void {
  writeDaemonRecord(dataDir, configuredPort, port, pipe)
}

/** A native client must reach this OS user's socket, never whoever happens to hold a TCP port. */
export async function localDaemonStatus(dataDir: string, configuredPort: number): Promise<Record<string, unknown> | null> {
  const socketPath = localSocketPath(dataDir, configuredPort)
  if (!socketPath) return null
  try {
    const entry = lstatSync(socketPath)
    if (!entry.isSocket() || (process.geteuid && entry.uid !== process.geteuid()) || (entry.mode & 0o077) !== 0) return null
  } catch { return null }
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/api/status', signal: AbortSignal.timeout(2_000) }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        if (text.length > 4 * 1024 * 1024) req.destroy(new Error('status response too large'))
      })
      res.on('error', () => resolve(null))
      res.on('end', () => {
        try {
          const value: unknown = JSON.parse(text)
          resolve(res.statusCode === 200 && value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown> : null)
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** Read-only compatibility for CLI status on Windows and older daemons without a Unix socket.
 * Native hn connections must use localDaemonStatus instead. Never accept another daemon's status.
 */
export async function legacyDaemonStatus(port: number, pid: number | null, computerId: string): Promise<Record<string, unknown> | null> {
  if (!pid || !computerId) return null
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const status = value as Record<string, unknown>
    return status.pid === pid && status.computerId === computerId ? status : null
  } catch { return null }
}
