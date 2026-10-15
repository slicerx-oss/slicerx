// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull as the person has it open in the app, through the app link: read its picked face, the distance in its
// Distance box and the operation that distance makes, or type a distance into that box for the person to apply with
// Enter. Neither changes the project, so both tools read; geom.push_pull is the way a client pushes a face itself.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** The open Push and pull as the app reads it back (packages/app app-link/model-push.ts, model.push). */
export interface AppPush {
  /** False while Push and pull is not open in Model. */
  open: boolean
  face: { object: string; part: number; at: [number, number, number]; normal: [number, number, number]; thicknessMm: number | null } | null
  /** The Distance box as typed, mm (it may name values). */
  text: string
  /** What the box reads as, mm; null while it is empty or does not read. */
  distanceMm: number | null
  operation: 'pull' | 'cut' | 'through' | null
  /** The operation chip's words: Pull out, Cut or Cut through. */
  operationLabel: string | null
  busy: boolean
  note?: string
  editStep?: number
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_supported', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppPush> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppPush>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its Push and pull cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

function summary(p: AppPush): string {
  if (!p.open) return 'Push and pull is not open.'
  if (!p.face) return 'Push and pull is open with no face picked yet.'
  const d = p.distanceMm === null ? (p.text.trim() ? `"${p.text}" does not read as a distance` : 'no distance yet') : `${p.distanceMm} mm`
  return `Push and pull has a face on ${p.face.object}: ${d}${p.operationLabel ? `, ${p.operationLabel}` : ''}.${p.note ? ` ${p.note}` : ''}`
}

export function appModelPushTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const get = defineTool({
    name: 'app.model_push',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Read Push and pull as the person has it open in ${appName}'s Model: open (false while it is not), the picked face (object, part, a point "at" on it, its outward normal, and how thick the body is behind it), the Distance box as typed and the distance it reads as (mm), and the operation that makes (pull: Pull out adds material; cut: a negative distance cuts; through: the cut opens a hole). Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'model.push', {})
      return { summary: summary(out), output: out }
    },
  })
  const setDistance = defineTool({
    name: 'app.model_push_set',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Type a distance into the Distance box of the Push and pull the person has open in ${appName}'s Model, as the person would: positive pulls the face out, negative cuts. The arrow and the preview follow it; nothing changes in the project until the person applies it with Enter. To push a face yourself, use slicerx_geom_push_pull. Returns the tool read back.`,
    input: z.object({ distanceMm: z.number().finite().min(-10_000).max(10_000).describe('Millimeters along the face normal: positive pulls out, negative cuts') }),
    async run(i) {
      const out = await call(link, appName, 'model.push_set', { distanceMm: i.distanceMm })
      return { summary: summary(out), output: out }
    },
  })
  return [get, setDistance] as PilotTool<never>[]
}
