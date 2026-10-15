import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** The files a download of [file] writes in grid's models folder [dir]: the weights, the vision projector
 *  `grid pull` fetches beside them (`<stem>.mmproj.gguf`), and either one's unfinished `.part`. */
export async function downloadFiles(dir: string, file: string): Promise<string[]> {
  const stem = basename(file).replace(/\.gguf$/i, '')
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter(name => name.startsWith(stem) && (/\.gguf$/i.test(name) || name.endsWith('.part')))
}

/** Whether a download of [file] did not finish: a `.part` of it, or of its projector, is still there. */
export async function unfinishedDownload(dir: string, file: string): Promise<boolean> {
  return (await downloadFiles(dir, file)).some(name => name.endsWith('.part'))
}

/** How much of a download of [file] is on disk now, complete and unfinished files alike — what a stall
 *  watch measures a download by. A file gone between the listing and its size counts nothing. */
export async function downloadedBytes(dir: string, file: string): Promise<number> {
  const sizes = await Promise.all((await downloadFiles(dir, file)).map(name => stat(join(dir, name)).then(s => s.size, () => 0)))
  return sizes.reduce((sum, size) => sum + size, 0)
}

/** A cancelled download's files, gone. */
export async function removeDownload(dir: string, file: string): Promise<void> {
  for (const name of await downloadFiles(dir, file)) await rm(join(dir, name), { force: true })
}
