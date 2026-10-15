import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkPipeAuth, newPipeNonce, newPipePath, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeAuthValue, pipeIdOf,
  pipeProofValue, pipeProven,
} from './pipeAuth.js'

const token = Buffer.alloc(32, 7)
const hmac = (separator: number, nonce: string) =>
  createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')

describe('pipe auth', () => {
  it('names its headers in lower case, as Node reads them', () => {
    expect([PIPE_AUTH_HEADER, PIPE_PROOF_HEADER]).toEqual(['x-harness-auth', 'x-harness-proof'])
  })

  it('authenticates with an HMAC of the nonce and proves with another, never sending the token', () => {
    const nonce = 'ab'.repeat(32)
    expect(pipeAuthValue(token, nonce)).toBe(`${nonce}.${hmac(0x01, nonce)}`)
    expect(pipeProofValue(token, nonce)).toBe(hmac(0x00, nonce))
    expect(pipeAuthValue(token, nonce)).not.toContain(token.toString('hex'))
    expect(pipeProofValue(token, nonce)).not.toBe(pipeAuthValue(token, nonce).split('.')[1])
  })

  it('accepts an auth once, and only for the pipe whose id starts its nonce', () => {
    const id = 'c'.repeat(32)
    const nonce = newPipeNonce(`\\\\.\\pipe\\harness-${id}`)
    expect(nonce).toMatch(/^c{32}[0-9a-f]{32}$/)
    const seen = new NonceWindow()
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toEqual({ nonce })
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toBeNull()
    const other = newPipeNonce(`\\\\.\\pipe\\harness-${'d'.repeat(32)}`)
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen, id)).toBeNull()
    // No pipe named: any well-formed nonce.
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen)).toEqual({ nonce: other })
  })

  it('refuses a wrong token, a malformed header and none at all, and remembers none of them', () => {
    const seen = new NonceWindow()
    const nonce = newPipeNonce(`harness-${'e'.repeat(32)}`)
    const good = pipeAuthValue(token, nonce)
    for (const header of [undefined, '', 'x', nonce, `${nonce}.`, `${nonce}.${'0'.repeat(64)}`,
      pipeAuthValue(Buffer.alloc(32, 8), nonce), good.toUpperCase(), `${good} `, `${good}.00`]) {
      expect(checkPipeAuth(token, header, seen)).toBeNull()
    }
    expect(seen.size).toBe(0)
    expect(checkPipeAuth(token, good, seen)).toEqual({ nonce })
  })

  it('remembers a bounded number of nonces and forgets the oldest first', () => {
    const seen = new NonceWindow(2)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('b')).toBe(true)
    expect(seen.admit('a')).toBe(false)
    expect(seen.admit('c')).toBe(true)
    expect(seen.size).toBe(2)
    expect(seen.admit('a')).toBe(true)
  })

  it('takes a proof from an answer\'s headers only when it is this token\'s for this nonce', () => {
    const nonce = newPipeNonce(`harness-${'f'.repeat(32)}`)
    expect(pipeProven({ [PIPE_PROOF_HEADER]: pipeProofValue(token, nonce) }, token, nonce)).toBe(true)
    for (const headers of [{}, { [PIPE_PROOF_HEADER]: pipeProofValue(Buffer.alloc(32, 9), nonce) },
      { [PIPE_PROOF_HEADER]: pipeAuthValue(token, nonce).split('.')[1] }, { [PIPE_PROOF_HEADER]: 'zz' }]) {
      expect(pipeProven(headers, token, nonce)).toBe(false)
    }
  })

  it('names a new pipe with 128 random bits each time, and reads its id back', () => {
    const a = newPipePath(), b = newPipePath()
    expect(a).toMatch(/^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect(pipeIdOf(a)).toBe(a.slice(-32))
    // A Unix socket with a pipe's name stands in for one in the tests.
    expect(pipeIdOf(`/tmp/x/harness-${'0'.repeat(32)}`)).toBe('0'.repeat(32))
    expect(pipeIdOf('\\\\.\\pipe\\other')).toBeNull()
    expect(() => newPipeNonce('/tmp/daemon.sock')).toThrow(/not a Harness pipe/)
  })
})
