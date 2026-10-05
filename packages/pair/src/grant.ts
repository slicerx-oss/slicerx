// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Account introductions. A trusted device signs a grant that lets a new device of the same
// account pair with one host. The new device presents it on first contact; the host checks the
// issuer against its own pairings, so the SlicerX cloud can carry grants but never mint them.
import { canonicalJson } from '@slicerx/contracts/pilot'
import { fromB64url, toB64url, utf8 } from './bytes'
import { dh, kdf, sha256, sign, verifySig, type PairEnv } from './crypto'
import { deviceIdFor, intersectRights, type DeviceIdentity, type PairingRecord } from './identity'
import { DeviceGrant, GrantBody, type HostRef, type PublicIdentity, type Rights } from './schema'

/** A grant must be used within a week of issue. */
export const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const grantBytes = (body: GrantBody) => utf8(canonicalJson(body))

export function issueGrant(
  env: PairEnv,
  issuer: DeviceIdentity,
  p: { accountId: string; subject: PublicIdentity; host: HostRef; rights: Rights; ttlMs?: number },
): DeviceGrant {
  const now = env.now()
  const body: GrantBody = {
    v: 1,
    grantId: toB64url(env.random(16)),
    accountId: p.accountId,
    subject: p.subject,
    issuer: { deviceId: issuer.public.deviceId, signPub: issuer.public.signPub },
    host: p.host,
    rights: p.rights,
    issuedAt: now,
    expiresAt: now + (p.ttlMs ?? GRANT_TTL_MS),
  }
  return { ...body, sig: toB64url(sign(issuer.signSecret, 'grant', grantBytes(body))) }
}

export function grantBody(g: DeviceGrant): GrantBody {
  const { sig: _sig, ...body } = g
  return GrantBody.parse(body)
}

export const grantHash = (g: DeviceGrant): Uint8Array => sha256(grantBytes(grantBody(g)))

/** Both ends derive the same key from their static X25519 keys and the grant. */
export function introducedDeviceKey(mySecret: Uint8Array, peerDhPub: string, g: DeviceGrant): Uint8Array | null {
  const pub = fromB64url(peerDhPub)
  if (!pub) return null
  try {
    return kdf(dh(mySecret, pub), grantHash(g), 'introduced device key')
  } catch {
    return null
  }
}

export const introducedPairingId = (g: DeviceGrant): string => toB64url(kdf(grantHash(g), undefined, 'pairing id', 16))

export type GrantRejection = 'bad_signature' | 'wrong_host' | 'expired' | 'unknown_issuer' | 'not_allowed' | 'account_mismatch' | 'revoked' | 'bad_subject'

/** The issuer's signature holds and its device id matches its key. */
export function grantSignatureValid(g: DeviceGrant): boolean {
  const issuerPub = fromB64url(g.issuer.signPub)
  const sig = fromB64url(g.sig)
  if (!issuerPub || !sig || deviceIdFor(issuerPub) !== g.issuer.deviceId) return false
  const body = GrantBody.safeParse({ ...g, sig: undefined })
  return body.success && verifySig(issuerPub, 'grant', grantBytes(body.data), sig)
}

/**
 * The host's checks, in order: signature and subject keys, addressed to this host, not expired,
 * issuer is a device this host trusts with the introduce right, same account on all three
 * sides, and the grant was not revoked before. Rights are capped at the issuer's.
 */
export function checkGrant(
  env: PairEnv,
  g: DeviceGrant,
  host: { identity: PublicIdentity; accountId: string | null; pairings: PairingRecord[]; revokedGrants: ReadonlySet<string> },
): { ok: true; rights: Rights; issuer: PairingRecord } | { ok: false; reason: GrantRejection } {
  if (!grantSignatureValid(g)) return { ok: false, reason: 'bad_signature' }
  const subjectPub = fromB64url(g.subject.signPub)
  if (!subjectPub || deviceIdFor(subjectPub) !== g.subject.deviceId) return { ok: false, reason: 'bad_subject' }
  if (g.host.identity.signPub !== host.identity.signPub || g.host.identity.dhPub !== host.identity.dhPub) return { ok: false, reason: 'wrong_host' }
  const now = env.now()
  if (now > g.expiresAt || g.issuedAt > now + 5 * 60 * 1000) return { ok: false, reason: 'expired' }
  if (host.revokedGrants.has(g.grantId)) return { ok: false, reason: 'revoked' }
  const issuer = host.pairings.find((r) => r.peer.deviceId === g.issuer.deviceId && r.peer.signPub === g.issuer.signPub)
  if (!issuer) return { ok: false, reason: 'unknown_issuer' }
  if (!issuer.rights.introduce) return { ok: false, reason: 'not_allowed' }
  if (!host.accountId || g.accountId !== host.accountId || issuer.accountId !== host.accountId) return { ok: false, reason: 'account_mismatch' }
  if (g.subject.deviceId === g.issuer.deviceId) return { ok: false, reason: 'bad_subject' }
  return { ok: true, rights: intersectRights(g.rights, issuer.rights), issuer }
}

export { DeviceGrant }
