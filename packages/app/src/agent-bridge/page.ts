// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The page side of the agent bridge (dev and test builds only, docs/agent-bridge.md). The desktop shell sends each tool
// call here and returns the answer to the running-app MCP server. Reads come from the app's store and the capture;
// acts go through the controls and commands a person uses (the Vault sheet's Open button, the Slice and Clear the
// plate commands), so a bridge run exercises the app's own paths. Nothing here prints, sends to a printer or deletes.
import type { EditionHost, SliceWarning } from '@slicerx/contracts'
import { isEnabled, listCommands, runCommand } from '../commands/registry'
import { resolveSlots } from '../filament/slots'
import { printBlock } from '../plate/heimdall'
import { objectWarnings } from '../plate/object-list'
import { jobFileName } from '../state/actions'
import { get, setWorkspace, type AppState } from '../state/store'
import type { Capture, LogKind } from './capture'
import { BridgeError, click, elements, fill, pressKey, testids, waitFor } from './dom'

export { BridgeError } from './dom'

type Args = Record<string, unknown>

const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The last slice as an agent reads it: status, and for a finished one its time, filament, layers and warnings. */
export function sliceSummary(s: Pick<AppState, 'slice' | 'plate' | 'plates' | 'activePlate' | 'autoSlice'>): Record<string, unknown> {
  const sl = s.slice
  switch (sl.status) {
    case 'idle':
      return { status: 'idle', autoSlice: s.autoSlice }
    case 'running':
      return { status: 'running', autoSlice: s.autoSlice, startedAt: new Date(sl.startedAt).toISOString(), ...(sl.progress ? { progress: sl.progress } : {}) }
    case 'error':
      return { status: 'error', autoSlice: s.autoSlice, message: sl.message }
    case 'done': {
      const r = sl.result
      const grams = r.stats.filamentG.reduce((a, b) => a + b, 0)
      return {
        status: 'done',
        autoSlice: s.autoSlice,
        stale: sl.stale,
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
      }
    }
  }
}

function warning(w: SliceWarning): Record<string, unknown> {
  return { code: w.code, message: w.message, ...(w.objectId ? { objectId: w.objectId } : {}), ...(w.layer !== undefined ? { layer: w.layer } : {}) }
}

/** The app as an agent reads it: the tab, the plate with each object's parts and warnings, the printer and filament, and slicing. */
export function appState(s: AppState): Record<string, unknown> {
  const warnings = s.slice.status === 'done' && !s.slice.stale ? s.slice.result.warnings : []
  return {
    tab: s.workspace,
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
    filament: resolveSlots(s).map((r) => ({ slot: r.index, used: r.used, type: r.type, brand: r.brand, color: r.color, source: r.source })),
    slicing: sliceSummary(s),
    setupOpen: s.setup !== null,
    unsavedPrompt: s.unsavedPrompt?.what ?? null,
  }
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
    if (s.slice.status === 'done' && !s.slice.stale && a['force'] !== true) return sliceSummary(s)
    const mark = capture.marker()
    // The Slice command, as the button and Ctrl+Enter run it. A refusal (nothing printable, say) comes back at once.
    const run = runCommand('slice')
    const early = await Promise.race([run, sleep(100).then(() => null)])
    if (early && !early.ok) throw new BridgeError('not_ready', early.message)
    const out = await until(
      () => {
        const now = get()
        if (now.projectGcode?.asking) throw new BridgeError('not_ready', 'the app asks whether to use the project\'s own printer G-code; answer the dialog, then slice again')
        return now.slice.status === 'done' && !now.slice.stale ? now : now.slice.status === 'error' ? now : null
      },
      timeoutMs,
      mark,
      'Slicing',
    )
    return sliceSummary(out)
  }

  async function clearPlate(): Promise<unknown> {
    if (get().plate.length === 0) return { cleared: true, state: appState(get()) }
    const run = runCommand('plate-clear')
    for (let i = 0; i < 40; i++) {
      if (get().plate.length === 0) {
        await run
        return { cleared: true, state: appState(get()) }
      }
      if (get().unsavedPrompt) return { cleared: false, asking: get().unsavedPrompt?.what, dialogs: capture.openDialogs() }
      await sleep(50)
    }
    return { cleared: get().plate.length === 0, state: appState(get()) }
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
    // The G-code on hand is from before the last change to the plate or its settings; it is not what the plate shows.
    if (s.slice.stale) throw new BridgeError('refused', 'the plate changed after the last slice; slice it again, then export')
    const unsafe = printBlock(s)
    if (unsafe) throw new BridgeError('refused', unsafe)
    return { id: s.slice.result.id, fileName: jobFileName(s, s.slice.result.fileName) }
  }

  const tools: Record<string, (a: Args) => unknown> = {
    state: () => ({ ...appState(get()), exports: exportCommands(), dialogs: capture.openDialogs(), toasts: capture.visibleToasts(), marker: capture.marker() }),
    toasts: log('toast'),
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
