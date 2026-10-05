// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The approval broker for the browser demo (the TS mirror of sx-permit in
// @slicerx/pilot). It loads on the first approval, not at launch.
import type { ApprovalHost, ApprovalVerifier } from '@slicerx/contracts'

export function lazyBroker(): ApprovalHost & ApprovalVerifier {
  let broker: Promise<ApprovalHost & ApprovalVerifier> | null = null
  const load = () => (broker ??= import('@slicerx/pilot').then((m) => m.createApprovalBroker()))
  return {
    register: async (req) => (await load()).register(req),
    grant: async (id) => (await load()).grant(id),
    deny: async (id, reason) => (await load()).deny(id, reason),
    verify: async (token, action, target, paramsHash) => (await load()).verify(token, action, target, paramsHash),
  }
}
