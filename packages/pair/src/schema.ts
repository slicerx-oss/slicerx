// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wire schemas. Every frame and every decrypted payload is parsed here before any other code
// looks at it, with length limits on every string.
import { z } from 'zod'

const b64 = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
const b64Blob = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]*$/)

export const Key32 = b64(32)
export const Id16 = b64(16)
export const Sig64 = b64(64)
/** Labels shown to people. Rendered as text only. */
const Label = z.string().min(1).max(64)
const Iso = z.string().max(40)

export const DEVICE_PLATFORMS = ['ios', 'android', 'desktop', 'web', 'link'] as const
export const DevicePlatform = z.enum(DEVICE_PLATFORMS)
export type DevicePlatform = z.infer<typeof DevicePlatform>

export const PublicIdentity = z.object({
  deviceId: Id16,
  name: Label,
  platform: DevicePlatform,
  signPub: Key32,
  dhPub: Key32,
})
export type PublicIdentity = z.infer<typeof PublicIdentity>

/**
 * What a paired device may do on a host. `request` sends slices and print jobs, `approve`
 * decides approval requests, `introduce` vouches for another device of the same account.
 */
export const Rights = z.object({ request: z.boolean(), approve: z.boolean(), introduce: z.boolean() })
export type Rights = z.infer<typeof Rights>

const LanUrl = z.string().max(120).regex(/^wss?:\/\//)
const RelayUrl = z.string().max(200).regex(/^wss:\/\//)
export const Endpoints = z.object({ lan: z.array(LanUrl).max(4), relay: RelayUrl.optional() })
export type Endpoints = z.infer<typeof Endpoints>

// ---------------------------------------------------------------------------
// Pairing handshake frames (plaintext; only public keys, nonces and MACs)

export const HelloFrame = z.object({
  k: z.literal('hello'),
  v: z.literal(1),
  o: Id16,
  e: Key32,
  c: Key32,
  m: Key32,
  name: Label.optional(),
  platform: DevicePlatform.optional(),
})
export const ChallengeFrame = z.object({ k: z.literal('challenge'), o: Id16, e: Key32, n: Key32, m: Key32 })
export const RevealFrame = z.object({ k: z.literal('reveal'), o: Id16, n: Key32 })
export const ConfirmFrame = z.object({ k: z.literal('confirm'), o: Id16, x: b64Blob(64 * 1024) })
export const ABORT_REASONS = ['mismatch', 'canceled', 'expired', 'busy', 'bad_proof', 'protocol'] as const
export const AbortFrame = z.object({ k: z.literal('abort'), o: Id16, reason: z.enum(ABORT_REASONS) })
export type AbortReason = (typeof ABORT_REASONS)[number]

// ---------------------------------------------------------------------------
// Account introductions

export const HostRef = z.object({ identity: PublicIdentity, endpoints: Endpoints })
export type HostRef = z.infer<typeof HostRef>

export const GrantBody = z.object({
  v: z.literal(1),
  grantId: Id16,
  accountId: z.string().min(1).max(64),
  subject: PublicIdentity,
  issuer: z.object({ deviceId: Id16, signPub: Key32 }),
  host: HostRef,
  rights: Rights,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
})
export type GrantBody = z.infer<typeof GrantBody>
export const DeviceGrant = GrantBody.extend({ sig: Sig64 })
export type DeviceGrant = z.infer<typeof DeviceGrant>

// ---------------------------------------------------------------------------
// Session frames

export const InitFrame = z.object({
  k: z.literal('init'),
  /** Session protocol version. Hosts refuse anything but SESSION_VERSION (session.ts). */
  v: z.number().int().optional(),
  s: Id16,
  r: Key32,
  e: Key32,
  n: Id16,
  m: Key32,
  g: DeviceGrant.optional(),
})
export const AcceptFrame = z.object({ k: z.literal('accept'), v: z.number().int().optional(), s: Id16, e: Key32, n: Id16, m: Key32 })
/** Ciphertext frames. 1 MiB of ciphertext covers the largest upload chunk with room to spare. */
export const DataFrame = z.object({ k: z.literal('data'), s: Id16, c: z.number().int().nonnegative(), x: b64Blob(1024 * 1024) })
/** Unauthenticated hint that the host does not know the route. Clients treat it as "try later", never as a revocation. */
export const RefuseFrame = z.object({ k: z.literal('refuse'), s: Id16, reason: z.enum(['unknown', 'busy', 'update']) })

export const Frame = z.discriminatedUnion('k', [
  HelloFrame,
  ChallengeFrame,
  RevealFrame,
  ConfirmFrame,
  AbortFrame,
  InitFrame,
  AcceptFrame,
  DataFrame,
  RefuseFrame,
])
export type Frame = z.infer<typeof Frame>
export type FrameOf<K extends Frame['k']> = Extract<Frame, { k: K }>

/** Largest frame accepted from a pipe, in characters. */
export const MAX_FRAME_CHARS = 1_500_000

export function parseFrame(text: string): Frame | null {
  if (typeof text !== 'string' || text.length > MAX_FRAME_CHARS) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const r = Frame.safeParse(raw)
  return r.success ? r.data : null
}

// ---------------------------------------------------------------------------
// Handshake confirm payloads (inside the AEAD)

export const JoinerConfirm = z.object({ identity: PublicIdentity, sig: Sig64, accountId: z.string().max(64).optional() })
export type JoinerConfirm = z.infer<typeof JoinerConfirm>

export const OffererConfirm = z.object({
  identity: PublicIdentity,
  sig: Sig64,
  rights: Rights,
  endpoints: Endpoints.optional(),
  accountId: z.string().max(64).optional(),
  /** Present when the offerer is a trusted device introducing the joiner to its hosts. */
  grants: z.array(DeviceGrant).max(16).optional(),
})
export type OffererConfirm = z.infer<typeof OffererConfirm>
