// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window as the person sees it, over the app link: ui.get reads the workspace and the first tab's mode, the
// selection on the shown plate, the plate shown, the printer chosen and the panels open. ui.set switches the workspace
// and tab, which changes only what the window shows (read class). ui.select sets the selection and opens and closes
// panels, which the person's next click or key acts on (edit class). Neither changes the project: showing a plate is
// plates.show's, and the printer is read here and picked by the person. Printer ids stay in the app (a serial on some
// printers), as do access codes and addresses. ui.get also reads the shown slice's collisions, each with the plate
// objects it names by id, the part struck, where and the region struck, so a client can select them with ui.select,
// or pick one with collision.show (edit class) as a click on the collision's row does.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { OPEN_PANELS } from '../agent-bridge/ui-state'
import { currentEdition } from '../edition'
import { clearSelection } from '../plate/select'
import { cameraBus, toolStore } from '../plate/tools'
import { settingsSections } from '../shell/settings-sections'
import { cadShown, hostSlices, mimirOn, modelMode } from '../state/model-mode'
import { offeredFeatureSettings, offeredWorkspaces } from '../state/offered'
import { get, selectedIds, set, setModelMode, setRail, setWorkspace, type AppState, type ModelMode, type PlateEntry } from '../state/store'
import { byObjectReadback } from '@slicerx/settings/by-object'
import { activeClearance } from '../plate/sequence-check'
import { engineVerdict } from '../plate/engine-check'
import { resolveConfig } from '../adapters/config'
import { areaOrigin, pointToPlate } from '../plate/bed-origin'
import { collisionParts, collisionsOf, damagedOf } from '../plate/heimdall'
import { LinkError } from './methods-error'
import { namesOf } from './mimir-run'
import { PREVIEW_BUSY_TOOLS } from './preview-guard'

/** The panels ui.select opens and closes, by the name ui.get reads them. */
const SETTABLE = ['settings', 'command', 'about', 'shortcuts', 'expert', 'printerChooser', 'printerSettings'] as const
type Settable = (typeof SETTABLE)[number]
/** These live in Slice's left pane: opening one shows Slice with that pane open, as their commands do. */
const IN_SLICE: readonly Settable[] = ['expert', 'printerChooser', 'printerSettings']

const TABS: readonly ModelMode[] = ['slice', 'design', 'mimir']
const TAB_NAMES: Record<ModelMode, string> = { slice: 'Slice', design: 'Model', mimir: ASSISTANT_NAME }

/** The first tab's modes this window shows. */
function tabs(): ModelMode[] {
  return TABS.filter((t) => (t === 'slice' ? hostSlices() : t === 'design' ? cadShown() : mimirOn()))
}

/** The Settings section on screen, read from the dialog, else the one asked for; null while Settings is shut. */
function settingsSection(s: AppState): string | null {
  if (!s.settingsOpen) return null
  const shown = document.querySelector('.settings-nav [aria-current="true"]')?.getAttribute('data-testid')
  return shown?.startsWith('settings-nav-') ? shown.slice('settings-nav-'.length) : s.settingsSection
}

/** The printer the project slices for: its name, make and model and the nozzle in use, never its id. */
async function printerState(s: AppState) {
  const id = s.printerId
  if (!id) return null
  const project = s.projectPrinter
  // an opened project's own printer, while the project is open
  if (project && id === project.id) {
    return { name: `${project.model} ${project.nozzle} from ${project.source}`, vendor: project.vendor, model: project.model, nozzleMm: project.nozzle, fromProject: true }
  }
  const name = (await namesOf([id])).get(id) ?? null
  const model = s.printerModel && (s.printerModel.id === undefined || s.printerModel.id === id) ? s.printerModel : null
  if (name === null && !model) return null
  return { name, vendor: model?.vendor ?? null, model: model?.model ?? null, nozzleMm: s.profile?.nozzle ?? null, fromProject: false }
}

/**
 * The collisions of the slice on screen, null before a slice: each with its index, kind, severity and the piece of the
 * machine, the plate objects it names (printing first, by id and name), the zone or the prime tower it meets when that
 * is no plate object, its layers counted from 1, the part it strikes (damaged, a hit only), where it goes deepest and
 * the region struck (plate mm, from the printable area's front left corner, as the plate counts), and picked while its
 * row is. `stale` when the plate changed since the slice.
 */
