// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The page side of the agent bridge (dev and test builds only, docs/agent-bridge.md). The desktop shell sends each tool
// call here and returns the answer to the running-app MCP server. Reads come from the app's store and the capture;
// acts go through the controls and commands a person uses (the Vault sheet's Open button, the Slice and Clear the
// plate commands), so a bridge run exercises the app's own paths. Nothing here prints, sends to a printer or deletes.
import type { EditionHost, SliceWarning } from '@slicerx/contracts'
import { isEnabled, listCommands, runCommand, type RunResult } from '../commands/registry'
import { resolveSlots } from '../filament/slots'
import { spoolParts } from '../filament/pick'
import { activeMeta, allPlates } from '../plate/plates'
import { printBlock } from '../plate/heimdall'
import { needsSlice, resumeState } from '../plate/resume-tops'
import { objectWarnings } from '../plate/object-list'
import { jobFileName } from '../state/actions'
import { openTiming, viewTiming } from '../lib/open-timing'
import { geomCalls } from '../geom/client'
import { quietLofts } from '../cad/history/exact-flag'
import { geomWorkers } from '../geom/worker-memory'
import { sliceTiming } from '../lib/slice-timing'
import { get, setWorkspace, type AppState } from '../state/store'
import type { Capture, LogKind } from './capture'
import { BridgeError, click, elements, fill, pressKey, testids, waitFor } from './dom'
import { loadFaces } from './fonts'
import { moveSpool, spoolsView } from './spools'
import { setSettingsView } from './settings'
import { settingsView } from '../workspaces/prepare/settings-view'
import { autoSliceMode } from '../state/auto-slice-mode'
import { autoSlicePending } from '../state/auto-slice'
import { cadShown } from '../state/model-mode'
import { sketchMode, sketchModeText } from '../cad/sketch-mode'
import { layerView } from '../workspaces/preview/layer-keys'
import { slicePanes } from '../lib/slice-panes'
import { uiState } from './ui-state'

export { BridgeError } from './dom'

type Args = Record<string, unknown>

const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** How long app_slice waits, with auto slice on, for a slice to start after its own one ended out of date (ms). */
const ENDED_GRACE_MS = 1_000

/** The last slice as an agent reads it: status, and for a finished one its time, filament, layers and warnings. */
export function sliceSummary(s: AppState): Record<string, unknown> {
  const sl = s.slice
  // The auto slice choice, and whether it is holding this plate's big slice for Slice.
  const auto = { autoSlice: s.autoSlice, autoSliceMode: autoSliceMode(s), ...(s.autoSlice && s.sliceHeld ? { held: true } : {}) }
  switch (sl.status) {
    case 'idle':
      return { status: 'idle', ...auto }
    case 'running':
      return { status: 'running', ...auto, startedAt: new Date(sl.startedAt).toISOString(), ...(sl.progress ? { progress: sl.progress } : {}) }
    case 'error':
      // `code` names a refusal the bridge's clients act on: resume_void (the kept resume plan no longer matches the plate).
      return { status: 'error', ...auto, message: sl.message, ...(sl.code ? { code: sl.code } : {}) }
    case 'done': {
      const r = sl.result
      const grams = r.stats.filamentG.reduce((a, b) => a + b, 0)
      return {
        status: 'done',
        ...auto,
        // Out of date also when an edit since changed its G-code (a rename, a layer mark): needsSlice, the rule the plate
        // list, the footer and app_export_gcode read.
        stale: sl.stale || needsSlice(s),
        id: r.id,
        engine: r.engine,
        layers: r.layerCount,
        timeS: Math.round(r.stats.timeS),
        filamentG: Math.round(grams * 100) / 100,
        filamentGPerSlot: r.stats.filamentG.map((g) => Math.round(g * 100) / 100),
        toolChanges: r.stats.toolChanges,
        wallMs: Math.round(r.wallMs),
        fileName: jobFileName(s, r.fileName),
        warnings: r.warnings.map(warning),
        // The chamber cooling mode the printer's G-code got (chamber_cooling_mode) and where it came from, when it reads one.
        ...(r.chamberCooling ? { chamberCooling: r.chamberCooling } : {}),
      }
    }
  }
}

function warning(w: SliceWarning): Record<string, unknown> {
  return { code: w.code, message: w.message, ...(w.objectId ? { objectId: w.objectId } : {}), ...(w.layer !== undefined ? { layer: w.layer } : {}) }
}

