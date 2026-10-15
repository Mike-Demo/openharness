import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The real script against a fake nodejs.org (file://) and a fake gpgv. What is checked is what the script does
// with their answers. gpgv's own verification is gpg's, run for real by the workflow (Step 5).
const script = join(process.cwd(), 'scripts', 'publish-node-runtime-windows.sh')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(options: { signed?: boolean; tamper?: boolean; keyringSha?: string; dryRun?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-node-win-'))
  dirs.push(root)
  const dist = join(root, 'dist', 'v22.0.0')
  mkdirSync(dist, { recursive: true })
  const lines = ['x64', 'arm64'].map((arch) => {
    const name = `node-v22.0.0-win-${arch}.zip`
    writeFileSync(join(dist, name), `zip ${arch}`)
    return `${sha(options.tamper && arch === 'arm64' ? 'other bytes' : `zip ${arch}`)}  ${name}`
  })
  writeFileSync(join(dist, 'SHASUMS256.txt'), lines.join('\n') + '\n')
  writeFileSync(join(dist, 'SHASUMS256.txt.sig'), 'signature')
  writeFileSync(join(root, 'pubring.kbx'), 'keyring')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gpgv'), `#!/bin/sh\necho "$@" > "${join(root, 'gpgv-args')}"\nexit ${options.signed === false ? 1 : 0}\n`)
  chmodSync(join(bin, 'gpgv'), 0o755)
  const result = spawnSync('bash', [script, '22.0.0'], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: options.dryRun ?? '1', DRY_RUN_OUT: join(root, 'out'),
      NODE_DIST_BASE: `file://${join(root, 'dist')}`, NODE_RELEASE_KEYRING_URL: `file://${join(root, 'pubring.kbx')}`,
      NODE_RELEASE_KEYRING_SHA256: options.keyringSha ?? sha('keyring'), METADATA_PATH: 'harness/staging/runtime/metadata.json',
      GCS_BUCKET: 's3-autonomous-upgrade-3', GCS_PUBLIC_BASE_URL: 'https://storage.googleapis.com/s3-autonomous-upgrade-3',
    },
  })
  return { root, result }
}

describe.skipIf(process.platform === 'win32')('publish-node-runtime-windows.sh, as a dry run', () => {
  it('publishes both Windows zips under the runtime manifest\'s win32 keys, with nodejs.org\'s archive root', () => {
    const { root, result } = fixture()
    expect(result.status, result.stderr).toBe(0)
    const doc = JSON.parse(readFileSync(join(root, 'out', 'metadata.json'), 'utf8'))
    for (const arch of ['x64', 'arm64']) {
      expect(doc.node[`win32-${arch}`]).toEqual({
        version: 'v22.0.0',
        url: `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/runtime/node/v22.0.0/node-v22.0.0-win-${arch}.zip`,
        sha256: sha(`zip ${arch}`), size: `zip ${arch}`.length, archiveRoot: `node-v22.0.0-win-${arch}`,
      })
    }
    // gpgv checks the list against the pinned keyring: the detached signature, then the signed file.
    expect(readFileSync(join(root, 'gpgv-args'), 'utf8').trim()).toMatch(/^--keyring \S+\/pubring\.kbx \S+\/SHASUMS256\.txt\.sig \S+\/SHASUMS256\.txt$/)
  })

  it('refuses a checksum list whose signature does not verify', () => {
    const { result } = fixture({ signed: false })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not carry a valid signature from a Node release key')
  })

  it('refuses a zip that does not match the signed list', () => {
    const { result } = fixture({ tamper: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node-v22.0.0-win-arm64.zip does not match the signed SHASUMS256.txt')
  })

  it('refuses a keyring that is not the pinned one', () => {
    const { result } = fixture({ keyringSha: 'b'.repeat(64) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match its pinned sha256')
  })

  it('refuses a DRY_RUN that is not exactly 0 or 1, before any download', () => {
    const { result } = fixture({ dryRun: 'yes' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('DRY_RUN must be 0 or 1')
  })
})
