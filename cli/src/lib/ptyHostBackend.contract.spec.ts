// The terminal contract and the host-connection lifecycle against the real Harness PTY host. Build it first, then:
//   cd pty && cargo +stable build
//   cd cli && HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npm run test:terminal-contract
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyHostBackend } from './ptyHostBackend.js'
import { readDiscovery } from './ptyHost/launch.js'
import { PTY_PROTOCOL } from './ptyHost/protocol.js'
import { removeTree, runTerminalBackendContract, SHELL } from './terminalBackend.contract.js'
import type { PtyRuntimeRef, TerminalInventoryResult } from './terminalTypes.js'

const enabled = process.env.RUN_TERMINAL_CONTRACT === '1' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = process.platform === 'win32' ? 40_000 : 15_000

/** A fresh `--home`: a host of its own, never the user's. */
const freshHome = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** Stop the host serving [home] (its panes go with it) and remove the home. */
async function stopHost(home: string): Promise<void> {
  const pid = readDiscovery(home, PTY_PROTOCOL)?.pid
  if (pid) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  await removeTree(home)
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = process.platform === 'win32' ? 20_000 : 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Wait until the shell in [runtime] has drawn something. On Windows a shell that is still starting when its host dies
 * outlives the host (its console does not end), and would keep the home open.
 */
async function started(backend: PtyHostBackend, runtime: PtyRuntimeRef): Promise<void> {
  const shown = await until(async () => {
    const read = await backend.capture(runtime, { mode: 'visible', ansi: false })
    return read.state === 'succeeded' ? read.value : ''
  }, (text) => text.trim().length > 0)
  if (!shown.trim()) throw new Error('the shell drew nothing')
}

/** A backend on a host of its own in [home], ready; one that is not fails saying why, and leaves no host. */
async function readyBackend(home: string): Promise<PtyHostBackend> {
  const backend = new PtyHostBackend({ home })
  const prepared = await backend.prepare({ ownedPanes: new Map() }).catch(async (error: unknown) => {
    backend.dispose()
    await stopHost(home)
    throw new Error(`ptyhost contract: prepare threw: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (prepared.state !== 'ready') {
    backend.dispose()
    await stopHost(home)
    throw new Error(`ptyhost contract: the host is unavailable (${prepared.code}): ${prepared.reason}`)
  }
  return backend
}

;(enabled ? runTerminalBackendContract : () => describe.skip('ptyhost contract', () => {}))('ptyhost', async () => {
  const home = freshHome('pty-contract-')
  const backend = await readyBackend(home)
  return { backend, cleanup: async () => { backend.dispose(); await stopHost(home) } }
})

;(enabled ? describe : describe.skip)('ptyhost lifecycle', () => {
  it('host death makes the backend unavailable, then a reconnect reaches a new host without the old panes', async () => {
    const home = freshHome('pty-death-')
    const backend = await readyBackend(home)
    try {
      const replaced: number[] = []
      backend.onHostReplaced = () => replaced.push(Date.now())
      const created = await backend.create({ command: SHELL })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      await started(backend, created.runtime)
      const before = readDiscovery(home, PTY_PROTOCOL)!
      process.kill(before.pid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Disconnected: unavailable, never an empty listing (which would read as every pane gone).
      expect((await backend.inventory()).state).toBe('unavailable')
      // The reconnect, 1 s after the loss, starts a new host: it has no panes.
      const inventory = await until<TerminalInventoryResult>(() => backend.inventory(), (inv) => inv.state === 'available')
      expect(inventory).toEqual({ state: 'available', roots: [] })
      expect(readDiscovery(home, PTY_PROTOCOL)!.pid).not.toBe(before.pid)
      expect(replaced).toHaveLength(1)
      expect(await backend.paneState(created.runtime)).toBe('gone')
      // The new host never hands out an id the dead one used: the old runtime cannot name a new pane.
      const fresh = await backend.create({ command: SHELL })
      if (fresh.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(fresh)}`)
      expect(fresh.runtime.paneId).not.toBe(created.runtime.paneId)
      expect(Number(fresh.runtime.paneId.slice(1))).toBeGreaterThan(Number(created.runtime.paneId.slice(1)))
      expect(await backend.paneState(created.runtime)).toBe('gone')
      expect((await backend.kill(fresh.runtime)).state).toBe('succeeded')
    } finally {
      backend.dispose()
      await stopHost(home)
    }
  }, CASE_TIMEOUT_MS)

  it('a restarted daemon reattaches to the host and finds its pane', async () => {
    const home = freshHome('pty-reattach-')
    const first = await readyBackend(home)
    let second: PtyHostBackend | null = null
    try {
      const created = await first.create({ command: SHELL })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      await started(first, created.runtime)
      first.dispose() // the daemon exiting: the host and its pane stay
      second = await readyBackend(home) // the restarted daemon
      const inventory = await second.inventory()
      expect(inventory.state === 'available' && inventory.roots.some((root) => root.runtime.paneId === created.runtime.paneId)).toBe(true)
      expect(await second.paneState(created.runtime)).toMatchObject({ dead: false })
      expect((await second.kill(created.runtime)).state).toBe('succeeded')
    } finally {
      first.dispose()
      second?.dispose()
      await stopHost(home)
    }
  }, CASE_TIMEOUT_MS)
})
