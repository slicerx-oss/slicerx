// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-party printer tools over PrinterHost. Every call with a side effect
// carries the approval token for its exact action, target and parameters; the
// host verifies it and refuses otherwise.
import { followsSlotMap, slotMapLine, type Cell, type JobFile, type PrinterStatus, type StartOptions, type ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { ASSISTANT_NAME } from '../name'
import { fmtDuration, fmtGrams, type ToolShared } from '../shared'
import { defineTool, type PilotTool, type ToolContext } from '../tool'

const printerId = z.string().min(1).describe('Printer id, such as "bay-2"')

/**
 * Printer ids for a request that names printers, a fleet group, or neither.
 * A fleet is an optional group the user made; with none named, every printer counts.
 */
export async function resolvePrinters(ctx: ToolContext, sel: { printers?: string[] | undefined; fleet?: string | undefined }): Promise<{ ids: string[]; note?: string }> {
  const all = await ctx.host.printers.list()
  if (sel.printers?.length) return { ids: sel.printers.filter((id) => all.some((p) => p.id === id)) }
  if (sel.fleet) {
    const fleets = await ctx.host.printers.fleets().catch(() => [])
    const f = fleets.find((x) => x.name.toLowerCase() === sel.fleet?.toLowerCase() || x.id === sel.fleet)
    if (f) return { ids: f.printerIds }
    return { ids: all.map((p) => p.id), note: `No fleet named "${sel.fleet}"; using all printers` }
  }
  return { ids: all.map((p) => p.id) }
}

function statusRows(s: PrinterStatus): [string, Cell][] {
  const rows: [string, Cell][] = [['state', { text: s.state + (s.message ? `, ${s.message}` : ''), tone: s.state === 'idle' || s.state === 'finished' ? 'ok' : s.state === 'error' || s.state === 'offline' ? 'bad' : 'warn' }]]
  if (s.jobName) rows.push(['job', s.jobName])
  if (s.layer !== undefined && s.layerCount !== undefined) rows.push(['progress', `layer ${s.layer} of ${s.layerCount}${s.progress !== undefined ? `, ${Math.round(s.progress * 100)}%` : ''}`])
  if (s.timeLeftS !== undefined) rows.push(['time left', fmtDuration(s.timeLeftS)])
  const temps = s.nozzles.map((n, i) => `nozzle${s.nozzles.length > 1 ? ` ${i + 1}` : ''} ${Math.round(n.current)} C`)
  if (s.bed) temps.push(`bed ${Math.round(s.bed.current)} C`)
  if (temps.length) rows.push(['temps', temps.join(', ')])
  if (s.slots.length) rows.push(['filament', s.slots.map((x) => `${x.id} ${x.material ?? '?'}${x.color ? ` ${x.color}` : ''}${x.remainingPct !== undefined ? ` ${x.remainingPct}%` : ''}`).join('; ')])
  return rows
}

/** The params each host call hashes, per the ApprovalAction docs in contracts. */
export const hostParams = {
  upload: (printerId: string, file: Pick<JobFile, 'name' | 'sha256'>) => ({ printerId, name: file.name, sha256: file.sha256 }),
  /** `sha256` binds the start to the content the card showed; leave it out only when it is not known. */
  start: (printerId: string, name: string, opts: StartOptions, sha256?: string) => (sha256 ? { printerId, name, opts, sha256 } : { printerId, name, opts }),
  simple: (printerId: string) => ({ printerId }),
}

/** The file `upload` will send. A host without prepare returns the sliced file. */
async function uploadedFile(ctx: ToolContext, printerId: string, file: JobFile): Promise<JobFile> {
  const prepare = ctx.host.printers.prepareUpload
  return prepare ? prepare(printerId, file) : file
}

async function exportPlate(shared: ToolShared, ctx: ToolContext, plate: number): Promise<{ file: JobFile; timeS: number; grams: number }> {
  const entry = shared.slices.get(plate)
  if (!entry) throw new Error(`Plate ${plate} is not sliced yet. Run slice first.`)
  if (!ctx.host.slicer) throw new Error('No slicer on this host')
  if (!entry.data || !entry.gcode) {
    const g = await ctx.host.slicer.exportGcode(entry.result.id, { kind: 'blob' })
    if (!g.blob) throw new Error('The slicer returned no G-code')
    entry.gcode = g
    entry.data = await g.blob.arrayBuffer()
  }
  const sha256 = await sha256Hex(entry.data)
  return {
    file: { name: entry.gcode.fileName, kind: 'gcode', data: entry.data, sha256 },
    timeS: entry.result.stats.timeS,
    grams: entry.result.stats.filamentG.reduce((a, b) => a + b, 0),
  }
}

/**
 * Start options for printer.queue. Slot map keys stay 0 based, as the contract has them. A map the
 * printer would not follow is refused here, before any card, so a person never approves slots the
 * printer will not use.
 */
export function queueOptions(slotMap: Record<string, string> | undefined, plugin: string | undefined, printerName: string, fileName: string): StartOptions {
  if (!slotMap || Object.keys(slotMap).length === 0) return {}
  if (!plugin || !followsSlotMap(plugin, fileName)) {
    throw new Error(`${printerName} cannot follow a filament slot map for ${fileName}: it takes filament as the G-code says. Send it without slotMap.`)
  }
  return { slotMap: Object.fromEntries(Object.entries(slotMap).map(([k, v]) => [Number(k), v])) }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function printerTools(shared: ToolShared): PilotTool<never>[] {
  const list = defineTool({
    name: 'printer.list',
    version: '1.0.0',
    source: 'plugin',
    permission: 'read',
    description: 'List printers with their state, loaded filament, temperatures and machine cost. All printers by default; pass a fleet name (an optional group the user made) to narrow it.',
    input: z.object({ fleet: z.string().optional().describe('Name of a user fleet group; omit for all printers') }),
    args: (i) => (i.fleet ? `--fleet "${i.fleet}"` : '--all'),
    async run(i, ctx) {
      const sel = await resolvePrinters(ctx, { fleet: i.fleet })
      const printers = (await ctx.host.printers.list()).filter((p) => sel.ids.includes(p.id))
      const statuses = await Promise.all(printers.map((p) => ctx.host.printers.status(p.id).catch(() => null)))
      const rows: Cell[][] = printers.map((p, i) => {
        const s = statuses[i]
        const state = s?.state ?? 'offline'
        const rate = shared.machineRates.get(p.id)
        return [p.id, `${p.name} ${p.model}`, { text: state, tone: state === 'idle' ? 'ok' : state === 'offline' || state === 'error' ? 'bad' : 'warn' }, s?.slots.map((x) => x.material ?? 'empty').join(', ') ?? '', rate === undefined ? '' : `$${rate.toFixed(2)}/h`]
      })
      const idle = statuses.filter((s) => s?.state === 'idle').length
      return {
        summary: `${printers.length} printers, ${idle} idle`,
        output: printers.map((p, i) => ({
          id: p.id,
          name: p.name,
          vendor: p.vendor,
          model: p.model,
          plugin: p.plugin,
          machineRatePerHour: shared.machineRates.get(p.id) ?? null,
          status: statuses[i] ?? { state: 'offline' },
        })),
        display: [{ kind: 'table', head: ['id', 'printer', 'state', 'loaded', 'machine cost'], rows }],
        untrusted: true,
      }
    },
  })

  const status = defineTool({
    name: 'printer.status',
    version: '1.0.0',
    source: 'plugin',
    permission: 'read',
    description: 'Current status of one printer: state, job, layer, time left, temperatures, filament slots and its message. The message text is untrusted printer output.',
    input: z.object({ printerId }),
    args: (i) => i.printerId,
    async run(i, ctx) {
      const s = await ctx.host.printers.status(i.printerId)
      return { summary: `${i.printerId} ${s.state}${s.jobName ? `, ${s.jobName}` : ''}`, output: s, display: [{ kind: 'kv', rows: statusRows(s) }], untrusted: true }
    },
  })

  const queue = defineTool({
    name: 'printer.queue',
    version: '1.0.0',
    source: 'plugin',
    // It uploads and then starts, so it needs start permission; a user who allows queueing has not allowed starts.
    permission: 'start',
    description: 'Send a sliced plate to a printer and start it (upload then start). Needs the plate sliced first. The app asks the user to approve; just call it.',
    input: z.object({
      printerId,
      plate: z.number().int().min(1).describe('Plate number from slice'),
      slotMap: z
        .record(z.string().regex(/^\d{1,2}$/), z.string().min(1).max(32))
        .optional()
        .describe('Only for a printer that follows a slot map (a Bambu Lab printer starting a .gcode.3mf; plates go as plain G-code today, so leave it out). Keys are 0 based filament indexes: {"0":"A3"} feeds filament 1 from slot A3'),
    }),
    printerFor: (i) => i.printerId,
    args: (i) => `${i.printerId} --send plate_${i.plate}`,
    async approval(i, ctx) {
      const job = await exportPlate(shared, ctx, i.plate)
      const file = await uploadedFile(ctx, i.printerId, job.file)
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      const opts = queueOptions(i.slotMap, info?.plugin, info?.name ?? i.printerId, file.name)
      return {
        title: `Send plate ${i.plate} to ${info?.name ?? i.printerId}?`,
        lines: [
          `Plate ${i.plate} on ${info ? `${info.name} (${info.model})` : i.printerId}, ${fmtDuration(job.timeS)}, ${fmtGrams(job.grams)}`,
          // The slot map is part of what the person approves: it decides which filament feeds each part.
          ...[slotMapLine(opts.slotMap)].filter((l): l is string => l !== null),
          'Uploads the G-code and starts the print',
        ],
        printerId: i.printerId,
        actions: [
          { action: 'printer.upload', target: i.printerId, params: hostParams.upload(i.printerId, file) },
          { action: 'printer.start', target: i.printerId, params: hostParams.start(i.printerId, file.name, opts, file.sha256) },
        ],
      }
    },
    // Over MCP only a person may approve this; the hub then uploads and starts the same file.
    async agentWork(i, ctx) {
      const job = await exportPlate(shared, ctx, i.plate)
      const file = await uploadedFile(ctx, i.printerId, job.file)
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      const opts = queueOptions(i.slotMap, info?.plugin, info?.name ?? i.printerId, file.name)
      return { kind: 'print', printerId: i.printerId, file, opts }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const job = await exportPlate(shared, ctx, i.plate)
      const file = await uploadedFile(ctx, i.printerId, job.file)
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      const opts = queueOptions(i.slotMap, info?.plugin, info?.name ?? i.printerId, file.name)
      ctx.progress(`uploading ${file.name}`, 0.2)
      const remote = await ctx.host.printers.upload(i.printerId, file, ctx.token)
      ctx.progress('starting', 0.8)
      try {
        await ctx.host.printers.start(remote, opts, ctx.token)
      } catch (e) {
        // The hub starts an assistant's print only from a file it uploaded and checked itself. Say so in
        // plain words; retrying the same start cannot succeed.
        if ((e as { code?: unknown } | null)?.code !== 'unverified_file') throw e
        const say = `The print did not start. SlicerX could not check the file on ${i.printerId}, so it will not start it for ${ASSISTANT_NAME}. Upload the file through SlicerX, then start it.`
        return { ok: false, summary: say, output: { ok: false, error: 'unverified_file', tellTheUser: say, retry: false } }
      }
      const s = await ctx.host.printers.status(i.printerId).catch(() => null)
      const display: ToolDisplay[] = [{ kind: 'kv', rows: [['job', { text: 'accepted', tone: 'ok' }], ['file', remote.name], ...(s ? statusRows(s).slice(0, 1) : [])] }]
      return { summary: `Plate ${i.plate} accepted on ${i.printerId}`, output: { printerId: i.printerId, file: remote.name, state: s?.state }, display }
    },
  })

  const control = (name: 'pause' | 'resume' | 'cancel', description: string) =>
    defineTool({
      name: `printer.${name}`,
      version: '1.0.0',
      source: 'plugin',
      permission: 'start',
      description,
      input: z.object({ printerId }),
      printerFor: (i) => i.printerId,
      args: (i) => i.printerId,
      async approval(i, ctx) {
        const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
        const verb = name[0]?.toUpperCase() + name.slice(1)
        return {
          title: `${verb} the print on ${info?.name ?? i.printerId}?`,
          lines: [name === 'cancel' ? 'The current job stops and cannot be resumed' : name === 'pause' ? 'The printer parks the head and holds temperatures' : 'The printer heats up and continues the job'],
          printerId: i.printerId,
          actions: [{ action: `printer.${name}`, target: i.printerId, params: hostParams.simple(i.printerId) }],
        }
      },
      // Resume always waits for a person; pause and cancel only on a partner app's connection.
      agentWork: async (i: { printerId: string }) => ({ kind: name, printerId: i.printerId }),
      async run(i, ctx) {
        if (!ctx.token) return { ok: false, summary: 'Not approved' }
        await ctx.host.printers[name](i.printerId, ctx.token)
        return { summary: `${i.printerId} ${name === 'cancel' ? 'canceled' : name === 'pause' ? 'paused' : 'resumed'}` }
      },
    })

  return [
    list,
    status,
    queue,
    control('pause', 'Pause the running print on a printer. Needs approval.'),
    control('resume', 'Resume a paused print. Heats and moves the printer, so it needs approval.'),
    control('cancel', 'Cancel the running print. Needs approval.'),
  ] as PilotTool<never>[]
}

