// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The job watch: one listener on the started printer per job. Status events move the job's layer, time left and
// progress; the job's end posts one line (finished, stopped or canceled) and releases the listener, even when the
// printer reports the end twice. A flag from the print watch posts one line per job. The line lands in the chat's
// session log whether or not the chat is on screen.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterEvent, type PrinterHost, type PrinterStatus, type RunJob, type SessionStore } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createPilot, createRunBook, createScriptedClient, DEFAULT_CONFIG, defineTool, runBookFor, watchJob, type RunJobPatch } from '../src/index'

const JOB: RunJob = { printerId: 'p1', fileName: 'clip.gcode', startedAt: '2026-10-20T00:00:00.000Z', state: 'printing' }
const T_END = Date.parse('2026-10-20T01:05:00.000Z')

/** A printer host with one printer, Bay 2, whose events the test sends. */
function fakePrinters() {
  const subs = new Set<(e: PrinterEvent) => void>()
  const subscribe = vi.fn((_id: string, fn: (e: PrinterEvent) => void) => {
    subs.add(fn)
    return () => {
      subs.delete(fn)
    }
  })
  const printers = {
    list: async () => [{ id: 'p1', name: 'Bay 2', vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 }],
    plugins: async () => [],
    subscribe,
  } as unknown as PrinterHost
  return {
    printers,
    subscribe,
    send: (e: PrinterEvent) => {
      for (const fn of [...subs]) fn(e)
    },
    listeners: () => subs.size,
  }
}

const status = (patch: Partial<PrinterStatus> = {}): PrinterEvent => ({ type: 'status', status: { printerId: 'p1', state: 'printing', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '', ...patch } })
const finished: PrinterEvent = { type: 'job_finished', printerId: 'p1', jobName: 'clip', ok: true }

