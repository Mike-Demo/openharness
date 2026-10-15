// The daemon's token, on Unix and as Windows reads it (its platform and its open without O_NOFOLLOW). The real
// Windows file is checked in daemonPipe.real.spec.ts.
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asWindows } from '../../testing/windowsOpen.js'
import { daemonTokenPath, ensureDaemonToken, readDaemonToken } from './pipeAuth.js'

vi.mock('node:fs', async (importOriginal) =>
  (await import('../../testing/windowsOpen.js')).windowsOpenFs(await importOriginal<typeof import('node:fs')>()))

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const scratch = (prefix = '/tmp/htoken-') => { const dir = mkdtempSync(prefix); dirs.push(dir); return dir }

describe.skipIf(process.platform === 'win32')('the daemon token', () => {
  it('is made once: 32 random bytes, as hex, owner-only, and read back', () => {
    const dir = scratch()
    expect(readDaemonToken(dir)).toBeNull()
    const token = ensureDaemonToken(dir)
    expect(token).toHaveLength(32)
    expect(ensureDaemonToken(dir).equals(token)).toBe(true)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    expect(statSync(daemonTokenPath(dir)).mode & 0o777).toBe(0o600)
    expect(ensureDaemonToken(scratch()).equals(token)).toBe(false)
  })

  it('replaces a token cut short, and refuses one another account could have written', () => {
    const dir = scratch()
    writeFileSync(daemonTokenPath(dir), 'ab12', { mode: 0o600 })
    expect(readDaemonToken(dir)).toBeNull()
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    chmodSync(daemonTokenPath(dir), 0o666)
    expect(readDaemonToken(dir)).toBeNull()
    expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
  })

  it('on Windows, is read where the profile protects it, never through a link', () => {
    const dir = scratch(), elsewhere = scratch()
    const planted = join(elsewhere, 'daemon-token')
    writeFileSync(planted, `${'1'.repeat(64)}\n`, { mode: 0o600 })
    asWindows(dir, () => {
      expect(ensureDaemonToken(dir)).toHaveLength(32)
    })
    rmSync(daemonTokenPath(dir))
    symlinkSync(planted, daemonTokenPath(dir))
    asWindows(dir, () => {
      expect(readDaemonToken(dir)).toBeNull()
      expect(() => ensureDaemonToken(dir)).toThrow(/daemon token/)
    })
  })
})
