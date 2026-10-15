import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'upload-install-ps1.sh')
const source = readFileSync(join(process.cwd(), 'scripts', 'install.ps1'), 'utf8')
const PRODUCTION = "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"

function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  delete base.GCS_BUCKET
  delete base.STAGING_PREFIX
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...base, ...env } })
}

/** The lines that differ between the source and what would be uploaded. */
const changed = (output: string) => {
  const before = source.split('\n')
  const after = output.split('\n')
  expect(after).toHaveLength(before.length)
  return before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]))
}

describe.skipIf(process.platform === 'win32')('upload-install-ps1.sh', () => {
  it('stages a copy that differs in one line only: the manifest base, moved under harness/staging/', () => {
    const result = run(['--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(changed(result.stdout)).toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/'"]])
  })

  it('publishes the file exactly as it is for production', () => {
    const result = run(['--production', '--print'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(source)
  })

  it('honours another staging prefix under harness/, and refuses anything else', () => {
    expect(changed(run(['--print'], { STAGING_PREFIX: 'harness/staging-dry-run' }).stdout))
      .toEqual([[PRODUCTION, "$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging-dry-run/'"]])
    expect(run(['--print'], { STAGING_PREFIX: '../elsewhere' }).status).toBe(2)
    expect(run(['--bogus']).status).toBe(2)
  })
})