/** The open sketch as the view's mode pill shows it, or null. */
function sketchState(): Record<string, unknown> | null {
  const m = sketchMode()
  if (!m) return null
  // what the drawing is as a profile, how defined it is, whether Extrude or Revolve can run (and why not), and the
  // loops as drawn, so a client checks the sketch the way the panel does
  const more = m.profile === undefined ? {} : { profile: m.profile, dof: m.dof ?? null, ready: m.ready ?? false, reason: m.reason ?? null, loops: m.loops ?? [] }
  return { on: m.on, label: m.label, tool: m.tool, mode: sketchModeText(m), ...more }
}

/** The app as an agent reads it: the tab, the plate with each object's parts and warnings, the printer and filament, and slicing. */
export function appState(s: AppState): Record<string, unknown> {
  // A slice an edit since put out of date (needsSlice: a rename, a layer mark too) says nothing of the plate as it is.
  const warnings = s.slice.status === 'done' && !needsSlice(s) ? s.slice.result.warnings : []
  const inUse = spoolParts(s.plate, activeMeta(s))
  return {
    tab: s.workspace,
    // The plate tabs' mode (mimir, design or slice), as the tab bar shows it.
    ...(s.workspace === 'prepare' ? { mode: cadShown() ? s.modelMode : 'slice' } : {}),
    // Settings > Look and feel > Toolbar size: the Model ribbon's icons at 32, 24 or 16 px.
    toolbarSize: s.appearance.toolbarSize,
    // Settings > Look and feel > Frame the view: 'selection' frames each pick, 'open' only Model opening and adds.
    modelFraming: s.appearance.modelFraming,
    plate: {
      loading: s.plateLoading,
      active: s.activePlate,
      plates: s.plates.map((p) => ({ id: p.id, name: p.name, objects: p.id === s.activePlate ? s.plate.length : p.objects.length })),
      objects: s.plate.map((e) => ({
        id: e.id,
        name: e.name,
        printable: e.printable !== false,
        ...(e.locked ? { locked: true } : {}),
        ...(e.instanceOf ? { instanceOf: e.instanceOf } : {}),
        triangles: e.handle.triangles,
        sizeMm: e.handle.bboxMm.map((v) => Math.round(v * 100) / 100),
        parts: e.handle.parts.map((p) => ({ name: p.name, slot: e.slotOverrides?.[p.name] ?? p.slot, triangles: p.triangles })),
        ...(e.volumes?.length ? { volumes: e.volumes.map((v) => ({ name: v.name, role: v.role })) } : {}),
        ...(e.source?.modelId ? { vaultListing: e.source.modelId } : {}),
        // What the object list shows on the row (off the bed, a missing filament), then the last slice's warnings.
        listWarnings: objectWarnings(e, s).map((w) => ({ kind: w.kind, text: w.text })),
        warnings: warnings.filter((w) => w.objectId === e.id).map(warning),
      })),
      warnings: warnings.filter((w) => !w.objectId || !s.plate.some((e) => e.id === w.objectId)).map(warning),
    },
    printer: {
      id: s.printerId,
      ...(s.printerModel ? { vendor: s.printerModel.vendor, model: s.printerModel.model } : {}),
      ...(s.profile ? { nozzleMm: s.profile.nozzle, profile: s.profile.source, tier: s.profile.tier } : {}),
      noPrinter: s.noPrinter,
    },
    // Each slot with its label ("A1"), whether the printer has a spool in it and how many parts on this plate print with it.
    filament: resolveSlots(s).map((r) => ({ slot: r.index, label: r.label, used: r.used, inUse: inUse.get(r.index)?.parts ?? 0, loaded: Boolean(s.printerSlots[r.index - 1]?.material || s.printerSlots[r.index - 1]?.color), type: r.type, brand: r.brand, color: r.color, source: r.source })),
    slicing: sliceSummary(s),
    // The kept resume plan: its plate and whether it still holds (a plate whose plan does not hold does not slice).
    resume: resumeState(s),
    // The print settings panel: the open tab, its sections and whether each is open, the pins, and the changes.
    settings: settingsView(s),
    setupOpen: s.setup !== null,
    // The 3D view's standing notice (drawn without hardware acceleration); a phone shows it in the top bar, not as a toast.
    ...(s.viewNotice ? { viewNotice: s.viewNotice } : {}),
    unsavedPrompt: s.unsavedPrompt?.what ?? null,
    multiBodyPrompt: s.multiBodyPrompt,
    // An open sketch: where it draws (face, bed, plane, or a sketch opened again), the panel's words for it, the
    // drawing tool, and the view's mode pill as it reads ("Sketching on a face · Line"). Null with no sketch open.
    sketch: sketchState(),
    // The printer bridge: off, connecting, on, reconnecting (after a dropped connection, with the try it is on) or error.
    // While it reconnects the printer cards show their last known state and their controls are off (`cardsDisabled`).
    printerBridge: { state: s.bridgeStatus.state, ...(s.bridgeStatus.attempt ? { attempt: s.bridgeStatus.attempt } : {}), ...(s.bridgeStatus.state === 'reconnecting' ? { cardsDisabled: true } : {}), ...(s.bridgeStatus.state === 'error' && s.bridgeStatus.message ? { message: s.bridgeStatus.message } : {}) },
    // Where the time of the last file open went (lib/open-timing.ts), or null before the first open.
    lastOpen: openTiming(),
    // How long the 3D view took to its first frame, or null before it.
    view: viewTiming(),
    // What the geometry engine answered, and its workers alive now with the engine memory each holds (geom/worker-memory.ts).
    // exactLofts: new lofts the native engine made on the mesh this session, with each step's reason (exact-flag.ts).
    geometry: { ...geomCalls(), workers: geomWorkers(), exactLofts: quietLofts() },
    // The big buffers the page keeps: every plate's meshes (each buffer once) and the slice preview.
    memory: pageMemory(s),
    lastSlice: sliceTiming(),
  }
}

