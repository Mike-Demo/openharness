import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat) }
})
const { stat } = await import('node:fs/promises')
const { downloadFiles, downloadedBytes, removeDownload, unfinishedDownload } = await import('./modelFiles.js')

describe("a download's files in grid's models folder", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-files-'))
    for (const [name, size] of [['Glimmer-Q4.gguf', 16], ['Glimmer-Q4.mmproj.gguf.part', 4], ['Glimmer-Q4.notes.txt', 2], ['Other-Q4.gguf', 8]] as const) {
      await writeFile(join(dir, name), Buffer.alloc(size))
    }
  })
  afterEach(async () => { vi.mocked(stat).mockReset(); await rm(dir, { recursive: true, force: true }) })

  it('are its weights, its projector and either one\'s .part — nothing else of the folder', async () => {
    expect((await downloadFiles(dir, 'Glimmer-Q4.gguf')).sort()).toEqual(['Glimmer-Q4.gguf', 'Glimmer-Q4.mmproj.gguf.part'])
    expect(await downloadFiles(join(dir, 'missing'), 'Glimmer-Q4.gguf')).toEqual([])
  })

  it('are unfinished while a .part is there', async () => {
    expect(await unfinishedDownload(dir, 'Glimmer-Q4.gguf')).toBe(true)
    expect(await unfinishedDownload(dir, 'Other-Q4.gguf')).toBe(false)
  })

  it('are measured complete and unfinished alike, a file gone meanwhile counting nothing', async () => {
    expect(await downloadedBytes(dir, 'Glimmer-Q4.gguf')).toBe(20)
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(stat).mockImplementation(async path => String(path).endsWith('.part') ? Promise.reject(new Error('ENOENT')) : real.stat(path))
    expect(await downloadedBytes(dir, 'Glimmer-Q4.gguf')).toBe(16)
  })

  it('go when the download is cancelled, and nothing else does', async () => {
    await removeDownload(dir, 'Glimmer-Q4.gguf')
    expect((await readdir(dir)).sort()).toEqual(['Glimmer-Q4.notes.txt', 'Other-Q4.gguf'])
  })
})
