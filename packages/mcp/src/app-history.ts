// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const codes: Record<string, ErrorCode> = { busy: 'busy', invalid_input: 'invalid_input', read_only: 'not_supported', denied: 'not_supported', not_ready: 'busy' }
interface HistoryResult { revision: string; undo: number; redo: number; changed?: boolean }

export function appHistoryTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const specs = [
    ['app.history', 'history.get', 'Read the open project\'s Undo and Redo counts, history revision and current project state: plates, objects and transforms, bounds, design step summaries, object settings, filaments, flush settings and timeline.'],
    ['app.undo', 'history.undo', 'Undo one recorded project edit using the same history as the toolbar, including object transforms, plate edits and design changes. This can undo a person\'s last edit too. Pass the revision from app_history; a stale revision or active edit is refused. Returns the resulting project state and changed:false when nothing can be undone.'],
    ['app.redo', 'history.redo', 'Redo one project edit from the toolbar history. Pass the revision from app_history or the previous undo result; a stale revision or active edit is refused. Returns the resulting project state and changed:false when nothing can be redone. A new edit clears Redo.'],
  ] as const
  return specs.map(([name, method, description]) => defineTool({
    name, version: '1.0.0', source: 'command', permission: method === 'history.get' ? 'read' : 'slice',
    description: `${description} Requires ${appName} open with its app link on; Undo and Redo require an edit grant. Only edits recorded by the toolbar history are affected; this is separate from design_undo, which removes a design's last feature.`,
    input: method === 'history.get' ? z.object({}).strict() : z.object({ revision: z.string().min(1).max(100) }).strict(),
    async run(args) {
      if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (use --printers link).`, 'not_configured')
      let out: HistoryResult
      try { out = await link.call<HistoryResult>(method, args) } catch (e) {
        const code = String((e as { code?: unknown })?.code ?? '')
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`${appName}'s project history is unavailable. Open the app and allow this client on its app link.`, 'not_configured')
        throw new ToolInputError(e instanceof Error ? e.message : String(e), codes[code] ?? 'internal_error')
      }
      return { summary: `${out.undo} edits can be undone; ${out.redo} can be redone.${out.changed === false ? ' Nothing changed.' : ''}`, output: out }
    },
  })) as PilotTool<never>[]
}
