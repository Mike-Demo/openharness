import { afterEach, describe, expect, it, vi } from 'vitest'
import { setProcessTableSource } from '../processTable.js'
import { TASKKILL_NOT_FOUND, TASKKILL_TIMEOUT_MS, taskkillArgs, taskkillTree, treeKill, type TaskkillRun } from './treeKill.js'

const ROW = { pid: 9, parentPid: 1, executable: 'x', startMarker: 'w:2', args: '' }

/** A `taskkill` that exits with [code] (0: success), recording what it was asked. */
const exiting = (code: number | string | null) => vi.fn<TaskkillRun>((_file, _args, _options, done) => {
  done(code === 0 ? null : Object.assign(new Error(`taskkill exited ${code}`), { code }))
})

afterEach(() => setProcessTableSource(null))

describe('treeKill', () => {
  it('does not kill a recycled pid', async () => {
    const run = vi.fn<TaskkillRun>()
    setProcessTableSource(async () => [ROW])
    expect(await treeKill({ pid: 9, executable: 'x', startMarker: 'w:1' }, { graceful: false }, run)).toBe('gone')
    expect(run).not.toHaveBeenCalled()
  })

  it('kills nothing when the table cannot be read', async () => {
    const run = vi.fn<TaskkillRun>()
    setProcessTableSource(async () => null)
    expect(await treeKill({ pid: 9, executable: 'x', startMarker: 'w:2' }, { graceful: false }, run)).toBe('failed')
    expect(run).not.toHaveBeenCalled()
  })

  it('ends the tree of the same process: gracefully, or by force', async () => {
    setProcessTableSource(async () => [ROW])
    const graceful = exiting(0)
    expect(await treeKill({ pid: 9, executable: 'x', startMarker: 'w:2' }, { graceful: true }, graceful)).toBe('sent')
    expect(graceful).toHaveBeenCalledWith('taskkill', ['/PID', '9', '/T'], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, expect.any(Function))
    const forced = exiting(0)
    expect(await treeKill({ pid: 9, executable: 'x', startMarker: 'w:2' }, { graceful: false }, forced)).toBe('sent')
    expect(forced.mock.calls[0]![1]).toEqual(['/PID', '9', '/T', '/F'])
  })
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
