// The Windows single-instance claim on a data folder. Here a Unix socket stands in for the fixed pipe (its second
// listen fails with EADDRINUSE as a pipe's does); the real pipe is checked in dataFolderClaim.real.spec.ts.
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimDataFolder, dataFolderClaimPipe, type DataFolderClaim } from './dataFolderClaim.js'

const dirs: string[] = []
const claims: DataFolderClaim[] = []
afterEach(() => {
  claims.splice(0).forEach((claim) => claim.release())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

/** A data folder and deps that put its claim at a socket named for the folder's real path, as the pipe is. */
function folder(): { dataDir: string; deps: Parameters<typeof claimDataFolder>[1] } {
  const root = mkdtempSync('/tmp/hclaim-')
  dirs.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  return { dataDir, deps: { realpath: (dir) => dir, pipeFor: (real) => join(real, '..', 'claim.sock') } }
}

const take = async (...args: Parameters<typeof claimDataFolder>) => {
  const claim = await claimDataFolder(...args)
  claims.push(claim)
  return claim
}

describe('the data folder claim', () => {
  it('names one fixed pipe per data folder, whatever its case', () => {
    const pipe = dataFolderClaimPipe('C:\\Users\\Ann\\.harness\\cli\\data')
    expect(pipe).toMatch(/^\\\\\.\\pipe\\harness-claim-[0-9a-f]{32}$/)
    expect(dataFolderClaimPipe('c:\\users\\ann\\.harness\\cli\\DATA')).toBe(pipe)
    expect(dataFolderClaimPipe('C:\\Users\\Bob\\.harness\\cli\\data')).not.toBe(pipe)
  })
})

// A Unix socket for the pipe: on Windows the real pipe is what dataFolderClaim.real.spec.ts checks.
describe.skipIf(process.platform === 'win32')('the data folder claim, a Unix socket standing in for its pipe', () => {

  it('refuses a second claim on the same folder as a daemon already serving it, and allows one once released', async () => {
    const { dataDir, deps } = folder()
    const first = await claimDataFolder(dataDir, deps)
    const second = claimDataFolder(dataDir, deps)
    await expect(second).rejects.toMatchObject({ code: 'EADDRINUSE', message: `A Harness daemon is already serving ${dataDir}` })
    first.release()
    first.release()
    await take(dataDir, deps)
  })

  it('lets a claim on another folder through', async () => {
    const a = folder(), b = folder()
    await take(a.dataDir, a.deps)
    await take(b.dataDir, b.deps)
  })

  it('answers nothing: a connection to the claim is closed at once', async () => {
    const { dataDir, deps } = folder()
    const claim = await take(dataDir, deps)
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(claim.path)
      socket.on('error', () => resolve(true))
      socket.on('close', () => resolve(true))
      socket.setTimeout(2_000, () => { socket.destroy(); resolve(false) })
    })
    expect(closed).toBe(true)
  })

  it('fails the start on any other error', async () => {
    const { dataDir } = folder()
    await expect(claimDataFolder(dataDir, { realpath: (dir) => dir, pipeFor: (real) => join(real, 'missing', 'claim.sock') }))
      .rejects.toMatchObject({ syscall: 'listen' })
  })

  it('by default, claims the real path of the folder, made if missing', async () => {
    const root = mkdtempSync('/tmp/hclaim-')
    dirs.push(root)
    const dataDir = join(root, 'new', 'data')
    let named = ''
    const claim = await take(dataDir, { pipeFor: (real) => { named = real; return join(root, 'claim.sock') } })
    expect(named).toBe(join(realpathSync.native(root), 'new', 'data'))
    expect(claim.path).toBe(join(root, 'claim.sock'))
  })
})