export function collisionsReadback(s: Pick<AppState, 'slice' | 'plate'> & Partial<Pick<AppState, 'strikePick' | 'easy' | 'overrides'>>) {
  if (s.slice.status !== 'done') return null
  const named = (id: string) => ({ id, name: s.plate.find((e) => e.id === id)?.name ?? null })
  // The engine works in the printer's coordinates; the plate counts from the printable area's corner.
  const origin = s.easy ? areaOrigin(resolveConfig(s.easy, s.overrides ?? {})['printable_area']) : ([0, 0] as const)
  const mm = (p: readonly [number, number, number]) => pointToPlate(p, origin).map((v) => Math.round(v * 100) / 100) as [number, number, number]
  return {
    stale: s.slice.stale === true,
    items: collisionsOf(s).map((c, index) => {
      const objects = collisionParts(s, c)
      const damaged = c.severity === 'hit' ? damagedOf(s, c) : null
      return {
        index,
        kind: c.kind,
        severity: c.severity,
        part: c.part,
        objects: objects.map(named),
        ...(objects.includes(c.hitId) ? {} : { zone: c.hitId }),
        firstLayer: c.layer + 1,
        lastLayer: c.lastLayer + 1,
        damaged: damaged ? named(damaged) : null,
        contactPoint: mm(c.worstPoint),
        contactBox: c.contactMin && c.contactMax && c.severity === 'hit' ? { min: mm(c.contactMin), max: mm(c.contactMax) } : null,
        picked: s.strikePick === index,
      }
    }),
  }
}

/**
 * heimdall's plate check the window holds for the shown plate, null where the host has none (the web) or before it
 * first ran: the request's number, its status (running, done or error), current when its answer is for the plate as it
 * sits (the warning then shows it in place of the footprint rule), how long the engine took, each collision with its
 * certainty (sure: the slice refuses it; slice_decides: only the slice can tell) and the objects it names, the fixes,
 * and what it leaves to the slice with the objects near enough for it to matter.
 */
export function plateCheckReadback(s: AppState) {
  const c = s.plateCheck
  if (c.status === 'idle') return null
  const named = (id: string) => ({ id, name: s.plate.find((e) => e.id === id)?.name ?? null })
  const r = c.result
  return {
    requestId: c.id,
    status: c.status,
    current: engineVerdict(s) !== null,
    micros: r?.micros ?? null,
    collisions: (r?.collisions ?? []).map((x, index) => ({ index, kind: x.kind, severity: x.severity, part: x.part, certainty: r!.certainty[index]!, objects: [named(x.hitId), named(x.objectId)] })),
    fixes: r?.collisionFixes ?? [],
    unchecked: (r?.unchecked ?? []).map((u) => ({ object: named(u.objectId), what: u.what, near: u.near.map(named) })),
  }
}

/**
 * collision.show: `index` (from ui.get's collisions) picks that collision as a click on its row does: its parts become
 * the selection, ringed on the bed, the part it hits outlined and the region struck filled, and the view frames them
 * only when they are off screen. `frame: true` frames them either way; `jump: true` also plays the head to the moment
 * and turns the camera to the strike, as Jump does. It shows Slice when another tab is up. Busy and checked as
 * ui.select is. Answers with the collisions read back, the selection, and whether the camera moved.
 */
