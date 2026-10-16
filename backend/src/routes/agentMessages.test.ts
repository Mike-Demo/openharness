import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  prisma: { desk: { findUnique: vi.fn() }, machine: { findMany: vi.fn() },
    agentMessageTab: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn() } },
  auth: vi.fn(),
  publish: vi.fn(),
  shareChanged: vi.fn(),
  shares: { putRoster: vi.fn(), listShares: vi.fn(), invite: vi.fn(), revokeInvite: vi.fn(), pendingInvites: vi.fn(), accept: vi.fn(),
    removeMember: vi.fn(), stopSharing: vi.fn(), moveShare: vi.fn(), shareOwner: vi.fn(), shareMemberIds: vi.fn(), accountIdByEmail: vi.fn() },
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishDeskChanged: mocks.publish, publishAgentMessageShareChanged: mocks.shareChanged }))
vi.mock('../lib/agentMessageShares.js', () => mocks.shares)
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { agentMessagesRoutes } from './agentMessages.js'
import { agentMessageTabId } from '../lib/agentMessages.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

describe('Agent Messages per tab', () => {
  let app: FastifyInstance
  const tab = { id: 'app', name: 'App', nameIsCustom: true, panes: [{ machineId: 'shared', agentId: 'observer' }, { machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'api' }] }
  const other = { id: 'notes', name: 'Notes', panes: [{ machineId: 'm1', agentId: 'writer' }] }
  const auth = { authorization: 'Bearer fixture' }
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ sub: 'owner', email: 'fixture@example.com', role: 'user', autonomousEnv: 'prod' })
    mocks.prisma.desk.findUnique.mockResolvedValue({ revision: 8, tabs: [tab, other] })
    mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }])
    mocks.prisma.agentMessageTab.findMany.mockResolvedValue([])
    mocks.prisma.agentMessageTab.upsert.mockImplementation(async ({ create }) => create)
    mocks.publish.mockResolvedValue(0); mocks.shareChanged.mockResolvedValue(0)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(agentMessagesRoutes); await app.ready()
  })
  afterEach(async () => app.close())
  const read = () => app.inject({ method: 'GET', url: '/api/agent-messages', headers: auth })
  const set = (tabId: string, body: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: 'PATCH', url: `/api/agent-messages/tabs/${tabId}`, headers, payload: body as object })

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/agent-messages' })).statusCode).toBe(401)
    expect((await set('app', { enabled: true }, {})).statusCode).toBe(401)
    expect(mocks.prisma.desk.findUnique).not.toHaveBeenCalled()
    expect(mocks.prisma.agentMessageTab.upsert).not.toHaveBeenCalled()
  })

  it('is off for every tab until a person turns one on, and lists only owned panes', async () => {
    const result = await read()
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({ revision: 8, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }], tabs: [
      { id: 'app', name: 'App', named: true, enabled: false, panes: [{ machineId: 'm1', agentId: 'lead' }, { machineId: 'm2', agentId: 'api' }] },
      { id: 'notes', name: 'Notes', named: false, enabled: false, panes: [{ machineId: 'm1', agentId: 'writer' }] },
    ] })
    expect(mocks.prisma.agentMessageTab.findMany).toHaveBeenCalledWith({ where: { userId: 'owner' }, select: { userId: true, tabId: true, enabled: true } })
  })

  it('reads each tab\'s own flag, and never another account\'s record', async () => {
    mocks.prisma.agentMessageTab.findMany.mockResolvedValue([
      { userId: 'owner', tabId: 'app', enabled: true },
      { userId: 'owner', tabId: 'notes', enabled: false },
      { userId: 'someone-else', tabId: 'notes', enabled: true },
    ])
    const tabs = (await read()).json().data.tabs
    expect(tabs.map((t: { id: string; enabled: boolean }) => [t.id, t.enabled])).toEqual([['app', true], ['notes', false]])
  })

  it('answers an empty desk with no tabs', async () => {
    mocks.prisma.desk.findUnique.mockResolvedValue(null)
    expect((await read()).json().data).toEqual({ revision: 0, machines: [{ machineId: 'm1', name: 'studio' }, { machineId: 'm2', name: null }], tabs: [] })
  })

  it('turns one tab on, at its own address, and has the account\'s daemons read again', async () => {
    const result = await set('app', { enabled: true })
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({ tabId: 'app', enabled: true, revision: 1 })
    expect(mocks.prisma.agentMessageTab.upsert).toHaveBeenCalledWith({ where: { id: agentMessageTabId('owner', 'app') },
      create: { id: agentMessageTabId('owner', 'app'), userId: 'owner', tabId: 'app', enabled: true, revision: 1 },
      update: { enabled: true, revision: { increment: 1 } } })
    expect(mocks.publish).toHaveBeenCalledWith('owner', { revision: 0 })
    expect(agentMessageTabId('owner', 'app')).toMatch(/^[0-9a-f]{24}$/)
    expect(agentMessageTabId('another', 'app')).not.toBe(agentMessageTabId('owner', 'app'))
  })

  it('converges when two first writes race', async () => {
    mocks.prisma.agentMessageTab.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'fixture' }))
    mocks.prisma.agentMessageTab.update.mockResolvedValue({ userId: 'owner', tabId: 'app', enabled: false, revision: 4 })
    expect((await set('app', { enabled: false })).json().data).toEqual({ tabId: 'app', enabled: false, revision: 4 })
  })

  it('refuses a malformed body or tab, and a record that is not this tab\'s', async () => {
    expect((await set('app', { enabled: 'yes' })).statusCode).toBe(400)
    expect((await set('app', { enabled: true, extra: 1 })).statusCode).toBe(400)
    expect((await set('bad.tab', { enabled: true })).statusCode).toBe(400)
    expect(mocks.prisma.agentMessageTab.upsert).not.toHaveBeenCalled()
    mocks.prisma.agentMessageTab.upsert.mockResolvedValue({ userId: 'someone-else', tabId: 'app', enabled: true, revision: 1 })
    expect((await set('app', { enabled: true })).statusCode).toBe(500)
    mocks.prisma.agentMessageTab.upsert.mockRejectedValue(new Error('database down'))
    expect((await set('app', { enabled: true })).statusCode).toBe(500)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  describe('shared tabs', () => {
    const SID = 'a'.repeat(24)
    const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = auth) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
    const body = { machineId: 'm1', version: 3, roster: { sig: 'x' } }
    const desk = () => mocks.publish.mock.calls.map(c => c[0]).sort()
    const expectTold = (ids: string[], shared = true) => {
      expect(desk()).toEqual([...ids].sort())
      for (const c of mocks.publish.mock.calls) expect(c[1]).toEqual({ revision: 0 })
      if (shared) expect(mocks.shareChanged).toHaveBeenCalledWith(SID); else expect(mocks.shareChanged).not.toHaveBeenCalled()
    }

    it('requires authentication on every route', async () => {
      for (const [m, u] of [['PUT', '/shares/t1/roster'], ['GET', '/shares'], ['POST', `/shares/${SID}/invites`], ['DELETE', '/invites/i1'],
        ['GET', '/invites'], ['POST', '/invites/i1/accept'], ['DELETE', `/shares/${SID}/members/bob`], ['DELETE', `/shares/${SID}`],
        ['POST', `/shares/${SID}/move`]] as const)
        expect((await call(m, `/api/agent-messages${u}`, undefined, {})).statusCode).toBe(401)
      expect(Object.values(mocks.shares).some(f => f.mock.calls.length)).toBe(false)
    })

    it('stores a roster and tells the owner, the members and the share', async () => {
      mocks.shares.putRoster.mockResolvedValue({ sharedTabId: SID, version: 3 })
      mocks.shares.shareMemberIds.mockResolvedValue(['bob', 'carol'])
      const r = await call('PUT', '/api/agent-messages/shares/t-1/roster', body)
      expect(r.statusCode).toBe(200)
      expect(r.json().data).toEqual({ sharedTabId: SID, version: 3 })
      expect(mocks.shares.putRoster).toHaveBeenCalledWith({ ownerUserId: 'owner', tabId: 't-1', machineId: 'm1', version: 3, roster: { sig: 'x' }, autonomousEnv: 'prod' })
      expect(mocks.shares.shareMemberIds).toHaveBeenCalledWith(SID)
      // A member whose machine the roster does not list yet hears of it only this way.
      expectTold(['owner', 'bob', 'carol'])
    })
    it.each([['FORBIDDEN', 403], ['ROSTER_TOO_LARGE', 413]])('maps a roster %s to %i', async (error, status) => {
      mocks.shares.putRoster.mockResolvedValue({ error })
      const r = await call('PUT', '/api/agent-messages/shares/t-1/roster', body)
      expect(r.statusCode).toBe(status)
      expect(r.json().error).toEqual({ code: error, message: expect.any(String) })
      expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.shareChanged).not.toHaveBeenCalled()
    })
    it('answers a stale roster 409 with the version held, for the owner\'s computer to sign past', async () => {
      mocks.shares.putRoster.mockResolvedValue({ error: 'STALE_ROSTER', version: 7 })
      const r = await call('PUT', '/api/agent-messages/shares/t-1/roster', body)
      expect(r.statusCode).toBe(409)
      expect(r.json()).toEqual({ success: false, error: { code: 'STALE_ROSTER', message: 'A newer roster is already shared.', version: 7 } })
      expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.shareChanged).not.toHaveBeenCalled()
    })
    it('answers a saved change as saved when telling who must re-read fails', async () => {
      // An app of its own whose requests log to `warn`: what was not told is logged, never answered.
      const warn = vi.fn()
      await app.close()
      app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
      app.addHook('onRequest', async (req) => { req.log = { warn } as never })
      await app.register(agentMessagesRoutes); await app.ready()
      const SAVED: Array<[() => void, 'GET' | 'PUT' | 'POST' | 'DELETE', string, object | undefined]> = [
        [() => mocks.shares.putRoster.mockResolvedValue({ sharedTabId: SID, version: 3 }), 'PUT', '/api/agent-messages/shares/t-1/roster', body],
        [() => mocks.shares.invite.mockResolvedValue({ id: 'i1' }), 'POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'bob@x.io', days: 7 }],
        [() => mocks.shares.revokeInvite.mockResolvedValue({ shareId: SID, email: 'bob@x.io' }), 'DELETE', '/api/agent-messages/invites/i1', undefined],
        [() => mocks.shares.accept.mockResolvedValue({ sharedTabId: SID }), 'POST', '/api/agent-messages/invites/i1/accept', undefined],
        [() => mocks.shares.removeMember.mockResolvedValue(true), 'DELETE', `/api/agent-messages/shares/${SID}/members/bob`, undefined],
        [() => mocks.shares.moveShare.mockResolvedValue({ sharedTabId: SID }), 'POST', `/api/agent-messages/shares/${SID}/move`, { machineId: 'm2' }],
      ]
      // Every lookup of who else to tell fails: each answers success, and still tells whom it knew and the share.
      mocks.shares.shareMemberIds.mockRejectedValue(new Error('database down'))
      mocks.shares.accountIdByEmail.mockRejectedValue(new Error('database down'))
      mocks.shares.shareOwner.mockRejectedValue(new Error('database down'))
      for (const [saved, method, url, payload] of SAVED) {
        saved()
        mocks.publish.mockClear(); mocks.shareChanged.mockClear()
        const r = await call(method, url, payload)
        expect(r.statusCode).toBe(200)
        expect(r.json().success).toBe(true)
        expect(mocks.publish).toHaveBeenCalledTimes(1)
        expect(mocks.shareChanged).toHaveBeenCalledWith(SID)
      }
      expect(warn).toHaveBeenCalledTimes(SAVED.length)
      // And a publish that fails, too.
      warn.mockClear()
      mocks.publish.mockRejectedValue(new Error('redis down')); mocks.shareChanged.mockRejectedValue(new Error('redis down'))
      mocks.shares.stopSharing.mockResolvedValue(true)
      mocks.shares.shareMemberIds.mockResolvedValue(['bob'])
      expect((await call('DELETE', `/api/agent-messages/shares/${SID}`)).statusCode).toBe(200)
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3))
    })
    it('refuses a malformed roster request', async () => {
      const put = (tab: string, b: unknown) => call('PUT', `/api/agent-messages/shares/${tab}/roster`, b as object)
      expect((await put('bad.tab', body)).statusCode).toBe(400)
      expect((await put('t'.repeat(65), body)).statusCode).toBe(400)
      for (const b of [{ ...body, version: 0 }, { ...body, version: 1.5 }, { ...body, version: 2 ** 60 }, { ...body, machineId: '' },
        { ...body, machineId: 'm'.repeat(201) }, { machineId: 'm1', version: 1 }, { ...body, roster: 'x' }, { ...body, roster: [1] }, { ...body, extra: 1 }])
        expect((await put('t-1', b)).statusCode).toBe(400)
      expect(mocks.shares.putRoster).not.toHaveBeenCalled()
    })

    it('lists the account\'s shares and invitations for its environment', async () => {
      mocks.shares.listShares.mockResolvedValue([{ sharedTabId: SID }])
      mocks.shares.pendingInvites.mockResolvedValue([{ id: 'i1' }])
      expect((await call('GET', '/api/agent-messages/shares')).json().data).toEqual({ shares: [{ sharedTabId: SID }] })
      expect(mocks.shares.listShares).toHaveBeenCalledWith('owner', 'prod')
      expect((await call('GET', '/api/agent-messages/invites')).json().data).toEqual({ invites: [{ id: 'i1' }] })
      expect(mocks.shares.pendingInvites).toHaveBeenCalledWith('fixture@example.com', 'prod')
    })

    it('invites for 7, 30 or 90 days, and tells the owner, the share and the invitee\'s account', async () => {
      mocks.shares.invite.mockResolvedValue({ id: 'i1' })
      mocks.shares.accountIdByEmail.mockResolvedValue('bob')
      const before = Date.now()
      const r = await call('POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'bob@x.io', days: 30 })
      expect(r.statusCode).toBe(200)
      expect(r.json().data).toEqual({ id: 'i1' })
      const arg = mocks.shares.invite.mock.calls[0][0]
      expect(arg).toMatchObject({ ownerUserId: 'owner', ownerEmail: 'fixture@example.com', sharedTabId: SID, email: 'bob@x.io', autonomousEnv: 'prod' })
      expect(arg.expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * 86_400_000)
      expect(arg.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86_400_000)
      expectTold(['owner', 'bob'])
      for (const days of [7, 90]) expect((await call('POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'bob@x.io', days })).statusCode).toBe(200)
    })
    it('invites an address with no account and tells only the owner', async () => {
      mocks.shares.invite.mockResolvedValue({ id: 'i1' })
      mocks.shares.accountIdByEmail.mockResolvedValue(null)
      expect((await call('POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'new@x.io', days: 7 })).statusCode).toBe(200)
      expectTold(['owner'])
    })
    it.each([['SELF_INVITE', 400], ['FORBIDDEN', 403], ['TAB_FULL', 409]])('maps an invitation %s to %i', async (error, status) => {
      mocks.shares.invite.mockResolvedValue({ error })
      const r = await call('POST', `/api/agent-messages/shares/${SID}/invites`, { email: 'bob@x.io', days: 7 })
      expect(r.statusCode).toBe(status)
      expect(mocks.publish).not.toHaveBeenCalled()
    })
    it('refuses a malformed invitation', async () => {
      const inv = (id: string, b: unknown) => call('POST', `/api/agent-messages/shares/${id}/invites`, b as object)
      for (const days of [1, 14, '7', undefined]) expect((await inv(SID, { email: 'bob@x.io', days })).statusCode).toBe(400)
      expect((await inv(SID, { email: 'not-an-email', days: 7 })).statusCode).toBe(400)
      expect((await inv(SID, { days: 7 })).statusCode).toBe(400)
      const bad = await inv('A'.repeat(24), { email: 'bob@x.io', days: 7 })
      expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('INVALID_TAB')
      expect((await inv('abc', { email: 'bob@x.io', days: 7 })).statusCode).toBe(400)
      expect(mocks.shares.invite).not.toHaveBeenCalled()
    })

    it('revokes an invitation and tells the owner, the share and the invitee\'s account', async () => {
      mocks.shares.revokeInvite.mockResolvedValue({ shareId: SID, email: 'bob@x.io' })
      mocks.shares.accountIdByEmail.mockResolvedValue('bob')
      const r = await call('DELETE', '/api/agent-messages/invites/i1')
      expect(r.json().data).toEqual({ revoked: true })
      expect(mocks.shares.revokeInvite).toHaveBeenCalledWith('owner', 'i1')
      expect(mocks.shares.accountIdByEmail).toHaveBeenCalledWith('bob@x.io')
      expectTold(['owner', 'bob'])
    })
    it('revokes an invitation to an address with no account and tells only the owner and the share', async () => {
      mocks.shares.revokeInvite.mockResolvedValue({ shareId: SID, email: 'new@x.io' })
      mocks.shares.accountIdByEmail.mockResolvedValue(null)
      expect((await call('DELETE', '/api/agent-messages/invites/i1')).statusCode).toBe(200)
      expectTold(['owner'])
    })
    it('says a revoked or unknown invitation is gone', async () => {
      mocks.shares.revokeInvite.mockResolvedValue(null)
      expect((await call('DELETE', '/api/agent-messages/invites/i1')).statusCode).toBe(404)
      expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.shareChanged).not.toHaveBeenCalled()
    })

    it('accepts with the signed-in user and tells that user and the owner', async () => {
      mocks.shares.accept.mockResolvedValue({ sharedTabId: SID })
      mocks.shares.shareOwner.mockResolvedValue('alice')
      const r = await call('POST', '/api/agent-messages/invites/i1/accept')
      expect(r.json().data).toEqual({ sharedTabId: SID })
      expect(mocks.shares.accept).toHaveBeenCalledWith(expect.objectContaining({ sub: 'owner', email: 'fixture@example.com', autonomousEnv: 'prod' }), 'i1')
      expect(mocks.shares.shareOwner).toHaveBeenCalledWith(SID)
      expectTold(['owner', 'alice'])
    })
    it('accepts without an owner to tell when the share has vanished', async () => {
      mocks.shares.accept.mockResolvedValue({ sharedTabId: SID })
      mocks.shares.shareOwner.mockResolvedValue(null)
      await call('POST', '/api/agent-messages/invites/i1/accept')
      expectTold(['owner'])
    })
    it.each([['NOT_FOUND', 404], ['EXPIRED', 410]])('maps an accept %s to %i', async (error, status) => {
      mocks.shares.accept.mockResolvedValue({ error })
      expect((await call('POST', '/api/agent-messages/invites/i1/accept')).statusCode).toBe(status)
      expect(mocks.publish).not.toHaveBeenCalled()
    })

    it('removes a member and tells the removed user and the owner', async () => {
      mocks.shares.removeMember.mockResolvedValue(true)
      mocks.shares.shareOwner.mockResolvedValue('alice')
      const r = await call('DELETE', `/api/agent-messages/shares/${SID}/members/bob`)
      expect(r.json().data).toEqual({ removed: true })
      expect(mocks.shares.removeMember).toHaveBeenCalledWith('owner', SID, 'bob')
      expectTold(['alice', 'bob'])
    })
    it('refuses a removal the lib refuses, and a malformed share id', async () => {
      mocks.shares.removeMember.mockResolvedValue(false)
      expect((await call('DELETE', `/api/agent-messages/shares/${SID}/members/bob`)).statusCode).toBe(403)
      expect((await call('DELETE', '/api/agent-messages/shares/zzz/members/bob')).statusCode).toBe(400)
      expect(mocks.publish).not.toHaveBeenCalled()
    })
    it('removes a member of a share with no owner row without telling an owner', async () => {
      mocks.shares.removeMember.mockResolvedValue(true)
      mocks.shares.shareOwner.mockResolvedValue(null)
      await call('DELETE', `/api/agent-messages/shares/${SID}/members/bob`)
      expectTold(['bob'])
    })

    it('stops sharing and tells the owner and every member read beforehand', async () => {
      mocks.shares.stopSharing.mockResolvedValue(true)
      mocks.shares.shareMemberIds.mockResolvedValue(['bob', 'carol'])
      const r = await call('DELETE', `/api/agent-messages/shares/${SID}`)
      expect(r.json().data).toEqual({ stopped: true })
      expect(mocks.shares.stopSharing).toHaveBeenCalledWith('owner', SID)
      expect(mocks.shares.shareMemberIds.mock.invocationCallOrder[0]).toBeLessThan(mocks.shares.stopSharing.mock.invocationCallOrder[0])
      expectTold(['owner', 'bob', 'carol'])
    })
    it('moves a share to another computer of the owner, and tells the owner, its members and the share', async () => {
      mocks.shares.moveShare.mockResolvedValue({ sharedTabId: SID })
      mocks.shares.shareMemberIds.mockResolvedValue(['bob', 'carol'])
      const r = await call('POST', `/api/agent-messages/shares/${SID}/move`, { machineId: 'm2' })
      expect(r.statusCode).toBe(200)
      expect(r.json().data).toEqual({ sharedTabId: SID })
      expect(mocks.shares.moveShare).toHaveBeenCalledWith('owner', SID, 'm2', 'prod')
      expect(mocks.shares.shareMemberIds).toHaveBeenCalledWith(SID)
      expectTold(['owner', 'bob', 'carol'])
    })
    it.each([['FORBIDDEN', 403, 'Only the tab\'s owner can move it, to a computer of theirs that is signed in.'],
      ['NOT_FOUND', 404, 'This tab is no longer shared.']])('maps a move %s to %i, with words of its own', async (error, status, message) => {
      mocks.shares.moveShare.mockResolvedValue({ error })
      const r = await call('POST', `/api/agent-messages/shares/${SID}/move`, { machineId: 'm2' })
      expect(r.statusCode).toBe(status)
      expect(r.json().error).toEqual({ code: error, message })
      expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.shareChanged).not.toHaveBeenCalled()
    })
    it('refuses a malformed move', async () => {
      const move = (id: string, b: unknown) => call('POST', `/api/agent-messages/shares/${id}/move`, b as object)
      for (const b of [{}, { machineId: '' }, { machineId: 'm'.repeat(201) }, { machineId: 7 }, { machineId: 'm2', extra: 1 }])
        expect((await move(SID, b)).statusCode).toBe(400)
      const bad = await move('zzz', { machineId: 'm2' })
      expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('INVALID_TAB')
      expect(mocks.shares.moveShare).not.toHaveBeenCalled()
    })
    it('refuses to stop what the caller does not own', async () => {
      mocks.shares.stopSharing.mockResolvedValue(false)
      mocks.shares.shareMemberIds.mockResolvedValue(['bob'])
      expect((await call('DELETE', `/api/agent-messages/shares/${SID}`)).statusCode).toBe(403)
      expect((await call('DELETE', '/api/agent-messages/shares/zzz')).statusCode).toBe(400)
      expect(mocks.publish).not.toHaveBeenCalled()
    })
  })
})
