// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's print run in the open app, read over the app link (`mimir.run`): for one chat, each step of the run, the last
// slice, what was sent and the print as the printer last reported it. Read only: starting a print stays with
// printer.queue, which waits for the person in the app. Only the fields below reach a client, never the file, its
// SHA-256, a card's token or request id, a printer id, an access code or a serial.
import { assistantText } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

const NOT_THERE = new Set(['app_link_off', 'app_closed', 'forbidden', 'unauthorized'])
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_found', not_ready: 'not_configured', busy: 'busy' }

const STEP_NAMES = ['design', 'plate', 'target', 'slice', 'send', 'print'] as const
const STEP_STATES = ['done', 'now', 'todo', 'off'] as const
const PRINT_STATES = ['idle', 'preparing', 'printing', 'paused', 'finished', 'error', 'offline'] as const
const OUTCOMES = ['finished', 'failed', 'canceled'] as const

type StepName = (typeof STEP_NAMES)[number]
type StepState = (typeof STEP_STATES)[number]
type Outcome = (typeof OUTCOMES)[number]

/** The app's answer to mimir.run (packages/app app-link/mimir-run.ts). */
export interface RunState {
  sessionId: string
  steps: { name: StepName; state: StepState }[]
  slice: { timeS: number; grams: number; cost: number; warnings: string[]; stale: boolean } | null
  send: { printerName: string; fileName: string; slots: { filament: number; slot: string }[] } | null
  print: { printerName: string; state: string; layer: number | null; layerCount: number | null; timeLeftS: number | null; progress: number | null; outcome: Outcome | null } | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}...` : t)
const str = (v: unknown, n: number): string => (typeof v === 'string' ? cut(v, n) : '')
const amount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const seconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/**
 * Only the fields a client needs, so nothing else the app adds can leave it, and an answer of the wrong shape (an
 * older or broken app) reads as safe defaults rather than failing: no steps, no slice, nothing sent, no print. An
 * answer that is not an object reads as null, the answer before the tab first opens.
 */
export function pick(raw: unknown): RunState | null {
  if (!isRecord(raw)) return null
  const seen = new Set<string>()
  const steps: RunState['steps'] = []
  for (const s of Array.isArray(raw['steps']) ? raw['steps'] : []) {
    if (!isRecord(s) || !oneOf(STEP_NAMES, s['name']) || !oneOf(STEP_STATES, s['state']) || seen.has(s['name'])) continue
    seen.add(s['name'])
    steps.push({ name: s['name'], state: s['state'] })
  }
  const slice = isRecord(raw['slice']) ? raw['slice'] : null
  const send = isRecord(raw['send']) ? raw['send'] : null
  const print = isRecord(raw['print']) ? raw['print'] : null
  const progress = print?.['progress']
  return {
    sessionId: str(raw['sessionId'], 200),
    steps,
    slice: slice
      ? {
          timeS: amount(slice['timeS']),
          grams: amount(slice['grams']),
          cost: amount(slice['cost']),
          warnings: (Array.isArray(slice['warnings']) ? slice['warnings'] : []).filter((w): w is string => typeof w === 'string').slice(0, 20).map((w) => cut(w, 300)),
          stale: slice['stale'] === true,
        }
      : null,
    send: send
      ? {
          printerName: str(send['printerName'], 120),
          fileName: str(send['fileName'], 200),
          slots: (Array.isArray(send['slots']) ? send['slots'] : []).flatMap((s) => (isRecord(s) && typeof s['filament'] === 'number' && Number.isInteger(s['filament']) && s['filament'] > 0 && typeof s['slot'] === 'string' ? [{ filament: s['filament'], slot: cut(s['slot'], 16) }] : [])).slice(0, 32),
        }
      : null,
    print: print
      ? {
          printerName: str(print['printerName'], 120),
          state: oneOf(PRINT_STATES, print['state']) ? print['state'] : '',
          layer: count(print['layer']),
          layerCount: count(print['layerCount']),
          timeLeftS: seconds(print['timeLeftS']),
          progress: typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 100 ? progress : null,
          outcome: oneOf(OUTCOMES, print['outcome']) ? print['outcome'] : null,
        }
      : null,
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** 3100 s reads "52 min", 3720 s "1 h 2 min". */
function duration(s: number): string {
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

function summaryOf(run: RunState, appName: string): string {
  const where = (name: string) => name || 'a printer'
  let now: string
  if (run.print?.outcome) {
    now = `the print on ${where(run.print.printerName)} ${run.print.outcome === 'canceled' ? 'was canceled' : run.print.outcome}`
  } else if (run.print) {
    const p = run.print
    now = [`${p.state || 'printing'} on ${where(p.printerName)}`, ...(p.layer !== null && p.layerCount !== null ? [`layer ${p.layer} of ${p.layerCount}`] : []), ...(p.progress !== null ? [`${p.progress}%`] : []), ...(p.timeLeftS !== null && p.timeLeftS > 0 ? [`${duration(p.timeLeftS)} left`] : [])].join(', ')
  } else if (run.send) {
    now = `sent ${run.send.fileName || 'a file'} to ${where(run.send.printerName)}`
  } else {
    now = 'nothing sent to a printer yet'
  }
  const by = (state: StepState) => run.steps.filter((s) => s.state === state).map((s) => s.name)
  const parts = [['done', by('done')], ['now', by('now')], ['off', by('off')]].flatMap(([label, names]) => (names!.length ? [`${label as string}: ${(names as string[]).join(', ')}`] : []))
  const steps = parts.length ? ` ${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : ''
  const s = run.slice
  const slice = s ? ` Last slice: ${duration(s.timeS)}, ${s.grams} g, ${plural(s.warnings.length, 'warning')}${s.stale ? '; the plate, printer or slots changed after it, so slice again before sending' : ''}.` : ' Not sliced yet.'
  return `mimir session ${run.sessionId || '(none yet)'} in ${appName}: ${now}.${steps}${slice}`
}