export async function showCollision(args: Record<string, unknown>) {
  const keys = ['index', 'frame', 'jump']
  const extra = Object.keys(args).filter((k) => !keys.includes(k))
  if (extra.length) throw new LinkError('invalid_input', `collision.show takes ${keys.join(', ')} only, not ${extra.join(', ')}`)
  const { index, frame, jump } = args
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new LinkError('invalid_input', 'index is a collision index from ui.get, counted from 0')
  if ((frame !== undefined && typeof frame !== 'boolean') || (jump !== undefined && typeof jump !== 'boolean')) throw new LinkError('invalid_input', 'frame and jump are true or false')
  const s = get()
  if (s.slice.status !== 'done') throw new LinkError('not_found', 'no slice is shown; slice the plate first')
  const list = collisionsOf(s)
  if (!list[index]) throw new LinkError('not_found', list.length ? `no collision ${index}; the slice has ${list.length}, counted from 0` : 'the slice has no collisions')
  if (!hostSlices()) throw new LinkError('not_found', 'this window has no Slice tab')
  const why = windowBusy(s)
  if (why) throw busy(why)
  idle(s)
  if (s.workspace !== 'prepare' || s.modelMode !== 'slice') setModelMode('slice')
  const { jumpTo, pickCollision } = await import('../plate/heimdall-jump')
  // A row's click frames only when the parts are off screen; the camera says whether it moved.
  const bus = cameraBus()
  let moved = false
  const show = bus?.showSelection
  if (bus && show) bus.showSelection = (o) => (moved = show.call(bus, o) || moved)
  try {
    if (jump === true) {
      jumpTo(index, { frame: frame === true })
      moved = true
    } else {
      pickCollision(index)
      if (frame === true) {
        bus?.zoomToSelection?.({ animate: true })
        moved = true
      }
    }
  } finally {
    if (bus && show) bus.showSelection = show
  }
  const after = get()
  return { picked: index, selection: selectedIds(after).filter((id) => after.plate.some((e) => e.id === id)), cameraMoved: moved, collisions: collisionsReadback(after) }
}

export async function readUi() {
  const s = get()
  const at = s.plates.findIndex((p) => p.id === s.activePlate)
  const plate = s.plates[at]
  const named = (id: string) => ({ id, name: s.plate.find((e) => e.id === id)?.name ?? null })
  const ids = selectedIds(s).filter((id) => s.plate.some((e) => e.id === id))
  const primary = s.selection && ids.includes(s.selection) ? s.selection : null
  const open: string[] = (Object.keys(OPEN_PANELS) as (keyof typeof OPEN_PANELS)[]).filter((k) => s[OPEN_PANELS[k]] === true)
  if (s.setup !== null) open.push('setup')
  return {
    workspace: s.workspace,
    workspaces: offeredWorkspaces().map((w) => ({ ...w })),
    tab: modelMode(),
    tabs: tabs(),
    selection: { primary: primary ? named(primary) : null, objects: [...(primary ? [primary] : []), ...ids.filter((id) => id !== primary)].map(named) },
    plate: { number: at + 1, id: plate?.id ?? s.activePlate, name: plate?.name ?? '', count: s.plates.length },
    printer: await printerState(s),
    panels: { open, settingsSection: settingsSection(s), settable: [...SETTABLE] },
    // Printing by object: the shown plate's clearance plan, the warning's pairs and the zones on the bed; null by layer.
    byObject: ((plan) => (plan ? { ...byObjectReadback(plan), engine: plateCheckReadback(s) } : null))(activeClearance(s)),
    collisions: collisionsReadback(s),
  }
}

/** The object a client names on the shown plate, by id or by name. A copy's name finds the object it copies. */
function find(plate: readonly PlateEntry[], object: unknown): PlateEntry {
  if (typeof object !== 'string' || !object) throw new LinkError('invalid_input', 'each selected object is an id or a name from plate.list')
  const byId = plate.find((e) => e.id === object)
  if (byId) return byId
  const named = plate.filter((e) => e.name === object && !e.instanceOf)
  if (named.length > 1) throw new LinkError('invalid_input', `${named.length} objects are named ${object}; name one by id: ${named.map((e) => e.id).join(', ')}`)
  if (!named[0]) throw new LinkError('not_found', `no object ${object} on the shown plate; plate.list lists them`)
  return named[0]
}

/** A tab, a workspace or a selection never changes under a tool the person has open or a step they are changing. */
function idle(s: AppState): void {
  if (s.objectTool !== null || s.historyEdit !== null || PREVIEW_BUSY_TOOLS.includes(toolStore.getState().tool)) {
    throw new LinkError('busy', 'the person is using a tool or changing a step; try again when they are done')
  }
}

/** What the window is in the middle of that no change may cover or cut short, in plain words; null when nothing. */
function windowBusy(s: AppState): string | null {
  if (s.setup !== null || s.agreementOpen) return 'first-run setup or the agreement covers the window; the person finishes it first'
  if (s.plateLoading) return 'a file is opening; try again once it is open'
  if (s.printSheet !== null) return 'the print sheet is open; the person finishes it first'
  if (s.projectOpenAsk !== null || s.projectGcode?.asking) return 'the app is asking the person about the project they opened; try again once they have answered'
  if (document.querySelector('.pair-dialog')) return 'the person is pairing a phone in Settings; try again once they are done'
  return null
}