/** Lets the printer's name lookup and the lines waiting on it settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function watched(job: RunJob = JOB) {
  const p = fakePrinters()
  const updates: RunJobPatch[] = []
  const notes: [string, string][] = []
  const stop = watchJob(p.printers, job, { update: (j) => updates.push(j), note: (text, tone) => notes.push([text, tone]) }, { now: () => T_END })
  return { ...p, updates, notes, stop }
}

/** A run book with a watch, its session log and the lines it posted. */
function book() {
  const p = fakePrinters()
  const log: [string, PilotEvent][] = []
  const runs = createRunBook({ fingerprint: () => 'fp' }, () => T_END, { printers: p.printers, log: (sessionId, e) => log.push([sessionId, e]) })
  const notes = () => log.flatMap(([s, e]) => (e.type === 'run_note' ? [[s, e.text, e.tone]] : []))
  return { ...p, runs, log, notes }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the job watch', () => {
  it('status events move the layer and time left', async () => {
    const w = watched()
    expect(w.subscribe).toHaveBeenCalledTimes(1)
    expect(w.subscribe.mock.calls[0]![0]).toBe('p1')
    w.send(status({ layer: 12, layerCount: 100, timeLeftS: 2460, progress: 0.12 }))
    expect(w.updates.at(-1)).toEqual({ state: 'printing', layer: 12, layerCount: 100, timeLeftS: 2460, progress: 12 })
    w.send(status({ layer: 13, layerCount: 100, timeLeftS: 2400, progress: 0.13 }))
    expect(w.updates.at(-1)).toMatchObject({ layer: 13, timeLeftS: 2400, progress: 13 })
    // another printer's status never moves this job
    w.send({ type: 'status', status: { printerId: 'p9', state: 'printing', layer: 90, nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' } })
    expect(w.updates.at(-1)).toMatchObject({ layer: 13 })
    await settle()
    expect(w.notes).toEqual([])
    expect(w.listeners()).toBe(1)
    w.stop()
    expect(w.listeners()).toBe(0)
  })

  it('job_finished posts one finished line and unsubscribes', async () => {
    const w = watched()
    w.send(status({ layer: 99, layerCount: 100 }))
    w.send(finished)
    expect(w.listeners()).toBe(0)
    // a printer that stops reporting a layer or two early still reads as done
    expect(w.updates.at(-1)).toMatchObject({ state: 'finished', outcome: 'finished', endedAt: '2026-10-20T01:05:00.000Z', layer: 100, progress: 100, timeLeftS: 0 })
    await settle()
    expect(w.notes).toEqual([['clip.gcode finished on Bay 2.', 'ok']])
    // stopping a watch that already ended does nothing
    w.stop()
    expect(w.notes).toHaveLength(1)
  })

  it('a finished status after job_finished posts nothing more', async () => {
    const b = book()
    b.runs.recordJob('s1', JOB)
    expect(b.listeners()).toBe(1)
    b.send(finished)
    b.send(status({ state: 'finished', progress: 1 }))
    b.send(finished)
    await settle()
    expect(b.notes()).toEqual([['s1', 'clip.gcode finished on Bay 2.', 'ok']])
    expect(b.listeners()).toBe(0)
    // the run keeps how it ended, and the log has the ended run once
    expect(b.runs.get('s1').job).toMatchObject({ state: 'finished', outcome: 'finished' })
    const ended = b.log.filter(([, e]) => e.type === 'print_run' && e.run.job?.outcome === 'finished')
    expect(ended).toHaveLength(1)
    // and the other way round: a finished status first, then job_finished
    const c = book()
    c.runs.recordJob('s2', JOB)
    c.send(status({ state: 'finished', progress: 1 }))
    c.send(finished)
    await settle()
    expect(c.notes()).toEqual([['s2', 'clip.gcode finished on Bay 2.', 'ok']])
  })

  it('an error posts one stopped line', async () => {
    const w = watched()
    w.send({ type: 'error', printerId: 'p1', code: 'clog', message: 'Nozzle clog detected.' })
    w.send(status({ state: 'error', message: 'Nozzle clog detected' }))
    expect(w.listeners()).toBe(0)
    expect(w.updates.at(-1)).toMatchObject({ state: 'error', outcome: 'failed' })
    await settle()
    expect(w.notes).toEqual([['clip.gcode stopped on Bay 2: Nozzle clog detected.', 'bad']])
    // a status that says error ends it the same way
    const v = watched()
    v.send(status({ state: 'error', message: 'Heater fault' }))
    await settle()
    expect(v.notes).toEqual([['clip.gcode stopped on Bay 2: Heater fault.', 'bad']])
    expect(v.listeners()).toBe(0)
  })

  it('a job that goes from idle straight to an error ends with one line and lets go', async () => {
    const w = watched({ ...JOB, state: 'idle' })
    w.send(status({ state: 'error', message: 'Heater fault' }))
    expect(w.listeners()).toBe(0)
    expect(w.updates.at(-1)).toMatchObject({ state: 'error', outcome: 'failed' })
    w.send(status({ state: 'error', message: 'Heater fault' }))
    await settle()
    expect(w.notes).toEqual([['clip.gcode stopped on Bay 2: Heater fault.', 'bad']])
  })

  it('a pause with a reason posts one warn line per job and keeps the watch', async () => {
    const w = watched()
    w.send(status({ layer: 20, layerCount: 100 }))
    w.send(status({ state: 'paused', message: 'Filament runout', layer: 20, layerCount: 100 }))
    w.send(status({ state: 'paused', message: 'Filament runout', layer: 20, layerCount: 100 }))
    await settle()
    expect(w.notes).toEqual([['Bay 2 paused: Filament runout.', 'warn']])
    expect(w.updates.at(-1)).toMatchObject({ state: 'paused' })
    expect(w.updates.at(-1)?.outcome).toBeUndefined()
    expect(w.listeners()).toBe(1)
    // it resumes and finishes: one end line, and the pause is not said again
    w.send(status({ state: 'printing', layer: 21, layerCount: 100 }))
    w.send(status({ state: 'paused', message: 'Filament runout' }))
    w.send(finished)
    await settle()
    expect(w.notes).toEqual([
      ['Bay 2 paused: Filament runout.', 'warn'],
      ['clip.gcode finished on Bay 2.', 'ok'],
    ])
    // a pause the person asked for, with no reason, says nothing
    const v = watched()
    v.send(status({ state: 'paused' }))
    await settle()
    expect(v.notes).toEqual([])
  })

  it('attention posts one line per job', async () => {
    const b = book()
    b.runs.recordJob('s1', JOB)
    b.send(status({ watch: 'attention', layer: 20 }))
    b.send(status({ watch: 'attention', layer: 21 }))
    b.send(status({ watch: 'watching', layer: 22 }))
    b.send(status({ watch: 'attention', layer: 23 }))
    await settle()
    const line = 'Print watch flagged something on Bay 2. Take a look at the camera.'
    expect(b.notes()).toEqual([['s1', line, 'warn']])
    expect(b.runs.get('s1').job).toMatchObject({ attention: true, layer: 23 })
    // the next print in the chat gets its own line, and the first job's listener is gone
    b.runs.recordJob('s1', { ...JOB, startedAt: '2026-10-20T02:00:00.000Z' })
    expect(b.listeners()).toBe(1)
    b.send(status({ watch: 'attention' }))
    await settle()
    expect(b.notes()).toEqual([
      ['s1', line, 'warn'],
      ['s1', line, 'warn'],
    ])
  })

  it('a canceled job says canceled', async () => {
    // the printer's own job_finished for a canceled job
    const w = watched()
    w.send({ type: 'job_finished', printerId: 'p1', jobName: 'clip', ok: false })
    w.send(status({ state: 'idle' }))
    expect(w.updates.at(-1)).toMatchObject({ state: 'idle', outcome: 'canceled' })
    await settle()
    expect(w.notes).toEqual([['clip.gcode was canceled on Bay 2.', 'warn']])
    expect(w.listeners()).toBe(0)
    // a printer that only goes idle after printing
    const v = watched()
    v.send(status({ layer: 5, layerCount: 100 }))
    v.send(status({ state: 'idle' }))
    await settle()
    expect(v.notes).toEqual([['clip.gcode was canceled on Bay 2.', 'warn']])
    // a status left over from before the start (finished from the last print) does not end a job not printing yet
    const u = watched({ ...JOB, state: 'finished' })
    u.send(status({ state: 'finished' }))
    u.send(status({ state: 'idle' }))
    await settle()
    expect(u.notes).toEqual([])
    expect(u.listeners()).toBe(1)
    u.send(status({ state: 'printing', layer: 1 }))
    u.send(status({ state: 'idle' }))
    await settle()
    expect(u.notes).toEqual([['clip.gcode was canceled on Bay 2.', 'warn']])
  })

  it('a host that cannot listen leaves the job unwatched', async () => {
    const runs = createRunBook({ fingerprint: () => 'fp' }, () => T_END, { printers: {} as PrinterHost })
    expect(runs.recordJob('s1', JOB).job).toEqual(JOB)
    await settle()
    expect(runs.get('s1').job).toEqual(JOB)
  })

  it('window close releases the listener', async () => {
    const page = new EventTarget()
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page))
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page))
    const w = watched()
    expect(w.listeners()).toBe(1)
    page.dispatchEvent(new Event('pagehide'))
    expect(w.listeners()).toBe(0)
    w.send(finished)
    await settle()
    expect(w.notes).toEqual([])
  })

  it('a runtime made again for the same host keeps the run and its watch', async () => {
    const p = fakePrinters()
    const log: [string, PilotEvent][] = []
    const store = { append: async (sessionId: string, e: PilotEvent) => void log.push([sessionId, e]) } as unknown as SessionStore
    const start = defineTool<Record<string, never>>({
      name: 'start.print',
      version: '1',
      description: 'Records a started print',
      source: 'skill',
      permission: 'read',
      input: z.object({}),
      async run(_i, ctx) {
        ctx.run?.recordJob(JOB)
        return { summary: 'Started' }
      },
    })
    const printRun = { fingerprint: () => 'fp' }
    const make = () =>
      createPilot({
        host: { printers: p.printers, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
        config: DEFAULT_CONFIG,
        policy: DEFAULT_POLICY,
        client: createScriptedClient([{ calls: [{ name: 'start.print', args: {} }] }, { text: 'Printing.' }], { chunk: false }),
        builtins: false,
        tools: [start] as never[],
        store,
        printRun,
        now: () => T_END,
      })
    const first = make()
    const offFirst = first.watchRun!('A', () => undefined)
    for await (const _ of first.run('A', 'print it')) void _
    // the app's setup changes as the print starts, and the tab moves to the new runtime
    offFirst()
    const second = make()
    expect(second.printRun!('A')!.job).toMatchObject({ fileName: 'clip.gcode' })
    const seen: PilotEvent[] = []
    const off = second.watchRun!('A', (e) => seen.push(e))
    expect(p.listeners()).toBe(1)
    p.send(finished)
    await settle()
    expect(seen.filter((e) => e.type === 'run_note')).toEqual([{ type: 'run_note', text: 'clip.gcode finished on Bay 2.', tone: 'ok' }])
    expect(log.filter(([, e]) => e.type === 'run_note')).toHaveLength(1)
    expect(second.printRun!('A')!.job).toMatchObject({ outcome: 'finished' })
    off()
  })

  it('a new chat does not stop the watch of a running print', async () => {
    const p = fakePrinters()
    const log: [string, PilotEvent][] = []
    const store = {
      append: async (sessionId: string, e: PilotEvent) => {
        log.push([sessionId, e])
      },
    } as unknown as SessionStore
    const start = defineTool<Record<string, never>>({
      name: 'start.print',
      version: '1',
      description: 'Records a started print',
      source: 'skill',
      permission: 'read',
      input: z.object({}),
      async run(_i, ctx) {
        ctx.run?.recordJob(JOB)
        return { summary: 'Started' }
      },
    })
    const pilot = createPilot({
      host: { printers: p.printers, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'start.print', args: {} }] }, { text: 'Printing.' }, { text: 'Hello.' }], { chunk: false }),
      builtins: false,
      tools: [start] as never[],
      store,
      printRun: { fingerprint: () => 'fp' },
      now: () => T_END,
    })
    const seenA: PilotEvent[] = []
    const offA = pilot.watchRun!('A', (e) => seenA.push(e))
    for await (const _ of pilot.run('A', 'print it')) void _
    expect(p.listeners()).toBe(1)
    // the tab moves to a new chat: the first chat's view lets go, and the new chat runs
    offA()
    const seenB: PilotEvent[] = []
    const offB = pilot.watchRun!('B', (e) => seenB.push(e))
    for await (const _ of pilot.run('B', 'hi')) void _
    expect(p.listeners()).toBe(1)
    p.send(status({ layer: 50, layerCount: 100 }))
    p.send(finished)
    await settle()
    const lines = log.flatMap(([s, e]) => (e.type === 'run_note' ? [[s, e.text]] : []))
    expect(lines).toEqual([['A', 'clip.gcode finished on Bay 2.']])
    expect(pilot.printRun!('A')!.job).toMatchObject({ outcome: 'finished' })
    expect(seenA).toEqual([])
    expect(seenB.some((e) => e.type === 'run_note')).toBe(false)
    expect(p.listeners()).toBe(0)
    offB()
  })
})

