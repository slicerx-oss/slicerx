// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Approvals for actions the person starts from a screen (pause, resume, cancel, send).
// The screen confirms with the person first; only then does
// `approve` register the request and mint a token bound to the exact host calls it lists.
import { grantApproval, hashParams, type ApprovalHost, type ApprovalRequest, type ApprovalToken, type PermissionClass, type SideEffectAction } from '@slicerx/contracts'

let seq = 0

export async function buildApproval(opts: {
  tool: string
  permission: PermissionClass
  title: string
  lines: string[]
  printerId?: string
  actions: { action: SideEffectAction; target: string; params: unknown }[]
  now?: number
}): Promise<ApprovalRequest> {
  const actions = await Promise.all(opts.actions.map(async (a) => ({ action: a.action, target: a.target, paramsHash: await hashParams(a.params) })))
  const now = opts.now ?? Date.now()
  return {
    id: `apr-pocket-${now.toString(36)}-${++seq}`,
    sessionId: 'pocket',
    tool: opts.tool,
    permission: opts.permission,
    title: opts.title,
    lines: opts.lines,
    ...(opts.printerId ? { printerId: opts.printerId } : {}),
    paramsHash: await hashParams(opts.actions.map((a) => a.params)),
    actions,
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
  }
}

/** Call only after the person confirmed on the device. */
export async function approve(approvals: ApprovalHost, request: ApprovalRequest, bedClear = false): Promise<ApprovalToken> {
  await approvals.register(request)
  return grantApproval(approvals, request, bedClear)
}