/** Dialogs over the whole window: two never share it, and one sits over the panels in Slice's pane. */
const MODAL: readonly Settable[] = ['settings', 'command', 'about', 'shortcuts', 'printerSettings']
const NAMES: Record<Settable, string> = { settings: 'Settings', command: 'The command bar', about: 'About', shortcuts: 'Keyboard shortcuts', expert: 'Expert settings', printerChooser: 'The printer list', printerSettings: 'Printer settings' }

const typed = (selector: string, within: ParentNode = document): boolean => [...within.querySelectorAll<HTMLInputElement>(selector)].some((i) => i.value.trim() !== '')

/**
 * Whether the person has something under way in a panel that closing it, or switching it away, would lose: text typed
 * in its search or command box, or in Settings a rename open or a code, address, key or preset name typed and not saved.
 * A person's panel and a client's look the same, so either counts.
 */
function underWay(panel: Settable): boolean {
  if (panel === 'command') return typed('.sx-palette-input')
  if (panel === 'expert') return typed('#expert-search')
  if (panel === 'printerSettings') return typed('#ps-search')
  if (panel !== 'settings') return false
  const dialog = document.querySelector('.settings-dialog')
  return dialog !== null && (dialog.querySelector('[id^="pn-"]') !== null || typed('#bridge-code, #key-search, [id^="ps-"], input[data-testid^="connected-app-"]', dialog))
}

const busy = (message: string): LinkError => new LinkError('busy', message)

/** ui.set's arguments: they change only what the window shows, as the preview does. */
const VIEW_KEYS = ['workspace', 'tab']
/** ui.select's: what is selected and which panels are open, which a person's next click acts on, so an edit. */
const SELECT_KEYS = ['selection', 'open', 'section', 'close']

/**
 * ui.set: `workspace` (an id from ui.get's workspaces) or `tab` (slice, design or mimir; it opens the first
 * workspace). Busy and checked as ui.select is. Answers with ui.get's read-back.
 */
export function setUi(args: Record<string, unknown>) {
  return change('ui.set', VIEW_KEYS, args)
}

/**
 * ui.select: `selection` (ids or names on the shown plate, the primary first; [] selects nothing), `open` (a panel
 * from ui.get's panels.settable, with `section` for Settings) and `close` (one of them, or all). It opens only the
 * panel asked for and closes only the ones named, and never one with the person's work under way: where a change would
 * have to close or cover something, or the window is busy (a file opening, the print sheet, a question about an opened
 * project, a phone being paired), it answers busy. Answers with ui.get's read-back.
 */
export function selectUi(args: Record<string, unknown>) {
  return change('ui.select', SELECT_KEYS, args)
}

