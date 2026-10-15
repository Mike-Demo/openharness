/**
 * The credential of the daemon's Windows pipe (docs/superpowers/specs/2026-10-16-windows-native-cli-design.md §2).
 *
 * Node cannot set a named pipe's DACL. The default DACL lets every account open the pipe for reading, and once the
 * daemon is gone any account can create a pipe of that name. So reaching `\\.\pipe\harness-<id>` proves nothing,
 * unlike the Unix socket (lib/localSocket.ts). Each request proves the daemon's token instead, as the pty host's
 * hello does (ptyHost/protocol.ts). The client sends `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>` and the daemon
 * answers with HMAC-SHA256(token, 0x00‖nonce). The token never travels.
 *
 * The nonce starts with the pipe's id. An auth taken by whatever squatted on a dead daemon's name then opens
 * nothing at the next daemon's pipe, whose nonce window starts empty.
 *
 * Nothing here depends on the transport: the same checks run over a Unix socket in the tests on macOS and Linux.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { readPrivateStateFile, requireWindowsStateFile, secureStateDirectory, syncStateDirectory } from '../secureState.js'

export const PIPE_AUTH_HEADER = 'x-harness-auth'
export const PIPE_PROOF_HEADER = 'x-harness-proof'

const HEX64 = /^[0-9a-f]{64}$/
const AUTH_RE = /^([0-9a-f]{64})\.([0-9a-f]{64})$/
const PIPE_ID_RE = /harness-([0-9a-f]{32})$/

function mac(token: Buffer, separator: number, nonce: string): string {
  return createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** What a client sends in `x-harness-auth` for [nonce]. */
export function pipeAuthValue(token: Buffer, nonce: string): string {
  return `${nonce}.${mac(token, 0x01, nonce)}`
}

/** What the daemon answers in `x-harness-proof` for [nonce]: only a process that knows the token can give it. */
export function pipeProofValue(token: Buffer, nonce: string): string {
  return mac(token, 0x00, nonce)
}

/** The nonces a daemon took most recently: an auth is accepted once. Bounded; the oldest is forgotten first. */
export class NonceWindow {
  private readonly seen = new Set<string>()
  constructor(readonly capacity = 4_096) {}

  /** Whether [nonce] is new here; it is remembered either way. */
  admit(nonce: string): boolean {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value as string)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

/**
 * The nonce of a valid `x-harness-auth` [header], or null. Valid: well formed, this token's HMAC, a nonce that begins
 * with [pipeId] when one is given, and not seen before. The HMAC is checked before the window, so refused headers
 * never fill it.
 */
export function checkPipeAuth(token: Buffer, header: string | undefined, seen: NonceWindow, pipeId?: string): { nonce: string } | null {
  if (typeof header !== 'string') return null
  const match = AUTH_RE.exec(header)
  if (!match) return null
  const nonce = match[1]!
  if (pipeId !== undefined && !nonce.startsWith(pipeId)) return null
  if (!sameHex(match[2]!, mac(token, 0x01, nonce))) return null
  return seen.admit(nonce) ? { nonce } : null
}

/** Whether an answer's [headers] prove [token] for [nonce]. */
export function pipeProven(headers: IncomingHttpHeaders, token: Buffer, nonce: string): boolean {
  const proof = headers[PIPE_PROOF_HEADER]
  return typeof proof === 'string' && HEX64.test(proof) && sameHex(proof, pipeProofValue(token, nonce))
}

/** A new pipe name for a daemon that is starting: `\\.\pipe\harness-<128 random bits as hex>`. */
export function newPipePath(): string {
  return `\\\\.\\pipe\\harness-${randomBytes(16).toString('hex')}`
}

/** The 32-hex id that ends a Harness pipe name, or null for an endpoint that is not one. */
export function pipeIdOf(endpoint: string): string | null {
  return PIPE_ID_RE.exec(endpoint)?.[1] ?? null
}

/** A nonce for one request to [endpoint]: its pipe id, then 128 random bits, as 64 hex digits. */
export function newPipeNonce(endpoint: string): string {
  const id = pipeIdOf(endpoint)
  if (!id) throw new Error(`${endpoint} is not a Harness pipe`)
  return id + randomBytes(16).toString('hex')
}

export const DAEMON_TOKEN_FILE = 'daemon-token'
/** A whole token file: 64 hex digits and a newline. */
const TOKEN_FILE_BYTES = 65

export function daemonTokenPath(dataDir: string): string {
  return join(dataDir, DAEMON_TOKEN_FILE)
}

/**
 * The daemon's token in [dataDir], or null when there is none or it cannot be trusted. On Unix the folder and the file
 * pass secureState's owner and mode checks. On Windows the folder must be inside the profile, and the file must be a
 * real file there, not a link (requireWindowsStateFile). The profile's ACL is the protection, as for the hook
 * credential.
 */
export function readDaemonToken(dataDir: string): Buffer | null {
  try {
    secureStateDirectory(dataDir, false)
    const file = daemonTokenPath(dataDir)
    if (process.platform === 'win32') requireWindowsStateFile(file)
    const text = readPrivateStateFile(file, 128).trim()
    return HEX64.test(text) ? Buffer.from(text, 'hex') : null
  } catch {
    return null
  }
}

/** A token file a crash cut short between its create and its write: a regular file shorter than a whole one. */
function cutShort(file: string): boolean {
  try {
    const entry = lstatSync(file)
    return entry.isFile() && entry.size < TOKEN_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * The daemon's token, made on the first start: 32 random bytes, written owner-only with O_EXCL, so two starts at
 * once agree on one. A token cut short is replaced. Any other file that cannot be read as a token (a link, one
 * another account could write, one outside the profile) is refused: the daemon does not start on it.
 */
export function ensureDaemonToken(dataDir: string): Buffer {
  const existing = readDaemonToken(dataDir)
  if (existing) return existing
  secureStateDirectory(dataDir)
  const file = daemonTokenPath(dataDir)
  if (cutShort(file)) rmSync(file, { force: true })
  const token = randomBytes(32)
  let fd: number
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    const raced = readDaemonToken(dataDir)
    if (raced) return raced
    throw new Error(`the daemon token ${file} cannot be read or replaced: ${(error as Error).message}`)
  }
  try {
    writeFileSync(fd, `${token.toString('hex')}\n`)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncStateDirectory(dataDir)
  return token
}
