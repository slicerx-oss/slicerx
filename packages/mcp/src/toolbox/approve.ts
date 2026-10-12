// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { BED_CONFIRM_NOTE, resolvePending } from '../gate'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'approve',
    title: 'Approve or decline a pending action',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      'Resolve an approval request returned by another SlicerX tool (status "approval_required"). Call it only after showing the request to the user and getting their answer in this conversation. Approving runs that exact call once; the request expires after 5 minutes.',
    input: z.object({
      request_id: z.string().min(1),
      approve: z.boolean().describe('true only if the user agreed to this exact action'),
      // Kept so older clients that still send it get a clear answer instead of a silent drop.
      bed_clear: z.boolean().optional().describe('Not accepted. The build plate is confirmed only in SlicerX or on the phone; this argument is ignored.'),
    }),
    hints: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
    async run(args, ctx) {
      const r = await resolvePending(d.gate, args.request_id, args.approve, ctx.signal, (line, fraction) => ctx.progress(line, fraction))
      const reply = args.bed_clear === undefined ? r : { ...r, content: [...r.content, { type: 'text' as const, text: `bed_clear was ignored. ${BED_CONFIRM_NOTE}` }] }
      return { summary: args.approve ? 'Approved' : 'Declined', passthrough: reply }
    },
  })
