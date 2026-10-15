import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// vitest runs from cli/, so this is cli/scripts/install.ps1, the file published to the CDN.
const installer = join(process.cwd(), 'scripts', 'install.ps1')
const source = readFileSync(installer, 'utf8')

describe('install.ps1, as written', () => {
  it('is pure ASCII: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page', () => {
    const offending = source.split(/\r?\n/).flatMap((line, i) => (/[^\t\r\x20-\x7e]/.test(line) ? [`${i + 1}: ${line}`] : []))
    expect(offending).toEqual([])
  })

  it('has exactly one manifest-base line, the production one, for the staging upload to rewrite', () => {
    const lines = source.split(/\r?\n/).filter((line) => line.startsWith("$HarnessManifestBase = '"))
    expect(lines).toEqual(["$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"])
  })

  it('never writes machine-wide state: no machine PATH, no HKLM write, no elevation', () => {
    expect(source).not.toMatch(/'Machine'|\[EnvironmentVariableTarget\]::Machine|LocalMachine/)
    expect(source).not.toMatch(/-Verb\s+RunAs/i)
    for (const line of source.split(/\r?\n/).filter((l) => l.includes('HKLM:'))) expect(line).toContain('Get-ItemProperty')
  })

  it('runs its install only outside library mode, and never exits a session it was iex-ed into', () => {
    expect(source).toContain("if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {")
    expect(source).toContain('if ($HarnessScriptPath) { exit $harnessExit }')
  })
})

const windows = process.platform === 'win32'
const scratch: string[] = []
const subkeys: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  for (const key of subkeys) spawnSync('reg.exe', ['delete', `HKCU\\${key}`, '/f'], { encoding: 'utf8' })
})

/** Run [script] in Windows PowerShell 5.1 with the installer dot-sourced in library mode. */
function ps(script: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const text = `$ErrorActionPreference = 'Stop'; . '${installer}'; ${script}`
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: { ...process.env, HARNESS_INSTALL_LIBRARY: '1', ...env }, timeout: 120_000,
  })
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr }
}

/** The message a call throws, or `no error`. */
const thrown = (call: string) => ps(`try { ${call} | Out-Null; 'no error' } catch { $_.Exception.Message }`).stdout

// Each case starts powershell.exe several times, and one start takes 1 to 2 seconds on the ARM64 VM: the
// default 5 seconds timed out six of the seven cases there.
describe.runIf(windows)('install.ps1 building blocks, in Windows PowerShell 5.1', { timeout: 120_000 }, () => {
  it('names this computer\'s platform from the native architecture, and refuses one Harness is not built for', () => {
    expect(ps("Get-HarnessPlatform -Architecture 'AMD64'").stdout).toBe('win32-x64')
    expect(ps("Get-HarnessPlatform -Architecture 'ARM64'").stdout).toBe('win32-arm64')
    expect(thrown("Get-HarnessPlatform -Architecture 'x86'")).toContain('not supported')
    expect(ps('Get-HarnessPlatform').stdout).toMatch(/^win32-(x64|arm64)$/)
  })

  it('refuses a Windows older than ConPTY, and a Windows without its own tar.exe', () => {
    expect(thrown('Test-HarnessHost -Build 17134')).toContain('Windows 10 version 1809 or later')
    const empty = mkdtempSync(join(tmpdir(), 'harness-ps1-root-'))
    scratch.push(empty)
    expect(thrown(`Test-HarnessHost -Build 22631 -SystemRoot '${empty}'`)).toContain('tar.exe')
    expect(ps('Test-HarnessHost').stdout.toLowerCase()).toBe(join(process.env.SystemRoot!, 'System32', 'tar.exe').toLowerCase())
  })

  it('trusts https:// and local files only, and resolves a local manifest\'s relative names against its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ref-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, '{}')
    expect(ps(`Resolve-HarnessRef 'cli.js' '${manifest}'`).stdout).toBe(join(dir, 'cli.js'))
    expect(ps(`Resolve-HarnessRef 'https://cdn.example/a.zip' '${manifest}'`).stdout).toBe('https://cdn.example/a.zip')
    expect(thrown(`Resolve-HarnessRef 'http://cdn.example/a.zip' '${manifest}'`)).toContain('https://')
    expect(thrown("Resolve-HarnessRef 'cli.js' 'https://cdn.example/metadata.json'")).toContain('not an https:// address')
    expect(thrown("Get-HarnessJson 'http://cdn.example/metadata.json'")).toContain('https://')
  })

  it('keeps a download only when its size and SHA-256 are the manifest\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-dl-'))
    scratch.push(dir)
    const file = join(dir, 'payload.bin')
    writeFileSync(file, 'harness')
    const sha = 'a'.repeat(64) // a valid shape, not this file's digest
    const real = ps(`(Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash.ToLowerInvariant()`).stdout
    const out = join(dir, 'out.bin')
    expect(ps(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 7; 'ok'`).stdout).toBe('ok')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 8`)).toContain('7 bytes, but the manifest says 8')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${sha}' -Size 7`)).toContain('failed its checksum')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 'nope' -Size 7`)).toContain('no valid SHA-256')
  })

  it('writes a pointer as its value and CRLF, with no BOM, and replaces one that is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ptr-'))
    scratch.push(dir)
    const pointer = join(dir, 'current')
    expect(ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.3'; 'ok'`).stdout).toBe('ok')
    expect(ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.4'; 'ok'`).stdout).toBe('ok')
    expect(readFileSync(pointer)).toEqual(Buffer.from('1.2.4\r\n'))
    expect(readdirSync(dir)).toEqual(['current']) // no temporary file left beside it
  })

  it('adds the bin folder to the user\'s PATH once, keeping the value\'s kind and what was there', () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    spawnSync('reg.exe', ['add', `HKCU\\${subkey}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%SystemRoot%\\fake', '/f'], { encoding: 'utf8' })
    const bin = 'C:\\Users\\someone\\.harness\\bin'
    expect(ps(`Add-HarnessUserPath -Directory '${bin}' -SubKey '${subkey}'`).stdout).toBe('True')
    expect(ps(`Add-HarnessUserPath -Directory '${bin}\\' -SubKey '${subkey}'`).stdout).toBe('False')
    const query = spawnSync('reg.exe', ['query', `HKCU\\${subkey}`, '/v', 'Path'], { encoding: 'utf8' }).stdout
    expect(query).toContain('REG_EXPAND_SZ')
    expect(query).toContain(`%SystemRoot%\\fake;${bin}`)
  })

  it('reads one -Manifest document for all three entries, and says which entry is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-man-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: { 'win32-x64': { version: '1.2.3' } } }))
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').node.entry.version`).stdout).toBe('v22.0.0')
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').pty.source`).stdout).toBe(manifest)
    const partial = join(dir, 'partial.json')
    writeFileSync(partial, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: {} }))
    expect(thrown(`Get-HarnessManifests -Manifest '${partial}' -Platform 'win32-x64'`)).toContain("no 'win32-x64' entry")
    expect(thrown(`Get-HarnessManifests -Manifest '${join(dir, 'missing.json')}' -Platform 'win32-x64'`)).toContain('missing.json')
  })
})
