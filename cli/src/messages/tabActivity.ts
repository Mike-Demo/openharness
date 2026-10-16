/**
 * A shared tab's working state across accounts (1c spec, seam 1): another account's harness in a tab shows its spinner
 * in the tab row, which the observer channel never fed (step 0). Each daemon sends its own listed harnesses' state to
 * the tab's machines of other accounts on a change, and renews working before the receiver's lease runs out.
 */
export type ActivityState = 'working' | 'idle' | 'unknown'
export type SharedActivity = { sharedTabId: string; machineId: string; agentId: string; state: ActivityState; validForMs: number }
export const ACTIVITY_RENEW_MS = 20_000
/** As long as the core's own working lease (lib/turnActivity.ts WORK_EVIDENCE_MS): a sender that went away is not
 *  shown working for longer than its own windows would show it. */
export const ACTIVITY_LEASE_MS = 30_000
/** A machine that answered `activity` with an unknown action (a 1b daemon) is not asked again for this long. */
export const ACTIVITY_REFUSED_MS = 10 * 60_000
const FRAME_MS = 1_000, AGENTS_MAX = 64
const STATES = new Set<ActivityState>(['working', 'idle', 'unknown'])

export class ActivityOut {
  private sent = new Map<string, Map<string, { state: ActivityState; at: number }>>()
  private refusedAt = new Map<string, number>()
  due(sharedTabId: string, now: number, current: Record<string, ActivityState>): Array<{ agentId: string; state: ActivityState }> {
    const last = this.sent.get(sharedTabId) ?? new Map<string, { state: ActivityState; at: number }>()
    this.sent.set(sharedTabId, last)
    const out: Array<{ agentId: string; state: ActivityState }> = []
    for (const [agentId, state] of Object.entries(current)) {
      const was = last.get(agentId)
      if (was && was.state === state && (state !== 'working' || now - was.at < ACTIVITY_RENEW_MS)) continue
      last.set(agentId, { state, at: now })
      out.push({ agentId, state })
    }
    return out.slice(0, AGENTS_MAX)
  }
  refused(sharedTabId: string, machineId: string, now: number): void { this.refusedAt.set(`${sharedTabId} ${machineId}`, now) }
  refusing(sharedTabId: string, machineId: string, now: number): boolean {
    const at = this.refusedAt.get(`${sharedTabId} ${machineId}`)
    return at !== undefined && now - at < ACTIVITY_REFUSED_MS
  }
  forget(sharedTabId: string): void { this.sent.delete(sharedTabId) }
  /** Forget every tab but these: those left, removed or revoked. */
  prune(held: ReadonlySet<string>): void { for (const id of [...this.sent.keys()]) if (!held.has(id)) this.forget(id) }
}

export class ActivityIn {
  private heard = new Map<string, { activity: SharedActivity; at: number }>()
  private lastFrame = new Map<string, number>()
  take(sharedTabId: string, machineId: string, agents: unknown, listed: (agentId: string) => boolean, now: number): SharedActivity[] {
    const k = `${sharedTabId} ${machineId}`
    const last = this.lastFrame.get(k)
    if (last !== undefined && now - last < FRAME_MS) return []
    this.lastFrame.set(k, now)
    if (!Array.isArray(agents)) return []
    const taken: SharedActivity[] = []
    for (const a of agents.slice(0, AGENTS_MAX)) {
      if (!a || typeof a !== 'object') continue
      const { agentId, state } = a as Record<string, unknown>
      if (typeof agentId !== 'string' || !STATES.has(state as ActivityState) || !listed(agentId)) continue
      const activity: SharedActivity = { sharedTabId, machineId, agentId, state: state as ActivityState, validForMs: state === 'working' ? ACTIVITY_LEASE_MS : 0 }
      this.heard.set(`${k} ${agentId}`, { activity, at: now })
      taken.push(activity)
    }
    return taken
  }
  /** What the windows should show now: working harnesses whose lease has not run out, with what is left of it. */
  snapshot(now: number): SharedActivity[] {
    return [...this.heard.values()].flatMap(({ activity, at }) => {
      const left = ACTIVITY_LEASE_MS - (now - at)
      return activity.state === 'working' && left > 0 ? [{ ...activity, validForMs: left }] : []
    })
  }
  forget(sharedTabId: string): void {
    for (const k of [...this.heard.keys()]) if (k.startsWith(`${sharedTabId} `)) this.heard.delete(k)
    for (const k of [...this.lastFrame.keys()]) if (k.startsWith(`${sharedTabId} `)) this.lastFrame.delete(k)
  }
  /** Forget every tab but these: those left, removed or revoked. */
  prune(held: ReadonlySet<string>): void {
    for (const id of new Set([...this.heard.keys(), ...this.lastFrame.keys()].map((k) => k.slice(0, k.indexOf(' '))))) if (!held.has(id)) this.forget(id)
  }
}
