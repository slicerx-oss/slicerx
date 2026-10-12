// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'action_log',
    title: 'Action log',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description: 'The most recent tool calls and approval decisions this server recorded: tool, permission class, decision, who decided, and the result summary.',
    input: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
    hints: { idempotent: false },
    async run(args) {
      return { summary: 'Action log', structured: { path: d.gate.log.path, entries: d.gate.log.recent(args.limit) } }
    },
  })
