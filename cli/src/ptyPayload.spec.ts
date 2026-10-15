import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// What build-bundle.mjs copies beside a Windows bundle (scripts/lib/ptyPayload.mjs).
// @ts-expect-error — plain ESM with no declaration file
const { copyPtyPayload } = await import('../scripts/lib/ptyPayload.mjs') as {
  copyPtyPayload: (options: { ptyDir: string; outDir: string; platform?: NodeJS.Platform; arch?: string }) => string[]
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function repository(files: string[]): { ptyDir: string; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pty-payload-'))
  dirs.push(root)
  const ptyDir = join(root, 'pty')
  for (const file of files) {
    mkdirSync(join(ptyDir, file, '..'), { recursive: true })
    writeFileSync(join(ptyDir, file), file)
  }
  return { ptyDir, outDir: join(root, 'dist') }
}

const HOST = 'target/release/harness-pty.exe'

describe('the pty host beside a Windows bundle', () => {
  it('copies the host and its ConPTY payload for the build\'s architecture into dist/pty', () => {
    const repo = repository([HOST, 'vendor/conpty/arm64/conpty.dll', 'vendor/conpty/arm64/OpenConsole.exe', 'vendor/conpty/x64/conpty.dll'])
    expect(copyPtyPayload({ ...repo, platform: 'win32', arch: 'arm64' })).toEqual(['harness-pty.exe', 'conpty.dll', 'OpenConsole.exe'])
    expect(readdirSync(join(repo.outDir, 'pty')).sort()).toEqual(['OpenConsole.exe', 'conpty.dll', 'harness-pty.exe'])
  })

  it('copies only what is there: the host without a fetched payload, nothing without the host', () => {
    const hostOnly = repository([HOST])
    expect(copyPtyPayload({ ...hostOnly, platform: 'win32', arch: 'x64' })).toEqual(['harness-pty.exe'])
    const payloadOnly = repository(['vendor/conpty/x64/conpty.dll', 'vendor/conpty/x64/OpenConsole.exe'])
    expect(copyPtyPayload({ ...payloadOnly, platform: 'win32', arch: 'x64' })).toEqual([])
    expect(existsSync(join(payloadOnly.outDir, 'pty'))).toBe(false)
  })

  it('leaves a Unix bundle as it was', () => {
    const repo = repository([HOST, 'vendor/conpty/x64/conpty.dll'])
    for (const platform of ['darwin', 'linux'] as const) expect(copyPtyPayload({ ...repo, platform, arch: 'x64' })).toEqual([])
    expect(existsSync(join(repo.outDir, 'pty'))).toBe(false)
  })
})
