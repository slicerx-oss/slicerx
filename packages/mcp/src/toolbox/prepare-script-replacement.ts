// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

const identity = z.object({ model: z.string().min(1), firmware: z.string().min(1) })

export default (d: ServerToolDeps) => serverTool({
  name: 'prepare_script_replacement',
  title: 'Prepare a stock-script replacement',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  toolset: 'core',
  ungated: true,
  description: 'Prepare an inspectable replacement with verified stock for an explicitly selected printer. Returns original and candidate text, exact fingerprints, a line diff and the shared engine reviews. Does not apply the replacement, modify a project, grant trust or start a print. Applying a choice must recheck the current script and target.',
  input: z.object({
    selected: identity.nullable(),
    declared: z.array(identity).default([]),
    key: z.string().min(1),
    original: z.string().max(1_048_576),
    replacement: z.string().max(1_048_576).describe('Candidate stock script; the engine must recognize it for the selected printer and firmware.'),
  }),
  async run(args) {
    if (!d.slicer?.prepareScriptReplacement) throw new ToolInputError('This engine cannot prepare stock-script replacements', 'engine_unavailable')
    const record = await d.slicer.prepareScriptReplacement(args)
    return { summary: `${record.decision}: ${record.reason}`, structured: { ...record } }
  },
})
