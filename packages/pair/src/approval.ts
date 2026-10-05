// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A phone's approval decision, signed with its identity key over the request exactly as the host
// sent it. The host checks the hash against its own copy, so a decision cannot be moved onto a
// different request, and keeps the signature as the audit record.
import type { ApprovalRequest } from '@slicerx/contracts'
import { canonicalJson } from '@slicerx/contracts/pilot'
import { fromB64url, toB64url, toHex, utf8 } from './bytes'
import { sha256, sign, verifySig } from './crypto'
import type { DeviceIdentity } from './identity'
import type { DecideParams } from './rpc'

export const requestHash = (req: ApprovalRequest): string => toHex(sha256(utf8(canonicalJson(req))))

const decisionBytes = (p: Omit<DecideParams, 'sig'>) =>
  // `bedClear` is signed only when true, so decisions from before it existed still verify.
  utf8(canonicalJson({ requestId: p.requestId, decision: p.decision, requestHash: p.requestHash, at: p.at, ...(p.bedClear === true ? { bedClear: true } : {}) }))

export function signDecision(identity: DeviceIdentity, req: ApprovalRequest, decision: 'approve' | 'deny', at: number, bedClear = false): DecideParams {
  const body = { requestId: req.id, decision, requestHash: requestHash(req), at, ...(decision === 'approve' && bedClear ? { bedClear: true } : {}) }
  return { ...body, sig: toB64url(sign(identity.signSecret, 'approval', decisionBytes(body))) }
}

export function verifyDecision(signPub: string, req: ApprovalRequest, p: DecideParams): boolean {
  const pub = fromB64url(signPub)
  const sig = fromB64url(p.sig)
  if (!pub || !sig || p.requestId !== req.id || p.requestHash !== requestHash(req)) return false
  return verifySig(pub, 'approval', decisionBytes(p), sig)
}
