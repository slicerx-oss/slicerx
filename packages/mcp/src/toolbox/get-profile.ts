// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'get_profile',
    title: 'Get a profile',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description: 'Return the settings a profile sets, with OrcaSlicer inherits chains resolved. Accepts an id from slicerx_list_profiles or a profile name.',
    input: z.object({ profile: z.string().min(1).describe('Profile id or name, such as "printer:prusa_mk4s" or "filament:pla"') }),
    async run(args) {
      await d.profiles.prepare([args.profile])
      const p = d.profiles.get(args.profile)
      if (!p) throw new ToolInputError(`No profile "${args.profile}". Use slicerx_list_profiles to search.`, 'unknown_profile')
      return { summary: p.id, structured: p as unknown as Record<string, unknown> }
    },
  })
