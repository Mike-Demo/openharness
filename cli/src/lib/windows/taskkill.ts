// Adapted from stablyai/orca src/main/windows-process-tree-kill.ts (MIT). See THIRD_PARTY_NOTICES.md.
/**
 * Ending a process and everything it started, on Windows: `taskkill /PID <pid> /T`, with `/F` for a SIGKILL.
 * Windows has no signals; `taskkill` without `/F` asks the process's windows to close, and `/T` takes its
 * descendants with it.
 *
 * `taskkillTree` is the bare call, for the agent signaller (ptyHostBackend.ts), whose caller
 * (`terminateDeletedAgent`, a restart or swap) has just checked the process's identity itself.
 */
import { execFile } from 'node:child_process'

/** Orca's bound: a wedged `taskkill` must not hold its caller for ever. */
export const TASKKILL_TIMEOUT_MS = 5_000
/** `taskkill`'s exit code for a process that is not there. */
export const TASKKILL_NOT_FOUND = 128

/** `execFile`'s shape, as far as this uses it: the error's `code` is the exit code. */
export type TaskkillRun = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  done: (error: (Error & { code?: number | string | null }) | null) => void,
) => unknown

/** What became of a request: `sent` (taskkill took it), `gone` (nothing to end), `failed` (it may still run). */
export type TreeKillOutcome = 'sent' | 'gone' | 'failed'

export function taskkillArgs(pid: number, force: boolean): string[] {
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
}

/** `taskkill` on [pid]'s tree, without looking first. Never rejects. */
export function taskkillTree(pid: number, force: boolean, run: TaskkillRun = execFile as unknown as TaskkillRun): Promise<TreeKillOutcome> {
  // Orca's rule: never this process (that would end the daemon), never a pid that cannot be one.
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return Promise.resolve('failed')
  return new Promise((resolve) => {
    try {
      run('taskkill', taskkillArgs(pid, force), { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (!error) resolve('sent')
        else resolve(error.code === TASKKILL_NOT_FOUND ? 'gone' : 'failed')
      })
    } catch {
      resolve('failed')
    }
  })
}
