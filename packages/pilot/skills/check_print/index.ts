// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print check-in: "how's the print going?". Takes a fresh camera frame
// through the connector, puts it in the transcript and in front of the model
// with the printer's status, and leaves any change to print.adjust, where each
// one is checked against the limits and waits for an approval card.
import type { Cell, PrinterInfo, PrinterStatus, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { ASSISTANT_NAME } from '../../src/name'
import type { LlmImage } from '../../src/provider/types'
import { defineSkill, defineTool, type ToolContext } from '../../src/tool'
import { AdjustRefused, describeLimits, materialLimits, planAdjustment, type Adjustment } from './limits'

/** Frames larger than this are not sent to the model. */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024
/** Longest side of the frame the model gets. Enough to see a lifting corner; more only costs. */
export const MAX_FRAME_PX = 1024

/**
 * Scales a frame down to MAX_FRAME_PX on its longest side, as a JPEG, where the platform can
 * (browsers and the desktop webview). Elsewhere, and for frames already small enough, the
 * frame goes as it came.
 */
async function downscale(blob: Blob): Promise<Blob> {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas }
  if (!g.createImageBitmap || !g.OffscreenCanvas) return blob
  try {
    const bmp = await g.createImageBitmap(blob)
    const scale = MAX_FRAME_PX / Math.max(bmp.width, bmp.height)
    if (scale >= 1) return blob
    const canvas = new g.OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  } catch {
    return blob
  }
}
const FRAME_TYPES = new Set<LlmImage['mime']>(['image/jpeg', 'image/png', 'image/webp'])

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const pct = (v: number | undefined): string => (v === undefined ? 'unknown' : `${Math.round(v * 100)} %`)

function statusRows(info: PrinterInfo, s: PrinterStatus): [string, Cell][] {
  const rows: [string, Cell][] = [['printer', `${info.name} (${info.vendor} ${info.model})`], ['state', { text: s.state, tone: s.state === 'printing' ? 'run' : s.state === 'error' ? 'bad' : 'dim' }]]
  if (s.jobName) rows.push(['job', s.jobName])
  if (s.layer !== undefined) rows.push(['layer', s.layerCount ? `${s.layer} of ${s.layerCount}` : String(s.layer)])
  if (s.progress !== undefined) rows.push(['progress', pct(s.progress)])
  const n = s.nozzles[0]
  if (n) rows.push(['nozzle', `${Math.round(n.current)} C, target ${n.target} C`])
  if (s.bed) rows.push(['bed', `${Math.round(s.bed.current)} C, target ${s.bed.target} C`])
  return rows
}

/** The printer to check: the one named, else the only one printing (then preparing, then paused). */
async function pickPrinter(ctx: ToolContext, printerId: string | undefined): Promise<{ info: PrinterInfo; status: PrinterStatus } | { error: string }> {
  const all = await ctx.host.printers.list()
  if (printerId) {
    const info = all.find((p) => p.id === printerId || p.name.toLowerCase() === printerId.toLowerCase())
    if (!info) return { error: `No printer ${printerId}. Printers: ${all.map((p) => `${p.name} (${p.id})`).join(', ')}.` }
    return { info, status: await ctx.host.printers.status(info.id) }
  }
  const busy: { info: PrinterInfo; status: PrinterStatus }[] = []
  for (const info of all) {
    const status = await ctx.host.printers.status(info.id).catch(() => null)
    if (status && (status.state === 'printing' || status.state === 'paused' || status.state === 'preparing')) busy.push({ info, status })
  }
  if (busy.length === 0) return { error: 'No printer is printing right now.' }
  for (const state of ['printing', 'preparing', 'paused'] as const) {
    const these = busy.filter((b) => b.status.state === state)
    const only = these[0]
    if (these.length === 1 && only) return only
    if (these.length > 1) return { error: `Several printers are ${state}: ${these.map((b) => `${b.info.name} (${b.info.id})`).join(', ')}. Ask which one to check.` }
  }
  return { error: 'No printer is printing right now.' }
}

