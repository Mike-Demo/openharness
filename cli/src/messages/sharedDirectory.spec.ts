import { describe, expect, it, vi } from 'vitest'
import { consentKey } from './consentStore.js'
import { MessageDirectory, type DirectoryTab } from './directory.js'
import { header, parseMessage, type Message } from './model.js'
import type { Roster } from './roster.js'
import { accountLabel, accountsIn, sharedTabsFor } from './sharedDirectory.js'

/* The directory's side of shared tabs (sharedDirectory.ts): the rosters this computer holds, merged into the account's
 * desk tabs, and the words other accounts are named by. */

const KEY = 'A'.repeat(43) + '='
const OWN = 'a'.repeat(24), THEIRS = 'c'.repeat(24)
const at = '2026-10-15T00:00:00.000Z'
const harness = (accountId: string, machineId: string, agentId: string, name = agentId, engine = 'claude') =>
  ({ accountId, machineId, machinePublicKey: KEY, agentId, name, engine })

/** Alice's tab `app`, shared with Bob and Carol, each with a harness named `api`. */
const owned: Roster = {
  sharedTabId: OWN, version: 4, name: 'app', leader: null, invites: [],
  owner: { accountId: 'u-alice', email: 'alice@x.io', machineId: 'm1', machinePublicKey: KEY },
  members: [{ accountId: 'u-bob', email: 'bob@y.io', name: 'Bob', acceptedAt: at }, { accountId: 'u-carol', email: 'carol@z.io', name: '', acceptedAt: at }],
  harnesses: [harness('u-alice', 'm1', 'lead', 'lead', 'codex'), harness('u-bob', 'mb', 'api'), harness('u-carol', 'mc', 'api', 'api', 'codex')],
}
/** Dave's tab `ops`, which Alice is a member of. */
const member: Roster = {
  sharedTabId: THEIRS, version: 2, name: 'ops', leader: null, invites: [],
  owner: { accountId: 'u-dave', email: 'dave@w.io', machineId: 'md', machinePublicKey: KEY },
  members: [{ accountId: 'u-alice', email: 'alice@x.io', name: 'Alice', acceptedAt: at }],
  harnesses: [harness('u-dave', 'md', 'ops-lead'), harness('u-alice', 'm1', 'lead', 'lead', 'codex'), harness('u-dave', 'md', 'ops-lead')],
}
const desk = (): DirectoryTab[] => [
  { id: 'app', name: 'app', named: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'phone' }] },
  { id: 'notes', name: 'New Tab', named: false, panes: [{ machineId: 'm1', agentId: 'lead' }] },
]
/** Alice's account on m1, with its machines as its directory lists them, and her lead in Dave's tab, which m1 asked for. */
const ALICE = { accountId: 'u-alice', machineId: 'm1', machineIds: new Set(['m1', 'm2']), consent: new Set([consentKey(THEIRS, 'm1', 'lead')]) }

