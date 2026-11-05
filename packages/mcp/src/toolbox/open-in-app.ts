// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { basename } from 'node:path'
import { z } from 'zod'
import { productName } from '@slicerx/contracts'
import { resolveModel } from '../models'
import { APP_OPENS, APP_OPENS_TEXT, openInApp } from '../open-in-app'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'open_in_app',
    title: `Open in the ${productName()} app`,
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      `Open a model, project or G-code file (${APP_OPENS_TEXT}) in the ${productName()} desktop app on this computer, to slice and print it there, as the browser's Open in ${productName()} button does. The file goes to the app registered for its type, as a double-click would. A STEP file (.step or .stp) or an IGES file (.igs or .iges) is turned into a mesh by the app as it opens it, a locked project (.sxlock) opens only for the account that exported it, and G-code opens in the preview. An OBJ opens with the MTL and PNG or JPEG images it names, read from its own folder (plain names only, subfolders allowed), and the app paints it from its texture; slicerx_app_paint_from_texture paints it again later. Returns the file, the command that handed it over and, for an OBJ that names an MTL, \`texture\` (\`found\` and \`missing\` files by the names the OBJ and MTL give them). The app adds it to the plate; nothing is sliced or printed until a person does it.`,
    input: z.object({ file: z.string().min(1).describe(`Absolute path or http(s) URL of a ${APP_OPENS_TEXT} file`) }),
    hints: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
    async run(args) {
      const path = await resolveModel(d.policy, args.file, APP_OPENS)
      const opened = await openInApp(path)
      const missing = opened.texture?.missing ?? []
      const summary = `Opened ${basename(path)} in the app (${opened.command}).${missing.length ? ` Its texture needs ${missing.join(', ')} in the same folder.` : ''}`
      return { summary, structured: opened as unknown as Record<string, unknown>, text: summary }
    },
  })