export function mimirRunTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const run = defineTool({
    name: 'mimir.run',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: assistantText(`Read back mimir's print run in the open ${appName} app for one chat (the chat the mimir tab has open, else the newest mimir session, unless sessionId names another), never the file, its SHA-256, a card's token or request id, an access code or a serial: each step (design, plate, target, slice, send, print) as done, now, todo or off; the last slice's time, grams, cost, warnings and whether the plate, printer or slots changed after it (stale); what was sent (the printer's name, the file name and which slot feeds each filament); and the print as the printer last reported it (state, layer, time left, progress and how it ended). Null before the tab first opens. Starting a print stays with slicerx_printer_queue, which waits for the person in the app.`),
    input: z.object({ sessionId: z.string().min(1).max(200).optional().describe('A session id, the sessionId slicerx_mimir_ask returns or the id slicerx_mimir_session takes; the chat the mimir tab has open when left out, else the newest mimir session') }),
    async run(i) {
      if (!link) throw new ToolInputError(`reading mimir's print run needs the open ${appName} app: start the server with --printers link and turn on the app link`, 'not_configured')
      let out: unknown
      try {
        out = await link.call<unknown>('mimir.run', i.sessionId ? { sessionId: i.sessionId } : {})
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (NOT_THERE.has(code) || (code === 'bad_request' && message.startsWith('unknown method'))) {
          throw new ToolInputError(`the app link to ${appName} does not answer (${code}): open the app, turn on the app link and allow this client`, 'not_configured')
        }
        throw new ToolInputError(message, CODES[code] ?? 'internal_error')
      }
      const output = pick(out)
      if (!output) return { summary: assistantText(`The mimir tab in ${appName} has not opened yet, so there is no print run to read.`), output: null }
      return { summary: assistantText(summaryOf(output, appName)), output }
    },
  })
  return [run] as PilotTool<never>[]
}
