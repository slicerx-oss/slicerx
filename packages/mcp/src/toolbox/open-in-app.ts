// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename } from 'node:path'
import { z } from 'zod'
import { resolveModel } from '../models'
import { openInApp } from '../open-in-app'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'open_in_app',
    title: 'Open in the SlicerX app',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      "Open a model or project file (.sx3mf, .3mf or .stl) in the SlicerX desktop app on this computer, to slice and print it there, as the browser's Open in SlicerX button does. The file goes to the app registered for its type, as a double-click would. Returns the file and the command that handed it over. The app adds it to the plate; nothing is sliced or printed until a person does it.",
    input: z.object({ file: z.string().min(1).describe('Absolute path or http(s) URL of a .sx3mf, .3mf or .stl file') }),
    hints: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
    async run(args) {
      const path = await resolveModel(d.policy, args.file)
      const opened = await openInApp(path)
      const summary = `Opened ${basename(path)} in the app (${opened.command}).`
      return { summary, structured: opened as unknown as Record<string, unknown>, text: summary }
    },
  })
