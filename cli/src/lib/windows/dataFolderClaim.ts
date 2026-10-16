/**
 * Windows: one core per data folder. Each start listens on a pipe of a new random name (lib/localSocket.ts), so
 * unlike the fixed Unix socket that listen never meets a second core on the same folder; and asking the recorded
 * pipe first (`refuseServedDataFolder`) cannot see two starts at once. So the core also holds a pipe of a FIXED
 * name per data folder for as long as it runs. libuv creates a pipe server with FILE_FLAG_FIRST_PIPE_INSTANCE, so
 * a second listen on that name fails with EADDRINUSE: that start is refused as a daemon already serving the folder.
 * The claim serves nothing; Windows removes it with the process, however that ends.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { alreadyServing } from '../localSocket.js'

export interface DataFolderClaim {
  /** The name the claim listens on. */
  path: string
  /** Give the folder up: stop listening. Safe to call more than once. */
  release: () => void
}

export interface DataFolderClaimDeps {
  /** The folder's real path (made if missing): two spellings of one folder must name one claim. */
  realpath?: (dataDir: string) => string
  /** The fixed name for that real path. A spec puts a Unix socket here. */
  pipeFor?: (realDataDir: string) => string
}

/** `\\.\pipe\harness-claim-<first 32 hex of sha256 of the lowercased real path>`: Windows compares paths without case. */
export function dataFolderClaimPipe(realDataDir: string): string {
  return `\\\\.\\pipe\\harness-claim-${createHash('sha256').update(realDataDir.toLowerCase()).digest('hex').slice(0, 32)}`
}

function realDataFolder(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return realpathSync.native(dataDir)
}

/** Claim [dataDir] for this process. Rejects with `alreadyServing` when another core holds it, or with the error. */
export function claimDataFolder(dataDir: string, deps: DataFolderClaimDeps = {}): Promise<DataFolderClaim> {
  const path = (deps.pipeFor ?? dataFolderClaimPipe)((deps.realpath ?? realDataFolder)(dataDir))
  // Nothing is served here: a connection is closed as it arrives.
  const server = createServer((socket) => socket.destroy())
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE' ? alreadyServing(dataDir) : error))
    server.listen(path, () => {
      server.removeAllListeners('error')
      server.on('error', () => { /* a listening claim has nothing to report */ })
      // Never what keeps the core running: it lives as long as the core does.
      server.unref()
      let released = false
      resolve({ path, release: () => { if (!released) { released = true; server.close() } } })
    })
  })
}