/** Everything is checked before anything changes, so a refused call changes nothing. */
async function change(method: string, keys: readonly string[], args: Record<string, unknown>) {
  const extra = Object.keys(args).filter((k) => !keys.includes(k))
  if (extra.length) throw new LinkError('invalid_input', `${method} takes ${keys.join(', ')} only, not ${extra.join(', ')}`)
  if (keys.every((k) => args[k] === undefined)) throw new LinkError('invalid_input', `give at least one of ${keys.filter((k) => k !== 'section').join(', ')}`)
  const s = get()
  const { workspace, tab, selection, open, section, close } = args

  if (workspace !== undefined) {
    const offered = offeredWorkspaces()
    if (typeof workspace !== 'string' || !offered.some((w) => w.id === workspace)) throw new LinkError('invalid_input', `workspace is one of ${offered.map((w) => w.id).join(', ')}`)
  }
  if (tab !== undefined) {
    if (!TABS.includes(tab as ModelMode)) throw new LinkError('invalid_input', `tab is one of ${TABS.join(', ')}`)
    if (!tabs().includes(tab as ModelMode)) throw new LinkError('not_found', `this window has no ${TAB_NAMES[tab as ModelMode]} tab`)
    if (workspace !== undefined && workspace !== 'prepare') throw new LinkError('invalid_input', 'a tab is in the first workspace (prepare); give one or the other')
  }
  let picked: string[] | undefined
  if (selection !== undefined) {
    if (!Array.isArray(selection)) throw new LinkError('invalid_input', 'selection is a list of object ids or names, the primary first; [] selects nothing')
    picked = [...new Set(selection.map((o) => find(s.plate, o).id))]
  }
  if (open !== undefined && !SETTABLE.includes(open as Settable)) throw new LinkError('invalid_input', `open is one of ${SETTABLE.join(', ')}`)
  if (close !== undefined && close !== 'all' && !SETTABLE.includes(close as Settable)) throw new LinkError('invalid_input', `close is all or one of ${SETTABLE.join(', ')}`)
  if (open !== undefined && open === close) throw new LinkError('invalid_input', 'open and close name the same panel')
  if (section !== undefined) {
    if (open !== 'settings') throw new LinkError('invalid_input', 'section goes with open: settings')
    const offered = settingsSections(currentEdition(), offeredFeatureSettings())
    if (typeof section !== 'string' || !offered.some((x) => x.id === section)) throw new LinkError('invalid_input', `section is one of ${offered.map((x) => x.id).join(', ')}`)
  }
  const panel = open as Settable | undefined
  const slicePanel = panel !== undefined && IN_SLICE.includes(panel)
  if (slicePanel && !hostSlices()) throw new LinkError('not_found', 'this window has no Slice tab, so it has no printer or expert settings')
  if (slicePanel && ((workspace !== undefined && workspace !== 'prepare') || (tab !== undefined && tab !== 'slice'))) {
    throw new LinkError('invalid_input', `${String(open)} opens in Slice; leave out workspace and tab, or ask for Slice`)
  }

  // The window's own state: nothing changes over a busy window or under a tool in use.
  const why = windowBusy(s)
  if (why) throw busy(why)
  if (workspace !== undefined || tab !== undefined || picked !== undefined || slicePanel) idle(s)
  const isOpen = (p: Settable) => s[OPEN_PANELS[p]] === true
  // Leaving Slice takes its pane, and a search typed in it, off screen.
  const inSlice = (s.workspace === 'prepare' && s.modelMode === 'slice') || slicePanel
  const leaves = inSlice && ((tab !== undefined && tab !== 'slice') || (workspace !== undefined && workspace !== 'prepare'))
  if (leaves) {
    const lost = IN_SLICE.find((p) => isOpen(p) && underWay(p))
    if (lost) throw busy(`${NAMES[lost]} has a search typed in it; leaving Slice would lose it`)
  }
  const closing = close === undefined ? [] : close === 'all' ? SETTABLE.filter((p) => p !== panel && isOpen(p)) : [close as Settable].filter(isOpen)
  const kept = closing.find(underWay)
  if (kept) throw busy(`${NAMES[kept]} has the person's work under way; it stays open until they are done`)
  if (panel !== undefined) {
    const still = (p: Settable) => p !== panel && isOpen(p) && !closing.includes(p)
    // A dialog never opens over another one, and a panel in Slice's pane never opens under one.
    const over = SETTABLE.find((p) => still(p) && MODAL.includes(p))
    if (over) throw busy(`${NAMES[over]} is open; close it first`)
    if (panel === 'settings' && isOpen('settings') && section !== undefined && section !== settingsSection(s) && underWay('settings')) {
      throw busy("Settings has the person's work under way; it stays on its section until they are done")
    }
  }

  // Everything is checked; now the window changes, in the order a person would do it.
  if (tab !== undefined) setModelMode(tab as ModelMode)
  else if (workspace !== undefined) setWorkspace(workspace as string)
  if (picked !== undefined) {
    if (picked.length === 0) clearSelection()
    else set({ selection: picked[0]!, selectedIds: picked, towerSelected: false })
  }
  if (closing.length) set(shut(closing))
  if (panel !== undefined) {
    if (slicePanel) {
      setModelMode('slice')
      setRail('prepare', 'left', true)
    }
    set({ [OPEN_PANELS[panel]]: true, ...(panel === 'settings' && (section !== undefined || !isOpen('settings')) ? { settingsSection: (section as string | undefined) ?? null } : {}) })
  }
  return readUi()
}

/** The store change that shuts these panels. */
function shut(panels: readonly Settable[]): Partial<AppState> {
  const out: Partial<AppState> = Object.fromEntries(panels.map((p) => [OPEN_PANELS[p], false]))
  return panels.includes('settings') ? { ...out, settingsSection: null } : out
}
