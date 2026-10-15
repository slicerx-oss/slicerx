// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview of the Model tool the person has open (push and pull, fillet and chamfer), through the app
// link: whether the last edit previewed or failed, the error shown next to the tool, and whether the view keeps the
// last good preview through it. Read only.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError } from './errors'

/** The open tool's operation preview as the app reads it back (packages/app app-link/model-op-preview.ts). */
export interface AppOpPreview {
  /** False while no Model tool that previews is open. */
  open: boolean
  tool: 'push' | 'fillet' | 'chamfer' | null
  /** none: nothing to preview yet; pending: the engine is working on it; ok: the preview matches the fields; error: the last edit failed. */
  status: 'none' | 'pending' | 'ok' | 'error'
  /** The error next to the tool, as the person reads it. */
  message: string | null
  /** The view keeps a preview from an earlier edit (through an error, or while a newer one is pending). */
  showingLastGood: boolean
  /** The shown preview adds material (tinted) or removes it (a ghost seen through the part). */
  adds: boolean
  removes: boolean
}

const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']
const NAMES: Record<string, string> = { push: 'Push and pull', fillet: 'Fillet', chamfer: 'Chamfer' }

function summary(p: AppOpPreview): string {
  if (!p.open || !p.tool) return 'No Model tool with a preview is open.'
  const name = NAMES[p.tool] ?? p.tool
  const what = [p.adds ? 'adds material' : '', p.removes ? 'removes material' : ''].filter(Boolean).join(' and ')
  if (p.status === 'error') return `${name}: ${p.message ?? 'the last edit failed.'}`
  if (p.status === 'pending') return `${name}: the preview is updating.`
  if (p.status === 'none') return `${name} has nothing to preview yet.`
  return `${name}: the preview ${what || 'shows no change'}.`
}

export function appModelOpPreviewTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const read = defineTool({
    name: 'app.model_op_preview',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read the operation preview of the Model tool the person has open in ${appName} (push and pull, fillet and chamfer): status (none, pending, ok, or error when the last edit failed, such as a value that does not read or a size the engine refuses), the error shown next to the tool, whether the view keeps the last good preview through it, and whether the shown preview adds material (tinted) or removes it (a ghost). Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
      let out: AppOpPreview
      try {
        out = await link.call<AppOpPreview>('model.op_preview', {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its Model preview cannot be read.`, 'not_configured', { appLink: code })
        throw new ToolInputError(e instanceof Error ? e.message : String(e), 'internal_error')
      }
      return { summary: summary(out), output: out }
    },
  })
  return [read] as PilotTool<never>[]
}