describe('shared tabs in the directory', () => {
  it('the owner\'s desk tab gains the other accounts\' harnesses, each with its account, name and engine; its own are not repeated', () => {
    const before = desk()
    const tabs = sharedTabsFor([owned], ALICE, (id) => (id === OWN ? 'app' : null), before)
    expect(tabs).toEqual([
      { id: 'app', name: 'app', named: true, sharedTabId: OWN, panes: [
        { machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'phone' },
        { machineId: 'mb', agentId: 'api', accountId: 'u-bob', name: 'api', engine: 'claude' },
        { machineId: 'mc', agentId: 'api', accountId: 'u-carol', name: 'api', engine: 'codex' },
      ] },
      before[1],
    ])
    // The desk as read is left as it was: the next merge starts from it again.
    expect(before[0].panes).toHaveLength(2)
    expect(before[0]).not.toHaveProperty('sharedTabId')
  })

  it('an own tab whose desk tab is not known here, or not on the desk, adds nothing', () => {
    expect(sharedTabsFor([owned], ALICE, () => null, desk())).toEqual(desk())
    expect(sharedTabsFor([owned], ALICE, () => 'gone', desk())).toEqual(desk())
  })

  it('a member\'s tab is a tab of its own, named as its owner named it, with every harness of the roster once', () => {
    const tabs = sharedTabsFor([member], ALICE, () => null, desk())
    expect(tabs).toEqual([...desk(), { id: THEIRS, sharedTabId: THEIRS, name: 'ops', named: true, panes: [
      { machineId: 'md', agentId: 'ops-lead', accountId: 'u-dave', name: 'ops-lead', engine: 'claude' },
      { machineId: 'm1', agentId: 'lead', accountId: 'u-alice', name: 'lead', engine: 'codex' },
    ] }])
    // A roster with no name is a tab the person never named.
    expect(sharedTabsFor([{ ...member, name: '' }], ALICE, () => null, [])[0]).toMatchObject({ name: '', named: false })
  })

  it('in another account\'s tab, this machine\'s harness is in it only as this machine asked: re-listed by the owner, it is not', () => {
    const asked = (consent: string[]) => ({ ...ALICE, consent: new Set(consent) })
    const panes = (consent: string[], roster = member) => sharedTabsFor([roster], asked(consent), () => null, [])[0].panes.map((p) => `${p.machineId}/${p.agentId}`)
    // Taken out here (no consent) while the owner's roster still lists it, or listed again by the owner: not in the tab.
    expect(panes([])).toEqual(['md/ops-lead'])
    expect(panes([consentKey('d'.repeat(24), 'm1', 'lead')])).toEqual(['md/ops-lead'])
    expect(panes([consentKey(THEIRS, 'm1', 'lead')])).toEqual(['md/ops-lead', 'm1/lead'])
    // Another machine of this account answers for its own harnesses; nothing here holds them back.
    const laptop: Roster = { ...member, harnesses: [...member.harnesses, harness('u-alice', 'm2', 'phone')] }
    expect(panes([], laptop)).toEqual(['md/ops-lead', 'm2/phone'])
    // The tab this account owns needs no asking: its harnesses come from its own desk.
    expect(sharedTabsFor([owned], asked([]), () => 'app', desk())[0].panes).toContainEqual({ machineId: 'm1', agentId: 'lead' })
  })

  it('shows no character that could redraw a terminal or pass one name for another', () => {
    const sly: Roster = { ...member, name: 'o‮ps\u0007', harnesses: [harness('u-dave', 'md', 'x', 'a​pi\u001b[2J', 'co\u0000dex')] }
    expect(sharedTabsFor([sly], ALICE, () => null, [])[0]).toMatchObject({ name: 'ops', panes: [{ name: 'api[2J', engine: 'codex' }] })
  })
})

