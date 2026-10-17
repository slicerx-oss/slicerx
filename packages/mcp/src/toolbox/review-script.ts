// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

const identity = z.object({ model: z.string().min(1), firmware: z.string().min(1) })

export default (d: ServerToolDeps) => serverTool({
  name: 'review_script',
  title: 'Review a printer script',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  toolset: 'core',
  ungated: true,
  description: 'Compare a printer script with versioned stock for the selected printer and firmware. Returns the shared native review decision, reason, stock version, fingerprint and ignored cosmetic differences. Does not change a project, export G-code or start a print.',
  input: z.object({
    selected: identity.nullable().describe('Selected target printer model id and firmware. An imported printer name alone does not establish this selection.'),
    declared: z.array(identity).default([]).describe('Printer identities declared by the imported project or other selected profiles; conflicts require review.'),
    key: z.string().min(1).describe('Script setting key, such as machine_start_gcode'),
    text: z.string().max(1_048_576).describe('Original script text, including templates and comments'),
  }),
  async run(args) {
    if (!d.slicer?.reviewScript) throw new ToolInputError('This engine cannot review printer scripts', 'engine_unavailable')
    const result = await d.slicer.reviewScript(args)
    return { summary: `${result.decision}: ${result.reason}`, structured: { ...result } }
  },
})
