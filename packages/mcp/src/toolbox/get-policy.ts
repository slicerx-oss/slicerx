// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { describePolicy } from '../policy'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'get_policy',
    title: 'Permission policy',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description: 'Show the permission policy the user set for this server: Allow, Ask first or Off for each action class, and per-printer exceptions. Read only; no tool can change it.',
    input: z.object({}),
    async run() {
      return { summary: 'Permission policy', structured: describePolicy({ policy: d.gate.policy, path: d.gate.policyPath }) }
    },
  })
