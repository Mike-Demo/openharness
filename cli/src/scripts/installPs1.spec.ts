import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('writes a harness.cmd that only reads the two pointers and passes the arguments through untouched', () => {
    const template = source.slice(source.indexOf("$HarnessCmd = @'"), source.indexOf("'@", source.indexOf("$HarnessCmd = @'")))
    expect(template).toContain('set /p HARNESS_CLI_VERSION=<"%HARNESS_ROOT%\\cli\\current"')
    expect(template).toContain('set /p HARNESS_NODE=<"%HARNESS_ROOT%\\runtime\\current-node"')
    expect(template.match(/%\*/g)).toHaveLength(1)
    // The exit shares node's line and reads node's exit code through `call`, after node has run: a plain `& exit /b`
    // hands `cmd /c` (every caller) 0, and a `%ERRORLEVEL%` read anywhere else is expanded before node starts.
    expect(template).toMatch(/%\* & call exit \/b %%errorlevel%%\s*$/m)
    expect(template.replace('%%errorlevel%%', '')).not.toMatch(/%errorlevel%/i)
    expect(template).toContain('set "ERRORLEVEL="')
    // No delayed expansion (`!`) and no parenthesised blocks: a profile folder named "Jo (work)" or with a `!`
    // must not change what cmd parses.
    expect(template).not.toContain('!')
    expect(template).not.toMatch(/\)\s*$/m)
  })

  it('never installs hn or tmux on Windows', () => {
    expect(source).not.toMatch(/harness-tui|tmux/i)
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

  it('writes PATH under HARNESS_INSTALL_ENV_KEY when no -SubKey is given, so a test never reaches the real one', () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const bin = `C:\\Users\\someone\\.harness-${randomUUID()}\\bin`
    expect(ps(`Add-HarnessUserPath -Directory '${bin}'`, { HARNESS_INSTALL_ENV_KEY: subkey }).stdout).toBe('True')
    expect(spawnSync('reg.exe', ['query', `HKCU\\${subkey}`, '/v', 'Path'], { encoding: 'utf8' }).stdout).toContain(bin)
    expect(spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' }).stdout).not.toContain(bin)
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

// A whole install starts powershell.exe, Node and cmd many times, and unpacks an 80 MB node.exe: about a minute a
// case on the ARM64 VM.
describe.runIf(windows)('install.ps1, installing for real from a local manifest', { timeout: 300_000 }, () => {
  /**
   * A build of everything install.ps1 downloads:
   * - a Node zip of nodejs.org's shape, holding the Node running this test;
   * - a pty zip whose four files only need to exist (nothing here runs them);
   * - a CLI that answers `version` and echoes any other arguments as JSON.
   * Each manifest entry names its file relative to the manifest.
   */
  function build(platform: string, overrides: { cliSha?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-build-'))
    scratch.push(dir)
    const tar = join(process.env.SystemRoot!, 'System32', 'tar.exe')
    const archiveRoot = `node-v22.0.0-win-${platform.slice('win32-'.length)}`
    mkdirSync(join(dir, 'src', archiveRoot), { recursive: true })
    writeFileSync(join(dir, 'src', archiveRoot, 'node.exe'), readFileSync(process.execPath))
    spawnSync(tar, ['-a', '-cf', join(dir, 'node.zip'), '-C', join(dir, 'src'), archiveRoot])
    mkdirSync(join(dir, 'payload'))
    for (const name of ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe']) writeFileSync(join(dir, 'payload', name), name)
    spawnSync(tar, ['-a', '-cf', join(dir, 'pty.zip'), '-C', join(dir, 'payload'), 'harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe'])
    writeFileSync(join(dir, 'cli.js'), "const a = process.argv.slice(2); if (a[0] === 'version') console.log('9.8.7'); else { console.log(JSON.stringify(a)); process.exitCode = a.includes('fail') ? 7 : 0 }\n")
    writeFileSync(join(dir, 'notify.mjs'), 'export {}\n')
    const ref = (name: string) => {
      const bytes = readFileSync(join(dir, name))
      return { url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    }
    const cli = ref('cli.js')
    const manifest = {
      cli: { version: '9.8.7', cli: { ...cli, sha256: overrides.cliSha ?? cli.sha256 }, notify: ref('notify.mjs') },
      node: { [platform]: { version: 'v22.0.0', ...ref('node.zip'), archiveRoot } },
      pty: { [platform]: { version: '9.8.7', ...ref('pty.zip') } },
    }
    writeFileSync(join(dir, 'install-manifest.json'), JSON.stringify(manifest, null, 2))
    return join(dir, 'install-manifest.json')
  }

  /**
   * A fresh profile whose name has a space, a non-ASCII letter, a CJK character and an `&`: cmd quoting and
   * set /p's code page are what such a name breaks.
   */
  function profile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-home-'))
    scratch.push(dir)
    const home = join(dir, 'J\u00f6 \u65e5 & co')
    mkdirSync(home)
    return home
  }

  function install(home: string, manifest: string, subkey: string, extra: string[] = ['-NoService']) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Manifest', manifest, ...extra], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey }, timeout: 300_000,
    })
  }

  const platform = () => ps('Get-HarnessPlatform').stdout

  /**
   * The Path value under HKCU\<subkey>, as stored (not expanded). Not through `reg.exe query`: it prints to a pipe in
   * the OEM code page, which turns `\u00f6` and `\u65e5` into other bytes, so the profile path would never match.
   * PowerShell prints the value as base64 of its UTF-16 bytes, which no code page can change.
   */
  function userPathValue(subkey: string): string {
    const script = `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${subkey}'); $v = if ($k) { [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    return Buffer.from(run.stdout.trim(), 'base64').toString('utf16le')
  }

  it('lays the version folders, the pointers and both launchers down, and harness works through harness.cmd', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const key = platform()
    const run = install(home, build(key), subkey)
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)

    const root = join(home, '.harness')
    const node = join(root, 'runtime', `node-v22.0.0-${key}`, 'node.exe')
    expect(readFileSync(join(root, 'cli', 'current'), 'utf8')).toBe('9.8.7\r\n')
    expect(readFileSync(join(root, 'runtime', 'current-node'), 'utf8')).toBe(`${node}\r\n`)
    expect(readFileSync(join(root, 'runtime', 'pty', 'current-pty'), 'utf8')).toBe('9.8.7\r\n')
    expect(JSON.parse(readFileSync(join(root, 'cli', '9.8.7', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(readFileSync(join(root, 'cli', 'notify.mjs'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(root, 'bin', 'harness-launch.exe'), 'utf8')).toBe('harness-launch.exe')
    for (const name of ['harness-pty.exe', 'conpty.dll', 'OpenConsole.exe']) expect(readFileSync(join(root, 'runtime', 'pty', '9.8.7', name), 'utf8')).toBe(name)

    // How a person runs it: by name, from PowerShell, in a new window (PATH from the registry, as Explorer gives it).
    const command = join(root, 'bin', 'harness.cmd')
    const viaPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', `& '${command}' echo 'two words' '50%'; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(viaPowerShell.stdout.trim()).toBe('["echo","two words","50%"]')
    // And from cmd, with the exit code passed back.
    const viaCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" version"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    expect(viaCmd.stdout.trim()).toBe('9.8.7')
    const failing = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" fail"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    expect(failing.status).toBe(7)
    // A variable named ERRORLEVEL in the person's environment does not hide it.
    const shadowed = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" fail"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, ERRORLEVEL: '5' } })
    expect(shadowed.status).toBe(7)

    const path = userPathValue(subkey)
    expect(path.split(';')).toContain(join(root, 'bin'))
    expect(run.stdout).toContain('harness 9.8.7 installed')
  })

  it('runs again over itself: nothing downloaded twice, PATH not doubled, harness.cmd left as it is', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const manifest = build(platform())
    expect(install(home, manifest, subkey).status).toBe(0)
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    const before = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${command}').LastWriteTimeUtc.Ticks`], { encoding: 'utf8' }).stdout.trim()
    const again = install(home, manifest, subkey)
    expect(again.status, again.stdout).toBe(0)
    expect(again.stdout).not.toContain('Downloading')
    const after = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${command}').LastWriteTimeUtc.Ticks`], { encoding: 'utf8' }).stdout.trim()
    expect(after).toBe(before)
    const path = userPathValue(subkey)
    expect(path.split(';').filter((entry) => entry === join(home, '.harness', 'bin'))).toHaveLength(1)
  })

  it('says, in a sentence, which step failed, and points nothing at a CLI it did not verify', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const run = install(home, build(platform(), { cliSha: '0'.repeat(64) }), subkey)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('Harness could not be installed. The step that failed: Installing the Harness CLI.')
    expect(run.stdout).toContain('failed its checksum')
    expect(() => readFileSync(join(home, '.harness', 'cli', 'current'))).toThrow()
  })

  it('reports the failure and leaves the PowerShell it was iex-ed into running', () => {
    const missing = join(tmpdir(), `harness-missing-${randomUUID()}.json`)
    // The throwaway PATH key as well: the install must fail before PATH, but if it ever did not, it lands there.
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const text = `$env:HARNESS_INSTALL_MANIFEST = '${missing}'; Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, USERPROFILE: profile(), HARNESS_INSTALL_ENV_KEY: subkey }, timeout: 120_000 })
    expect(run.stdout).toContain('The step that failed: Reading the release manifests.')
    expect(run.stdout.trim().endsWith('after 1')).toBe(true)
  })

  it('passes arguments through harness.cmd as every caller does, through cmd.exe /d /s /c: unchanged', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    expect(install(home, build(platform()), subkey).status).toBe(0)
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    // Each argument quoted the way the C runtime reads it back: in double quotes, an inner `"` as `\"`.
    const quote = (arg: string) => `"${arg.replace(/"/g, '\\"')}"`
    const through = (args: string[]) =>
      spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.map(quote).join(' ')}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    // [what is passed, what the CLI receives]. A case cmd cannot carry is pinned here as what cmd does, and its
    // characters are listed in the B1 notes.
    const cases: Array<[string[], string[]]> = [
      [['a b'], ['a b']],
      [['a&b'], ['a&b']],
      [['50%'], ['50%']],
      [['x^y'], ['x^y']],
      [['wow!'], ['wow!']],
      [['say "hi"'], ['say "hi"']],
      [['say "hi" 50%'], ['say "hi" 50%']],
      [['a%%b'], ['a%%b']],
      // Pinned as what cmd does: the caller's cmd /c expands a %name% that names a defined variable.
      [['%OS%'], ['Windows_NT']],
    ]
    for (const [args, expected] of cases) {
      const run = through(args)
      expect(run.status, `${JSON.stringify(args)}: ${run.stderr}`).toBe(0)
      expect(JSON.parse(run.stdout.trim()), JSON.stringify(args)).toEqual(expected)
    }
    // Pinned as what cmd does (B1 notes, "characters harness.cmd cannot carry"): an inner `"` ends cmd's quoting, so
    // the `&` after it ends the command and cmd runs the rest as a command of its own.
    const split = through(['say "a&b"'])
    expect(split.status).not.toBe(0)
    expect(JSON.parse(split.stdout.trim())).toEqual(['say "a '])
    expect(split.stderr).toContain('b\\""')
  })

  it('installs by irm | iex under the Restricted execution policy, and harness then runs from a Restricted PowerShell', () => {
    const home = profile()
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const manifest = build(platform())
    const text = `Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey, HARNESS_INSTALL_MANIFEST: manifest }, timeout: 300_000,
    })
    expect(run.stdout.trim().endsWith('after 0'), `${run.stdout}\n${run.stderr}`).toBe(true)
    // The launcher is a .cmd, never a .ps1, so a Restricted PowerShell runs it.
    const command = join(home, '.harness', 'bin', 'harness.cmd')
    const version = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `& '${command}' version; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout.trim()).toBe('9.8.7')
  })
})