export function createCheckPrint() {
  return defineSkill({
    name: 'check_print',
    version: '1.0.0',
    permission: 'read',
    description:
      "Check on a running print: takes a fresh camera frame, shows it to the user and to you with the printer's status and the limits for changes. Read the frame yourself, say plainly what you see, and propose fixes only through print.adjust, one change per call.",
    input: z.object({
      printerId: z.string().optional().describe('Printer id or name; omit when only one printer is printing'),
    }),
    args: (i) => i.printerId ?? '',
    async run(i, ctx) {
      const picked = await pickPrinter(ctx, i.printerId)
      if ('error' in picked) return { ok: false, summary: picked.error }
      const { info, status } = picked
      const material = materialLimits(status, ctx.kb)
      const limits = describeLimits(status, info, material)
      const rows = statusRows(info, status)
      const base = {
        printer: { id: info.id, name: info.name, model: `${info.vendor} ${info.model}` },
        status: { state: status.state, job: status.jobName, layer: status.layer, layerCount: status.layerCount, progress: status.progress, nozzles: status.nozzles, bed: status.bed, slots: status.slots, message: status.message },
        limits,
      }

      const noFrame = (why: string) => ({
        summary: `${info.name}: ${status.state}, ${why}`,
        output: { ...base, frame: null, note: `${why}. Describe the status only, and ask the user what they see on the plate.` },
        display: [{ kind: 'kv', rows: [...rows, ['camera', { text: why, tone: 'warn' }]] }] as ToolDisplay[],
        untrusted: true,
      })
      if (!status.cameraAvailable) return noFrame('no camera')
      const raw = await ctx.host.printers.snapshot(info.id).catch(() => null)
      if (!raw) return noFrame('the camera returned no frame')
      const blob = FRAME_TYPES.has(raw.type as LlmImage['mime']) ? await downscale(raw) : raw
      const mime = blob.type as LlmImage['mime']
      if (!FRAME_TYPES.has(mime)) return noFrame(`the camera sent ${blob.type || 'an unknown format'}, not a photo`)
      if (blob.size > MAX_FRAME_BYTES) return noFrame('the frame is too large to send')
      const data = base64(new Uint8Array(await blob.arrayBuffer()))
      const at = new Date().toISOString()
      const where = status.layer !== undefined ? `layer ${status.layer}${status.layerCount ? ` of ${status.layerCount}` : ''}` : status.state

      return {
        summary: `${info.name}: fresh frame at ${where}`,
        output: {
          ...base,
          frame: { capturedAt: at, bytes: blob.size, type: mime },
          note:
            'The image attached to this result is the frame. Say what you see: first layer, corners or edges lifting, a part that moved or came loose, spaghetti, blobs on the nozzle, layer shifts, stringing. Say when the view is unclear rather than guessing. Propose a change only for something you see or the status shows, with print.adjust, one change per call; the user approves each one. For spaghetti or a loose part, propose a pause.',
        },
        images: [{ mime, data }],
        display: [
          { kind: 'image', src: `data:${mime};base64,${data}`, alt: `Camera view of ${info.name} at ${where}`, caption: `${info.name}, ${where}` },
          { kind: 'kv', rows },
        ],
        // Job names and printer messages come from the printer.
        untrusted: true,
      }
    },
  })
}

const adjustment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('part_fan'), percent: z.number().min(0).max(100) }),
  z.object({ kind: z.literal('speed'), percent: z.number().min(10).max(300) }),
  z.object({ kind: z.literal('nozzle_temp'), celsius: z.number().min(0).max(400) }),
  z.object({ kind: z.literal('bed_temp'), celsius: z.number().min(0).max(200) }),
  z.object({ kind: z.literal('pause') }),
])

/** Sends one console line: through the host's own call when it has one, else the printer plugin's gcode tool. */
async function sendGcode(ctx: ToolContext, info: PrinterInfo, line: string): Promise<void> {
  const host = ctx.host.printers as typeof ctx.host.printers & { sendGcode?: (id: string, line: string, token: NonNullable<ToolContext['token']>) => Promise<void> }
  if (!ctx.token) throw new Error('Not approved')
  if (host.sendGcode) return host.sendGcode(info.id, line, ctx.token)
  await host.callTool(info.plugin, 'gcode', { printerId: info.id, line }, ctx.token)
}

async function plan(i: { printerId: string; change: Adjustment }, ctx: ToolContext) {
  const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
  if (!info) throw new AdjustRefused(`No printer ${i.printerId}`)
  const status = await ctx.host.printers.status(info.id)
  return { info, planned: planAdjustment(i.change, status, info, materialLimits(status, ctx.kb)) }
}

export function createPrintAdjust() {
  return defineTool({
    name: 'print.adjust',
    version: '1.0.0',
    source: 'plugin',
    permission: 'start',
    description: `Make one change to a running print: part fan, speed factor, nozzle or bed temperature, or pause. Every change shows the user an approval card and runs only if they approve; ${ASSISTANT_NAME} never changes a print on its own. Changes outside the limits check_print listed are refused.`,
    input: z.object({
      printerId: z.string(),
      change: adjustment,
      reason: z.string().min(3).max(200).describe('What you saw that this fixes, in plain words; shown on the card'),
    }),
    printerFor: (i) => i.printerId,
    args: (i) => `${i.printerId} ${i.change.kind}`,
    // A G-code change through an agent (MCP) is run by the hub once a person approves it.
    async agentWork(i, ctx) {
      const { info, planned } = await plan(i, ctx)
      const line = planned.gcode[0]
      if (planned.gcode.length !== 1 || !line) throw new AdjustRefused('Only a single G-code change can wait for a person.')
      return { kind: 'gcode', printerId: info.id, line }
    },
    async approval(i, ctx) {
      const { info, planned } = await plan(i, ctx)
      return {
        title: planned.title,
        lines: [`Why: ${i.reason}`, ...planned.lines, ...(planned.gcode.length ? [`Sends: ${planned.gcode.join(' ; ')}`] : [])],
        printerId: info.id,
        actions:
          i.change.kind === 'pause'
            ? [{ action: 'printer.pause', target: info.id, params: { printerId: info.id } }]
            : planned.gcode.map((line) => ({ action: 'printer.gcode' as const, target: info.id, params: { printerId: info.id, line } })),
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      // Checked again: the print may have moved on while the card was open.
      let p: Awaited<ReturnType<typeof plan>>
      try {
        p = await plan(i, ctx)
      } catch (e) {
        if (e instanceof AdjustRefused) return { ok: false, summary: e.message }
        throw e
      }
      if (i.change.kind === 'pause') await ctx.host.printers.pause(p.info.id, ctx.token)
      else for (const line of p.planned.gcode) await sendGcode(ctx, p.info, line)
      return {
        summary: i.change.kind === 'pause' ? `${p.info.name} paused` : `${p.info.name}: ${p.planned.lines[0] ?? 'changed'}`,
        output: { printerId: p.info.id, change: i.change, sent: p.planned.gcode },
      }
    },
  })
}