/** The bytes of every plate's meshes (parts and volumes, each buffer once) and of the slice preview on hand. */
export function pageMemory(s: AppState): { meshBytes: number; meshBuffers: number; previewBytes: number } {
  const seen = new Set<ArrayBufferLike>()
  const add = (a: ArrayBufferView | undefined) => {
    if (a) seen.add(a.buffer)
  }
  for (const p of allPlates(s))
    for (const o of p.objects) {
      for (const part of o.parts) {
        add(part.positions)
        add(part.indices)
      }
      for (const v of o.volumes ?? []) {
        add(v.part.positions)
        add(v.part.indices)
      }
    }
  let meshBytes = 0
  for (const b of seen) meshBytes += b.byteLength
  return { meshBytes, meshBuffers: seen.size, previewBytes: s.preview?.raw.byteLength ?? 0 }
}

/**
 * Which export commands the app offers now, as the File menu and the command palette show them. The mesh exports
 * (STL, OBJ) stay off while the plate holds a Vault design, which is how a sealed download reads.
 */
export function exportCommands(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const c of listCommands()) if (c.id.startsWith('export-') || c.id.startsWith('project-export')) out[c.id] = isEnabled(c)
  return out
}

export interface PageBridge {
  /** Hands over the host once the app has made it; calls that need it wait for this. */
  attach(host: EditionHost): void
  handle(tool: string, args: Args): Promise<unknown>
}