describe('the watch follows the printer connection', () => {
  /** A run book shared by runtimes, as runBookFor keeps it, with its session log. */
  function shared() {
    const host = { fingerprint: () => 'fp' }
    const log: [string, PilotEvent][] = []
    const watcher = (p: ReturnType<typeof fakePrinters>) => ({ printers: p.printers, log: (sessionId: string, e: PilotEvent) => void log.push([sessionId, e]) })
    const lines = () => log.flatMap(([s, e]) => (e.type === 'run_note' ? [[s, e.text]] : []))
    return { host, log, watcher, lines }
  }

  it('a reconnect between two prints gives the second print progress and one end line', async () => {
    const b = shared()
    const before = fakePrinters()
    const runs = runBookFor(b.host, () => T_END, b.watcher(before))
    runs.recordJob('s1', JOB)
    before.send(finished)
    await settle()
    expect(before.listeners()).toBe(0)
    // the connection came back: the runtime made again brings the new connection's printers
    const after = fakePrinters()
    expect(runBookFor(b.host, () => T_END, b.watcher(after))).toBe(runs)
    const second: RunJob = { ...JOB, fileName: 'lid.gcode', startedAt: '2026-10-20T02:00:00.000Z' }
    runs.recordJob('s1', second)
    expect(before.subscribe).toHaveBeenCalledTimes(1)
    expect(after.listeners()).toBe(1)
    const seen: PilotEvent[] = []
    const off = runs.watch('s1', (e) => seen.push(e))
    after.send(status({ layer: 30, layerCount: 120, timeLeftS: 1800 }))
    expect(runs.get('s1').job).toMatchObject({ fileName: 'lid.gcode', layer: 30, layerCount: 120, timeLeftS: 1800 })
    expect(seen.filter((e) => e.type === 'print_run')).toHaveLength(1)
    after.send(finished)
    after.send(status({ state: 'finished' }))
    await settle()
    expect(b.lines()).toEqual([
      ['s1', 'clip.gcode finished on Bay 2.'],
      ['s1', 'lid.gcode finished on Bay 2.'],
    ])
    expect(seen.filter((e) => e.type === 'run_note')).toEqual([{ type: 'run_note', text: 'lid.gcode finished on Bay 2.', tone: 'ok' }])
    expect(after.listeners()).toBe(0)
    off()
  })

  it('a running print across a reconnect still ends with exactly one end line', async () => {
    const b = shared()
    const store = { append: async (sessionId: string, e: PilotEvent) => void b.log.push([sessionId, e]) } as unknown as SessionStore
    const start = defineTool<Record<string, never>>({
      name: 'start.print',
      version: '1',
      description: 'Records a started print',
      source: 'skill',
      permission: 'read',
      input: z.object({}),
      async run(_i, ctx) {
        ctx.run?.recordJob(JOB)
        return { summary: 'Started' }
      },
    })
    const make = (printers: PrinterHost) =>
      createPilot({
        host: { printers, approvals: {} as ApprovalHost, llm: {} as LlmTransport },
        config: DEFAULT_CONFIG,
        policy: DEFAULT_POLICY,
        client: createScriptedClient([{ calls: [{ name: 'start.print', args: {} }] }, { text: 'Printing.' }], { chunk: false }),
        builtins: false,
        tools: [start] as never[],
        store,
        printRun: b.host,
        now: () => T_END,
      })
    const before = fakePrinters()
    const first = make(before.printers)
    for await (const _ of first.run('A', 'print it')) void _
    before.send(status({ layer: 40, layerCount: 100 }))
    expect(before.listeners()).toBe(1)
    // the connection dropped and came back: the tab's runtime is made again with the new connection's printers
    const after = fakePrinters()
    const second = make(after.printers)
    expect(before.listeners()).toBe(0)
    expect(after.listeners()).toBe(1)
    // the job moves as it stood, so the new connection's first status carries on from there
    expect(second.printRun!('A')!.job).toMatchObject({ layer: 40, state: 'printing' })
    const seen: PilotEvent[] = []
    const off = second.watchRun!('A', (e) => seen.push(e))
    // the closed connection reports nothing more, and anything it did would not count
    before.send(finished)
    after.send(status({ layer: 41, layerCount: 100 }))
    expect(second.printRun!('A')!.job).toMatchObject({ layer: 41 })
    after.send(finished)
    after.send(status({ state: 'finished' }))
    await settle()
    expect(b.lines()).toEqual([['A', 'clip.gcode finished on Bay 2.']])
    expect(seen.filter((e) => e.type === 'run_note')).toHaveLength(1)
    expect(second.printRun!('A')!.job).toMatchObject({ outcome: 'finished' })
    expect(after.listeners()).toBe(0)
    off()
  })

  it('a runtime made again with the same printers keeps the one listener', () => {
    const b = shared()
    const p = fakePrinters()
    const runs = runBookFor(b.host, () => T_END, b.watcher(p))
    runs.recordJob('s1', JOB)
    runBookFor(b.host, () => T_END, b.watcher(p))
    expect(p.subscribe).toHaveBeenCalledTimes(1)
    expect(p.listeners()).toBe(1)
  })

  it('a print that ended while the connection was away ends on the new connection', async () => {
    const b = shared()
    const before = fakePrinters()
    const runs = runBookFor(b.host, () => T_END, b.watcher(before))
    runs.recordJob('s1', JOB)
    const after = fakePrinters()
    runs.setWatcher(b.watcher(after))
    after.send(status({ state: 'finished' }))
    await settle()
    expect(b.lines()).toEqual([['s1', 'clip.gcode finished on Bay 2.']])
    expect(after.listeners()).toBe(0)
  })
})