describe('another account\'s harness is that account\'s only as a roster says', () => {
  /** The desk carries Bob's harness (mb/api) in the shared tab and, put there by a backend, in an unshared one. */
  const carried = (): DirectoryTab[] => [
    { id: 'app', name: 'app', named: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'mb', agentId: 'api' }] },
    { id: 'side', name: 'side', named: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'mb', agentId: 'api' }, { machineId: 'm2', agentId: 'phone' }] },
  ]

  it('a roster\'s entry replaces the desk\'s pane, with its account; a desk pane on another account\'s machine goes from every other tab', () => {
    expect(sharedTabsFor([owned], ALICE, () => 'app', carried())).toEqual([
      { id: 'app', name: 'app', named: true, sharedTabId: OWN, panes: [{ machineId: 'm1', agentId: 'lead' },
        { machineId: 'mb', agentId: 'api', accountId: 'u-bob', name: 'api', engine: 'claude' },
        { machineId: 'mc', agentId: 'api', accountId: 'u-carol', name: 'api', engine: 'codex' }] },
      { id: 'side', name: 'side', named: true, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'phone' }] },
    ])
  })

  it('a desk pane alone never makes another account\'s harness a teammate; with an account, only a roster\'s entry under it counts', async () => {
    let deskTab: string | null = null
    const lead = { machineId: 'm1', agentId: 'lead' }, bob = { machineId: 'mb', agentId: 'api' }
    const directory = new MessageDirectory({ extra: (tabs) => sharedTabsFor([owned], ALICE, () => deskTab, tabs),
      read: async () => ({ revision: 1, machines: [], tabs: carried() }) })
    await directory.refresh(true)
    // The shares not read yet: the roster adds nothing, and the desk's word for Bob's harness counts for nothing either.
    expect(directory.peers(lead)).toEqual([{ machineId: 'm2', agentId: 'phone' }])
    expect(directory.shared(bob, lead)).toBeNull()
    deskTab = 'app'
    directory.rebuild()
    expect(directory.shared(bob, lead, 'u-bob')).toMatchObject({ id: 'app', sharedTabId: OWN })
    expect(directory.shared(bob, lead, 'u-carol')).toBeNull()
    expect(directory.tabsOf(bob, 'u-bob').map((t) => t.id)).toEqual(['app'])
    // This account's own harnesses carry no account: asked under one, they are in no tab.
    expect(directory.shared({ machineId: 'm2', agentId: 'phone' }, lead)).toMatchObject({ id: 'side' })
    expect(directory.shared({ machineId: 'm2', agentId: 'phone' }, lead, 'u-bob')).toBeNull()
  })
})

describe('this account\'s machines are its own, whatever a roster says', () => {
  /** Rosters that list Alice's laptop (m2) under Bob's account: one she shares, one she is a member of. */
  const claim = harness('u-bob', 'm2', 'x')
  const lying = [{ ...owned, harnesses: [...owned.harnesses, claim] }, { ...member, harnesses: [...member.harnesses, claim] }]

  it('keeps the desk\'s panes on such a machine in every tab, and takes no entry under another account on it', () => {
    const tabs = sharedTabsFor(lying, ALICE, () => 'app', desk())
    expect(tabs.find((t) => t.id === 'app')!.panes.map((p) => `${p.accountId ?? ''}:${p.machineId}/${p.agentId}`))
      .toEqual([':m1/lead', ':m2/phone', 'u-bob:mb/api', 'u-carol:mc/api'])
    expect(tabs.find((t) => t.id === THEIRS)!.panes.map((p) => `${p.machineId}/${p.agentId}`)).toEqual(['md/ops-lead', 'm1/lead'])
  })

  it('the directory gives the machines it read with the desk, this computer\'s besides', async () => {
    const lead = { machineId: 'm1', agentId: 'lead' }
    const directory = new MessageDirectory({
      extra: (tabs, machines) => sharedTabsFor(lying, { ...ALICE, machineIds: new Set(['m1', ...machines.keys()]) }, () => 'app', tabs),
      read: async () => ({ revision: 1, machines: [{ machineId: 'm2', name: 'laptop' }], tabs: desk() }) })
    await directory.refresh(true)
    expect(directory.shared({ machineId: 'm2', agentId: 'phone' }, lead)).toMatchObject({ id: 'app' })
    expect(directory.shared({ machineId: 'm2', agentId: 'x' }, lead)).toBeNull()
  })
})

