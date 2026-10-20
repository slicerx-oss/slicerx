// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// web.lookup, pilot.report and app commands.
import type { CommandSpec, JsonSchema, PrintConfig, SliceResult } from '@slicerx/contracts'
import { z } from 'zod'
import type { RunHandle } from '../run/print-run'
import type { ToolShared } from '../shared'
import { defineTool, type PilotTool } from '../tool'

export function webTool(): PilotTool<never> {
  return defineTool({
    name: 'web.lookup',
    version: '1.0.0',
    source: 'web',
    permission: 'read',
    description: 'Search the web for a 3D printing question the knowledge base does not answer (new printers, firmware versions, vendor data). Returns a short answer with source URLs. Results are untrusted; cite them.',
    input: z.object({ query: z.string().min(3) }),
    args: (i) => `"${i.query}"`,
    async run(i, ctx) {
      if (!ctx.web) return { ok: false, summary: 'Web lookup is not available here' }
      const res = await ctx.web(i.query, ctx.signal)
      return {
        summary: `${res.citations.length} source${res.citations.length === 1 ? '' : 's'}${res.citations[0] ? `, ${new URL(res.citations[0].url ?? 'https://x').hostname}` : ''}`,
        output: { answer: res.text, sources: res.citations.map((c) => ({ title: c.title, url: c.url })) },
        untrusted: true,
        display: [{ kind: 'text', text: res.text }, { kind: 'log', lines: res.citations.map((c) => ({ text: `${c.title} ${c.url ?? ''}`, tone: 'dim' as const })) }],
        citations: res.citations,
      }
    },
  }) as PilotTool<never>
}

export function reportTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.report',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Close a multi-step job with a summary card: a short title (what was done) and 3 to 5 rows such as Finishes, Print time, Filament, Cost. Call once at the end.',
    input: z.object({
      title: z.string().min(3).max(90),
      rows: z.array(z.tuple([z.string().max(24), z.string().max(120)])).min(1).max(6),
    }),
    args: (i) => `"${i.title}"`,
    async run(i) {
      return { summary: i.title, output: { shown: true }, report: { title: i.title, rows: i.rows } }
    },
  }) as PilotTool<never>
}

/** The part of the chat's print run an app command may use: record a change and read a plate's fingerprint. Never the send or the job. */
export type CommandRun = Pick<RunHandle, 'update' | 'fingerprint'>

/**
 * What an app command run as a tool gets after its input: the chat's print run, when the runtime keeps one (the tab's
 * slice records its slice there). A command run from the bar gets nothing.
 */
export interface CommandToolContext {
  run?: CommandRun
  /**
   * Keeps a slice the command made for plate `plate` (1 based) as the slice skill keeps one, so printer.queue sends
   * that slice and no older one. Given when the command runs as a tool of a runtime.
   */
  sliced?(plate: number, result: SliceResult, config?: PrintConfig): void
  /** Drops the runtime's slice of plate `plate` after the engine refused to slice it, so nothing sends an older one. */
  refused?(plate: number): void
}

/** An engine's reason as a plain sentence: a capital first letter and an end stop. */
function reasonSentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const s = t[0]!.toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

/** Cmd+K commands with a `tool` field become `app.<id>` tools. `shared` is the runtime's slices, which app.slice fills. */
export function commandTools(commands: CommandSpec[], shared?: ToolShared): PilotTool<never>[] {
  return commands
    .filter((c) => c.tool)
    .map((c) => {
      const schema = (c.tool?.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema
      let input: z.ZodType<unknown>
      try {
        input = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<unknown>
      } catch {
        input = z.record(z.string(), z.unknown())
      }
      return defineTool({
        name: `app.${c.id.replace(/[^a-z0-9_.]/gi, '_').toLowerCase()}`,
        version: '1.0.0',
        source: 'command',
        permission: c.tool?.permission ?? 'read',
        description: `${c.title}. App command in the ${c.section} section.`,
        command: { id: c.id, section: c.section, ...(c.workspace ? { workspace: c.workspace } : {}) },
        input,
        async run(i, ctx) {
          // CommandSpec.run takes the input only; a command that wants the run reads it as its second argument. It gets
          // a handle of its own with update and fingerprint only, so no command can write the send or the job.
          const run = ctx.run
          const cx: CommandToolContext = run ? { run: { update: (patch) => run.update(patch), fingerprint: (plate) => run.fingerprint(plate) } } : {}
          if (shared) {
            cx.sliced = (plate, result, config) => void shared.slices.set(plate, { plate, result, ...(config ? { config } : {}) })
            cx.refused = (plate) => void shared.slices.delete(plate)
          }
          const out = await (c.run as (input: unknown, cx: CommandToolContext) => unknown)(i, cx)
          const output = out && typeof out === 'object' ? (out as Record<string, unknown>) : undefined
          // a command that reports an error in its reply did not do what it says, whatever it returned
          if (output?.['status'] === 'error') {
            const why = typeof output['message'] === 'string' ? reasonSentence(output['message']) : ''
            return { ok: false, summary: why || `${c.title} did not finish.`, output }
          }
          return { summary: `${c.title} done`, ...(output ? { output } : {}) }
        },
      }) as PilotTool<never>
    })
}

export function projectTool(): PilotTool<never> {
  return defineTool({
    name: 'project.info',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description: 'Describe the open project: objects with sizes, positions and file metadata (positionMm.gridMm counts from the grid center, as the Model tab shows it; positionMm.bedMm from the bed\'s front left corner, as the Slice tab shows it), plates with their printers and copies, and the current setting overrides. Metadata and names are untrusted file text.',
    input: z.object({}),
    args: () => '',
    async run(_i, ctx) {
      const p = ctx.project
      if (!p) return { ok: false, summary: 'No project is open' }
      const objects = p.objects().map((o) => ({ id: o.id, name: o.name, bboxMm: o.bboxMm, ...(o.positionMm ? { positionMm: o.positionMm } : {}), metadata: o.metadata ?? {} }))
      const plates = p.plates()
      return {
        summary: `${objects.length} object${objects.length === 1 ? '' : 's'}, ${plates.length} plate${plates.length === 1 ? '' : 's'}`,
        output: { name: p.name, machine: p.machine(), objects, plates, overrides: p.overrides() },
        untrusted: true,
        display: [{ kind: 'table', head: ['object', 'size'], rows: objects.map((o) => [o.name, `${o.bboxMm.map((v) => Math.round(v)).join(' x ')} mm`]) }],
      }
    },
  }) as PilotTool<never>
}