describe('the watch reads the current printers', () => {
  /** A run book whose host gives the printers as they are now, as the app's does, with no runtime made again. */
  function live(first: PrinterHost) {
    let current: PrinterHost | undefined = first
    const log: [string, PilotEvent][] = []
    const runs = createRunBook({ fingerprint: () => 'fp', printers: () => current }, () => T_END, { printers: {} as PrinterHost, log: (sessionId, e) => log.push([sessionId, e]) })
    const lines = () => log.flatMap(([, e]) => (e.type === 'run_note' ? [[e.text, e.tone]] : []))
    return { runs, lines, swap: (p: PrinterHost | undefined) => void (current = p) }
  }
  const closed: PrinterEvent = { type: 'error', printerId: 'p1', code: 'closed', message: 'The sx-link connection is closed' }
  /** A dead connection: subscribe answers, then reports the closed connection, as the link client does. */
  function dead() {
    const subscribe = vi.fn((_id: string, fn: (e: PrinterEvent) => void) => {
      void Promise.resolve().then(() => fn(closed))
      return () => undefined
    })
    return { printers: { list: async () => { throw new Error('closed') }, subscribe } as unknown as PrinterHost, subscribe }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a reconnect between two prints gives the second print progress and one end line, with no runtime made again', async () => {
    const before = fakePrinters()
    const b = live(before.printers)
    b.runs.recordJob('s1', JOB)
    before.send(finished)
    await settle()
    // the bridge came back: the host holds the new connection's printers, and nothing else changed
    const after = fakePrinters()
    b.swap(after.printers)
    const second: RunJob = { ...JOB, fileName: 'lid.gcode', startedAt: '2026-10-20T02:00:00.000Z' }
    b.runs.recordJob('s1', second)
    expect(before.subscribe).toHaveBeenCalledTimes(1)
    expect(after.listeners()).toBe(1)
    after.send(status({ layer: 30, layerCount: 120, timeLeftS: 1800 }))
    expect(b.runs.get('s1').job).toMatchObject({ fileName: 'lid.gcode', layer: 30, timeLeftS: 1800 })
    after.send(finished)
    after.send(status({ state: 'finished' }))
    await settle()
    expect(b.lines()).toEqual([
      ['clip.gcode finished on Bay 2.', 'ok'],
      ['lid.gcode finished on Bay 2.', 'ok'],
    ])
    expect(after.listeners()).toBe(0)
  })

  it('a closed connection mid print, then a reconnect, gives no failure line and one real end line', async () => {
    vi.useFakeTimers()
    const before = fakePrinters()
    const b = live(before.printers)
    b.runs.recordJob('s1', JOB)
    before.send(status({ layer: 40, layerCount: 100 }))
    await settle()
    // the link drops: the old connection says it is closed, and the host holds the dead printers for a while
    before.send(closed)
    expect(before.listeners()).toBe(0)
    const gone = dead()
    b.swap(gone.printers)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(gone.subscribe).toHaveBeenCalled()
    // the job is kept as it stood, with no line
    expect(b.runs.get('s1').job).toMatchObject({ state: 'printing', layer: 40 })
    expect(b.runs.get('s1').job?.outcome).toBeUndefined()
    // it came back
    const after = fakePrinters()
    b.swap(after.printers)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(after.listeners()).toBe(1)
    after.send(status({ layer: 41, layerCount: 100 }))
    after.send(finished)
    await settle()
    expect(b.lines()).toEqual([['clip.gcode finished on Bay 2.', 'ok']])
    expect(b.runs.get('s1').job).toMatchObject({ outcome: 'finished' })
    expect(after.listeners()).toBe(0)
  })

  it('a silent drop is followed when the host gets new printers', async () => {
    vi.useFakeTimers()
    const before = fakePrinters()
    const b = live(before.printers)
    b.runs.recordJob('s1', JOB)
    const after = fakePrinters()
    b.swap(after.printers)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(before.listeners()).toBe(0)
    expect(after.listeners()).toBe(1)
    after.send(finished)
    await settle()
    expect(b.lines()).toEqual([['clip.gcode finished on Bay 2.', 'ok']])
  })

  it('a link that stays closed gives up after two minutes with one warn line, never a failure', async () => {
    vi.useFakeTimers()
    const before = fakePrinters()
    const b = live(before.printers)
    b.runs.recordJob('s1', JOB)
    await settle()
    before.send(closed)
    const gone = dead()
    b.swap(gone.printers)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(b.lines()).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(b.lines()).toEqual([['Lost touch with Bay 2 during clip.gcode. Check the printer to see how the print went.', 'warn']])
    expect(b.runs.get('s1').job?.outcome).toBeUndefined()
    const tries = gone.subscribe.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gone.subscribe.mock.calls.length).toBe(tries)
    expect(b.lines()).toHaveLength(1)
  })

  /** Printers whose subscribe fails after `ms`, as the link client reports a failed subscribe: an error event with its code. */
  function failing(code: string, ms = 0) {
    const subscribe = vi.fn((_id: string, fn: (e: PrinterEvent) => void) => {
      setTimeout(() => fn({ type: 'error', printerId: 'p1', code, message: `subscribe failed: ${code}` }), ms)
      return () => undefined
    })
    return { printers: { list: async () => [], subscribe } as unknown as PrinterHost, subscribe }
  }

  for (const code of ['unreachable', 'timeout', 'locked']) {
    it(`a re-subscribe that fails with ${code} is a link drop: no stopped line, and the real end line after`, async () => {
      vi.useFakeTimers()
      const before = fakePrinters()
      const b = live(before.printers)
      b.runs.recordJob('s1', JOB)
      before.send(status({ layer: 40, layerCount: 100 }))
      await settle()
      before.send(closed)
      const bad = failing(code)
      b.swap(bad.printers)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(bad.subscribe.mock.calls.length).toBeGreaterThan(1)
      await settle()
      expect(b.lines()).toEqual([])
      expect(b.runs.get('s1').job).toMatchObject({ state: 'printing', layer: 40 })
      expect(b.runs.get('s1').job?.outcome).toBeUndefined()
      const after = fakePrinters()
      b.swap(after.printers)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(after.listeners()).toBe(1)
      after.send(finished)
      await settle()
      expect(b.lines()).toEqual([['clip.gcode finished on Bay 2.', 'ok']])
    })
  }

  it('re-subscribes that time out slowly still give up with the warn line, never a failure', async () => {
    vi.useFakeTimers()
    const before = fakePrinters()
    const b = live(before.printers)
    b.runs.recordJob('s1', JOB)
    await settle()
    before.send(closed)
    // each try waits longer than a round before it fails
    b.swap(failing('timeout', 7_000).printers)
    await vi.advanceTimersByTimeAsync(300_000)
    await settle()
    expect(b.lines()).toEqual([['Lost touch with Bay 2 during clip.gcode. Check the printer to see how the print went.', 'warn']])
    expect(b.runs.get('s1').job?.outcome).toBeUndefined()
  })

  it('printers that do not have the job (subscribe throws) retry, then give up with the warn line', async () => {
    vi.useFakeTimers()
    const subscribe = vi.fn(() => {
      throw new Error('Unknown printer p1')
    })
    const sim = { list: async () => [], subscribe } as unknown as PrinterHost
    const b = live(sim)
    expect(b.runs.recordJob('s1', JOB).job).toEqual(JOB)
    await vi.advanceTimersByTimeAsync(121_000)
    await settle()
    expect(subscribe.mock.calls.length).toBeGreaterThan(20)
    expect(b.lines()).toEqual([['Lost touch with the printer during clip.gcode. Check the printer to see how the print went.', 'warn']])
    expect(b.runs.get('s1').job?.outcome).toBeUndefined()
  })
})
