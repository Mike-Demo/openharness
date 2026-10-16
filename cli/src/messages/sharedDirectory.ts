/**
 * Shared tabs in the directory (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages
 * across accounts"): the rosters this computer holds, verified against their pins (rosterStore.ts), merged into the
 * account's desk tabs, so another account's harness is a teammate like any other. A tab this account shares gains the
 * members' harnesses; a tab shared with this account is a tab of its own, as its owner named it.
 *
 * Only what the roster says is shown, and only after taking out control and format characters: a member's name, an
 * engine and an owner's address are not cleaned where a roster is read (roster.ts cleans only harness names), and each
 * ends up in a note or a message's header an agent reads.
 */
import { consentKey } from './consentStore.js'
import type { DirectoryTab, Member } from './directory.js'
import { cleanName, type Roster, type RosterHarness } from './roster.js'

/** An account as its address names it: the part before the @, for prefixes (`bob/api`). The whole address when that
 *  part is empty, so a label is never blank. */
export function accountLabel(email: string): string {
  return cleanName(email.replace(/@[^@]*$/, '')) || cleanName(email)
}

/** The accounts the rosters name: each one's label for prefixes, and for headers the name a roster gives it as a
 *  member (`Bob's account`), or its label where none does (an owner, a member with no name). */
export function accountsIn(rosters: readonly Roster[]): Map<string, { label: string; name: string }> {
  const out = new Map<string, { label: string; name: string }>()
  const put = (accountId: string, email: string, name: string): void => {
    const label = out.get(accountId)?.label ?? accountLabel(email)
    out.set(accountId, { label, name: cleanName(name) || out.get(accountId)?.name || label })
  }
  for (const roster of rosters) {
    put(roster.owner.accountId, roster.owner.email, '')
    for (const m of roster.members) put(m.accountId, m.email, m.name)
  }
  return out
}

const pane = (h: RosterHarness): Member => ({ machineId: h.machineId, agentId: h.agentId, accountId: h.accountId, name: cleanName(h.name), engine: cleanName(h.engine) })
const add = (panes: Member[], next: Member): void => {
  if (!panes.some((p) => p.machineId === next.machineId && p.agentId === next.agentId)) panes.push(next)
}

/**
 * The desk tabs with the shared tabs merged in; `desk` itself is left as read. A roster this account owns adds the other
 * accounts' harnesses to the desk tab it is shared from (`deskTab`), whose own panes the desk already lists: the desk is
 * the account's word for its own harnesses, and the roster only follows it. A tab whose desk tab is not known here yet
 * (the shares not read since a restart) adds nothing until it is. A roster of another account's is a tab of its own.
 *
 * Another account's harness is that account's only as a roster says, never as the desk does: a desk pane on a machine a
 * held roster lists under another account is dropped from every desk tab, and that harness is in a tab only as its
 * roster's entry, with its account. The desk carries other accounts' panes to show them (the spec's "Open questions",
 * 1), and a backend that put Bob's harness into an unshared tab beside one of this account's would otherwise make the
 * two teammates as if Bob's were this account's own (review of B1).
 *
 * A machine of this account's (`self.machineIds`: this computer and the machines its directory lists, as the member's
 * own check trusts them, sharedTabs.ts `checkOwn`) is never another account's, whatever a roster says: a tab's owner,
 * another account, could otherwise list one under its account and silently take every pane of it from this account's
 * own tabs. Such an entry is left out of the tabs too, and `checkOwn` records it for the person (review of B1).
 *
 * In a tab another account owns, a harness of this machine (`self.machineId`) is in it only if this machine asked for it
 * (`self.consent`, consentStore.ts keys): the owner signs the roster and can keep listing one the member took out while
 * the owner's computer was away, or list it again (final review of 1b). Left out, it has no shared tab's note or
 * teammates there, sends nothing into it, and what waits for it is held and then fails (service.ts `verdict`). Another
 * machine of this account answers for its own harnesses the same way, on that machine.
 */
export function sharedTabsFor(rosters: readonly Roster[], self: { accountId: string; machineId: string; machineIds: ReadonlySet<string>; consent: ReadonlySet<string> },
  deskTab: (id: string) => string | null, desk: readonly DirectoryTab[]): DirectoryTab[] {
  const foreign = (h: RosterHarness): boolean => h.accountId !== self.accountId && !self.machineIds.has(h.machineId)
  const theirs = new Set(rosters.flatMap((r) => r.harnesses.filter(foreign).map((h) => h.machineId)))
  const tabs = desk.map((t) => ({ ...t, panes: t.panes.filter((p) => !theirs.has(p.machineId)) }))
  for (const roster of rosters) {
    if (roster.owner.accountId === self.accountId) {
      const id = deskTab(roster.sharedTabId)
      const tab = tabs.find((t) => t.id === id)
      if (!tab) continue
      tab.sharedTabId = roster.sharedTabId
      for (const h of roster.harnesses) if (foreign(h)) add(tab.panes, pane(h))
      continue
    }
    const panes: Member[] = []
    const asked = (h: RosterHarness): boolean => h.machineId !== self.machineId || self.consent.has(consentKey(roster.sharedTabId, h.machineId, h.agentId))
    for (const h of roster.harnesses) if ((h.accountId === self.accountId && asked(h)) || foreign(h)) add(panes, pane(h))
    const name = cleanName(roster.name)
    tabs.push({ id: roster.sharedTabId, sharedTabId: roster.sharedTabId, name, named: name !== '', panes })
  }
  return tabs
}
