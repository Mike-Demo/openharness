import { describe, expect, it, vi } from 'vitest'
import { TASKKILL_NOT_FOUND, TASKKILL_TIMEOUT_MS, taskkillArgs, taskkillTree, type TaskkillRun } from './taskkill.js'

/** A `taskkill` that exits with [code] (0: success), recording what it was asked. */
const exiting = (code: number | string | null) => vi.fn<TaskkillRun>((_file, _args, _options, done) => {
  done(code === 0 ? null : Object.assign(new Error(`taskkill exited ${code}`), { code }))
})

describe('taskkillTree', () => {
  it('reads "not found" as gone, and any other failure as failed', async () => {
    expect(await taskkillTree(9, true, exiting(TASKKILL_NOT_FOUND))).toBe('gone')
    expect(await taskkillTree(9, true, exiting(1))).toBe('failed')
    expect(await taskkillTree(9, true, exiting('ENOENT'))).toBe('failed')
    expect(await taskkillTree(9, true, () => { throw new Error('spawn failed') })).toBe('failed')
  })

  it('never asks for this process or a pid that cannot be one', async () => {
    const run = exiting(0)
    for (const pid of [process.pid, 0, -1, 1.5]) expect(await taskkillTree(pid, true, run)).toBe('failed')
    expect(run).not.toHaveBeenCalled()
  })

  it('spells the arguments as taskkill takes them', () => {
    expect(taskkillArgs(42, false)).toEqual(['/PID', '42', '/T'])
    expect(taskkillArgs(42, true)).toEqual(['/PID', '42', '/T', '/F'])
  })
})