export function createPageBridge(capture: Capture, doc: Document = document): PageBridge {
  let host: EditionHost | null = null
  const needHost = (): EditionHost => {
    if (!host) throw new BridgeError('not_ready', 'the app is still starting')
    return host
  }
  const since = (a: Args) => num(a['since'], 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = (a: Args) => num(a['limit'], 200, 1, 1000)
  const log = (kind: LogKind) => (a: Args) => capture.read(kind, since(a), limit(a))

  /** Waits until `done` returns a value, an error toast shows since `mark`, or the time runs out. */
  async function until<T>(done: () => T | null, timeoutMs: number, mark: number, what: string): Promise<T> {
    const started = Date.now()
    for (;;) {
      const v = done()
      if (v !== null) return v
      const failed = capture.read('toast', mark).entries.find((t) => t['tone'] === 'error')
      if (failed) throw new BridgeError('not_ready', `${what} failed: ${String(failed['text'])}`)
      if (Date.now() - started > timeoutMs) {
        const open = capture.openDialogs()
        throw new BridgeError('timeout', `${what} did not finish in ${timeoutMs} ms${open.length ? `; open: ${open.map((d) => d.title || d.testid).join(', ')}` : ''}`)
      }
      await sleep(150)
    }
  }

  async function openVaultDesign(a: Args): Promise<unknown> {
    const store = needHost().store
    if (!store) throw new BridgeError('not_ready', 'this build has no Vault')
    const timeoutMs = num(a['timeoutMs'], 120_000, 1_000, 900_000)
    let id: string | null = null
    let title = ''
    if (typeof a['id'] === 'string' && a['id']) {
      const d = await store.getListing(a['id'])
      if (!d) throw new BridgeError('not_found', `no Vault design ${a['id']}`)
      id = d.listing.id
      title = d.listing.title
    } else if (typeof a['title'] === 'string' && a['title'].trim()) {
      const want = a['title'].trim().toLowerCase()
      const { items } = await store.listListings({ query: a['title'].trim(), limit: 50 })
      const exact = items.filter((c) => c.listing.title.toLowerCase() === want)
      const pick = exact.length === 1 ? exact[0] : exact.length === 0 && items.length === 1 ? items[0] : undefined
      if (!pick) throw new BridgeError(items.length ? 'invalid_input' : 'not_found', items.length ? `"${a['title']}" matches ${items.map((c) => c.listing.title).slice(0, 8).join(', ')}; give the id` : `no Vault design titled ${a['title']}`)
      id = pick.listing.id
      title = pick.listing.title
    } else throw new BridgeError('invalid_input', 'give the listing id (or slug) or its title')
    const listing = id
    const mark = capture.marker()
    // The person's path: the Vault tab, the design's sheet, then its Open button.
    setWorkspace('feed')
    const { openListing } = await import('../features/store/sheets')
    openListing(listing)
    await waitFor(doc, 'vault-detail-open', 'enabled', Math.min(timeoutMs, 30_000))
    click(doc, 'vault-detail-open')
    const plate = await until(
      () => {
        const s = get()
        if (s.unsavedPrompt) throw new BridgeError('not_ready', `the app asks whether to save before it ${s.unsavedPrompt.what}; answer the dialog, then open the design again`)
        const failed = doc.querySelector('[data-testid="vault-listing-sheet"] [data-testid="vault-download-status"][data-state="error"]')
        if (failed) throw new BridgeError('not_ready', `the download failed: ${((failed.querySelector('.lib-dl-msg') ?? failed).textContent ?? '').replace(/\s+/g, ' ').trim()}`)
        if (doc.querySelector('[data-testid="vault-listing-sheet"] [data-testid="signin-notice"]')) throw new BridgeError('not_ready', 'the Vault asks to sign in before this download')
        return !s.plateLoading && s.plate.some((e) => e.source?.modelId === listing) ? s : null
      },
      timeoutMs,
      mark,
      `Opening ${title}`,
    )
    return { listing: { id: listing, title }, state: appState(plate) }
  }

  async function slice(a: Args): Promise<unknown> {
    needHost()
    const timeoutMs = num(a['timeoutMs'], 300_000, 1_000, 900_000)
    const s = get()
    if (s.plate.length === 0) throw new BridgeError('not_ready', 'the plate is empty')
    if (!needsSlice(s) && a['force'] !== true) return sliceSummary(s)
    // The Slice command slices only the plate shown when it starts (slicePlate `plate`); another plate shown before
    // that slice lands leaves the plate asked for with none.
    const asked = s.activePlate
    const name = s.plates.find((p) => p.id === asked)?.name ?? 'the plate'
    const mark = capture.marker()
    const toastBefore = s.toast
    // What was on screen before: a slice that lands for this call counts up slicesDone, and an error it ends in is a new
    // slice state, so an earlier slice or error is never handed back as this call's answer.
    const doneBefore = s.slicesDone
    const sliceBefore = s.slice
    // The Slice command, as the button and Ctrl+Enter run it. A refusal (nothing printable, say) comes back at once.
    const run = runCommand('slice')
    const early = await Promise.race([run, sleep(100).then(() => null)])
    if (early && !early.ok) throw new BridgeError('not_ready', early.message)
    // When the command ended (its slice landed, or it stopped with nothing to slice), and how. With nothing slicing
    // after that and none about to start, no current slice is coming: auto slice is off, or it holds the slice (a drag
    // still going, a big plate held for Slice). A slice auto slice has pending for an edit made while the command ran
    // is waited for; the grace covers the moment before its watch has seen the edit.
    let ended: number | null = null
    let result: RunResult | null = null
    void run.then((r) => {
      result = r
      ended = Date.now()
    })
    const out = await until(
      () => {
        const now = get()
        if (now.activePlate !== asked) throw new BridgeError('not_ready', `another plate was shown before ${name} finished slicing, so no slice was kept for it; show it and slice again`)
        if (now.projectGcode?.asking) throw new BridgeError('not_ready', 'the app asks whether to use the project\'s own printer G-code; answer the dialog, then slice again')
        if (now.slice.status === 'error' && now.slice !== sliceBefore) return now
        if (!needsSlice(now) && now.slicesDone !== doneBefore) return now
        if (ended === null || now.slice.status === 'running') return null
        if (now.autoSlice && (autoSlicePending() || Date.now() - ended <= ENDED_GRACE_MS)) return null
        return now
      },
      timeoutMs,
      mark,
      'Slicing',
    )
    if (out.slice.status === 'error' && out.slice !== sliceBefore) return sliceSummary(out)
    // The command failed after the first look (the profile, the code it loads), or no slice landed for this call: say
    // why, never with the slice from before. A slice that landed out of date comes back as it is, with `stale: true`.
    const failed = result as RunResult | null
    if (failed && !failed.ok) throw new BridgeError('not_ready', failed.message)
    if (out.slicesDone === doneBefore) {
      const said = out.toast !== toastBefore ? out.toast?.text : undefined
      throw new BridgeError('not_ready', `${name} was not sliced${said ? `: ${said}` : ''}`)
    }
    return sliceSummary(out)
  }

  async function clearPlate(): Promise<unknown> {
    // Cleared: one empty plate and nothing an opened project brought.
    const cleared = () => {
      const s = get()
      return s.plate.length === 0 && s.plates.length === 1 && s.plates.every((p) => p.objects.length === 0) && s.projectSettings === null && s.projectPrinter === null
    }
    if (cleared()) return { cleared: true, state: appState(get()) }
    const run = runCommand('plate-clear')
    for (let i = 0; i < 40; i++) {
      if (cleared()) {
        await run
        return { cleared: true, state: appState(get()) }
      }
      if (get().unsavedPrompt) return { cleared: false, asking: get().unsavedPrompt?.what, dialogs: capture.openDialogs() }
      await sleep(50)
    }
    return { cleared: cleared(), state: appState(get()) }
  }

  async function user(): Promise<unknown> {
    const store = needHost().store
    if (!store) return { signedIn: false, vault: false }
    const s = await store.session()
    return s ? { signedIn: true, userId: s.userId, email: s.email ?? null } : { signedIn: false }
  }

  function exportInfo(): unknown {
    const s = get()
    if (s.slice.status !== 'done') throw new BridgeError('not_ready', 'slice the plate first')
    // The G-code on hand is from before the last change to the plate, its settings or what goes into its G-code (an
    // object's name, a layer mark); it is not what the plate shows.
    if (needsSlice(s)) throw new BridgeError('refused', 'the plate changed after the last slice; slice it again, then export')
    const unsafe = printBlock(s)
    if (unsafe) throw new BridgeError('refused', unsafe)
    return { id: s.slice.result.id, fileName: jobFileName(s, s.slice.result.fileName) }
  }

  const tools: Record<string, (a: Args) => unknown> = {
    // `panes`: Slice's right pane, the playback bar, the toolhead and gantry switches and the toolbar, as on screen.
    // `selection`, `tool`, `panels` and `camera`: what is selected and picked, the active tool, every panel and window
    // open, and where the camera is (agent-bridge/ui-state.ts).
    state: () => ({ ...appState(get()), ...uiState(get(), doc), panes: slicePanes(get(), doc), exports: exportCommands(), dialogs: capture.openDialogs(), toasts: capture.visibleToasts(), marker: capture.marker() }),
    toasts: log('toast'),
    // The layer slider, one layer mode, the legend and the jump field, as the layer keys and commands leave them.
    layers: () => layerView(),
    dialogs: (a) => ({ ...log('dialog')(a), open: capture.openDialogs() }),
    console: log('console'),
    network: log('network'),
    user,
    element: (a) => ({ matches: elements(doc, a['testid']) }),
    testids: (a) => testids(doc, a['all'] !== true),
    click: (a) => click(doc, a['testid'], num(a['index'], 0, 0, 1000)),
    fill: (a) => fill(doc, a['testid'], a['value'], num(a['index'], 0, 0, 1000)),
    press_key: (a) => pressKey(doc, { key: a['key'], testid: a['testid'], ctrl: a['ctrl'], shift: a['shift'], alt: a['alt'], meta: a['meta'] }),
    wait_for: (a) => waitFor(doc, a['testid'], a['state'], num(a['timeoutMs'], 10_000, 0, 900_000), a['text']),
    open_vault_design: openVaultDesign,
    clear_plate: clearPlate,
    slice,
    export_info: exportInfo,
    // The Filament section: the spools and what a click on one moves, then that move.
    spools: () => spoolsView(get()),
    move_to_spool: moveSpool,
    // The print settings panel: open a tab and sections, pin settings.
    settings_view: setSettingsView,
    fonts: async (a) => ({ faces: await loadFaces(doc.fonts, Array.isArray(a['families']) ? a['families'].filter((x): x is string => typeof x === 'string') : null) }),
  }

  return {
    attach(h) {
      host = h
    },
    async handle(tool, args) {
      const fn = tools[tool]
      if (!fn) throw new BridgeError('invalid_input', `the page has no tool ${tool}`)
      return fn(args ?? {})
    },
  }
}
