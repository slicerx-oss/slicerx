// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { mcpName } from '../gate'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'pending_approvals',
    title: 'Pending approvals',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description: 'List approval requests this session raised: the ones waiting for your user (approve with slicerx_approve), the ones waiting for a person in SlicerX or on the phone, and how those went once the hub ran them.',
    input: z.object({}),
    async run() {
      const pending = [...d.gate.pending.values()].map((p) => ({
        request_id: p.request.id,
        tool: mcpName(p.tool.name),
        title: p.request.title,
        lines: p.request.lines,
        permission: p.request.permission,
        expires_at: p.request.expiresAt,
        // Person-only requests are answered in SlicerX; the hub reports when it ran the work.
        status: p.outcome ? (p.outcome.ok ? 'done' : 'failed') : p.personOnly ? 'waiting_for_person' : 'waiting_for_you',
        ...(p.outcome?.message ? { message: p.outcome.message } : {}),
      }))
      return { summary: `${pending.length} pending`, structured: { pending } }
    },
  })