describe('accounts\' names', () => {
  it('labels an account by its address\'s local part, for prefixes', () => {
    expect(accountLabel('bob@y.io')).toBe('bob')
    expect(accountLabel('first.last+x@y.io')).toBe('first.last+x')
    expect(accountLabel('a@b@c.io')).toBe('a@b')
    expect(accountLabel('nobody')).toBe('nobody')
    expect(accountLabel('b‮ob\u0007@y.io')).toBe('bob')
    // An address with nothing before its @ still names something.
    expect(accountLabel('@y.io')).toBe('@y.io')
  })

  it('names each account of the rosters: its label for prefixes, and the member\'s name, else the label, for headers', () => {
    expect(accountsIn([owned, member])).toEqual(new Map([
      ['u-alice', { label: 'alice', name: 'Alice' }],
      ['u-bob', { label: 'bob', name: 'Bob' }],
      ['u-carol', { label: 'carol', name: 'carol' }],
      ['u-dave', { label: 'dave', name: 'dave' }],
    ]))
    expect(accountsIn([{ ...owned, members: [{ accountId: 'u-bob', email: 'bob@y.io', name: 'B​ob\u0007', acceptedAt: at }] }]).get('u-bob')).toEqual({ label: 'bob', name: 'Bob' })
  })
})

describe('the directory with shared tabs merged in', () => {
  it('merges them at every read and whenever a roster changes, and tells of a change only', async () => {
    let rosters: Roster[] = []
    const changed = vi.fn()
    const lead = { machineId: 'm1', agentId: 'lead' }
    const directory = new MessageDirectory({ changed, extra: (tabs) => sharedTabsFor(rosters, ALICE, () => 'app', tabs),
      read: async () => ({ revision: 1, machines: [], tabs: [{ id: 'app', name: 'app', panes: [lead] }] }) })
    // Nothing read yet: nothing to merge into.
    directory.rebuild()
    expect(directory.current()).toBeNull()
    await directory.refresh(true)
    expect(changed).toHaveBeenCalledTimes(1)
    directory.rebuild()
    expect(changed).toHaveBeenCalledTimes(1)
    // A roster taken: its harnesses are teammates, with no read of the desk.
    rosters = [owned]
    directory.rebuild()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(directory.peers(lead).map((m) => `${m.accountId}:${m.machineId}/${m.agentId}`)).toEqual(['u-bob:mb/api', 'u-carol:mc/api'])
    expect(directory.shared(lead, { machineId: 'mc', agentId: 'api' })).toMatchObject({ id: 'app', sharedTabId: OWN })
    await directory.refresh(true)
    expect(changed).toHaveBeenCalledTimes(2)
    // The tab left: a change at the next read, too.
    rosters = []
    await directory.refresh(true)
    expect(changed).toHaveBeenCalledTimes(3)
    expect(directory.peers(lead)).toEqual([])
  })
})

describe('a message\'s header', () => {
  const message = (from: Record<string, unknown>): Message => parseMessage({ id: 'm0000031', tabId: OWN, text: 'hi', at: 1,
    to: [{ machineId: 'm1', agentId: 'lead', name: 'lead' }], from: { machineId: 'ma', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'alice-studio', ...from } })!

  it('names the sending account when it is not the recipient\'s own, and only then', () => {
    const alice = message({ accountId: 'u-alice', account: 'Alice' })
    expect(alice.from).toMatchObject({ accountId: 'u-alice', account: 'Alice' })
    expect(header(alice, 'u-bob')).toBe('[m0000031 from lead · Alice\'s account · Codex · alice-studio]')
    expect(header(alice, 'u-alice')).toBe('[m0000031 from lead · Codex · alice-studio]')
    // A message of this account's own machines names no account.
    expect(header(message({}), 'u-bob')).toBe('[m0000031 from lead · Codex · alice-studio]')
    // What is not a field of its kind is not taken.
    expect(message({ accountId: 7, account: 'x'.repeat(201) }).from).not.toHaveProperty('accountId')
    expect(message({ accountId: '', account: '' }).from).not.toHaveProperty('account')
  })

  it('shows no character in any field that could redraw a terminal or pass one name for another', () => {
    const sly = message({ name: 'le\u200bad\u001b[2J', engine: 'co\u0007dex', machine: 'alice\u202e-studio', accountId: 'u-alice', account: 'Al\u0000ice' })
    expect(header(sly, 'u-bob')).toBe('[m0000031 from lead[2J · Alice\'s account · Codex · alice-studio]')
  })
})
