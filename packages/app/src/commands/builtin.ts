// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Commands from every workspace, registered at launch so Cmd+K and Pilot see
// them before a workspace has loaded. Workspace modules stay lazy.
import type { CommandSpec, EasySettings, Host, SmartLayerMode, SpeedPreset, SupportMode } from '@slicerx/contracts'
import { goalEasy, goalShows } from '../adapters/config'
import { goalSubtitle } from '../lib/estimate-line'
import { confirmDiscard } from '../project/unsaved'
import { gcodeView, pickGcodeFile, setGcodePanel } from '../workspaces/preview/gcode-file'
import { cancelSlice, clearPlate, exportGcode, loadDefaultPlate, loadDemoModel, openModelFiles, removeSelected, slicePlate } from '../state/actions'
import { fullPlate, get, markStale, openSettings, pickColorMode, set, setCamera, setModelMode, setRail, setWorkspace, showSliced, toast, type CameraView, type ColorMode, type ModelMode, type Goal, type PrepareLook } from '../state/store'
import { DEMO_MODELS } from '../lib/demo-models'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { printBlock } from '../plate/heimdall'
import { helpLinks, openLink } from '../lib/links'
import { newProject } from '../project/new'
import { appName, currentEdition, editionHasCad } from '../edition'
import { mimirOn, modelMode, railKey } from '../state/model-mode'
import { bugReportsOff } from '../bugs/where'
import { updaterRegistered } from '../updates/hold'
import { toggleEdge, toggleRail } from '../shell/edge-keys'

export { toggleRail }

/** Focuses an element once a lazy workspace has rendered it. */
export function focusWhenReady(id: string, tries = 30): void {
  const el = document.getElementById(id)
  if (el) {
    el.focus()
    return
  }
  if (tries > 0) requestAnimationFrame(() => focusWhenReady(id, tries - 1))
}

function setEasy(patch: Partial<EasySettings>, goal: Goal = 'custom'): void {
  set((s) => ({ easy: { ...s.easy, ...patch }, goal }))
  markStale()
}

const hasPlate = () => get().plate.length > 0
/** Something a clear would take away: objects on any plate, more plates than one, or what an opened project brought. */
const hasJob = () => {
  const s = get()
  return s.plate.length > 0 || s.plates.length > 1 || s.plates.some((p) => p.objects.length > 0) || s.projectSettings !== null || s.projectPrinter !== null
}
const sliced = () => get().slice.status === 'done'

const GOAL_NAMES: readonly [Exclude<Goal, 'custom'>, string][] = [['draft', 'Draft'], ['standard', 'Standard'], ['fine', 'Fine'], ['strong', 'Strong']]

/** A Goal command's title: "Goal: Strong (6 walls)", with what the goal gives on the printer in use (goalShows). */
export function goalTitle(goal: Exclude<Goal, 'custom'>, name: string, goalValues?: Parameters<typeof goalShows>[1]): string {
  const sub = goalSubtitle(goal, goalShows(goal, goalValues))
  const what = [sub, goal === 'draft' ? 'fastest' : ''].filter(Boolean).join(', ')
  return `Goal: ${name}${what ? ` (${what})` : ''}`
}

/** A slice whose plate can print: no strike in it, and not from before objects were moved too close or too tall by object. */
const exportable = () => sliced() && printBlock(get()) === null

export function builtinCommands(host: Host, workspaces: readonly { id: string; label: string }[]): CommandSpec[] {
  const out: CommandSpec[] = []

  workspaces.forEach((w, i) => {
    out.push({
      id: `open-${w.id}`,
      title: `Go to ${w.label}`,
      section: 'navigate',
      keywords: [w.label, w.id, 'workspace', 'tab'],
      ...(i < 9 ? { shortcut: `Mod+${i + 1}` } : {}),
      workspace: w.id,
      tool: { permission: 'read' },
      run: () => setWorkspace(w.id),
    })
  })
  // The plate tabs' modes: mimir, Model and Slice. Ctrl+E (Cmd+E) flips Model and Slice; it lives in the keymap, not here.
  // mimir shows in every edition while it is on, so its command is there without the modeling tools too.
  const inMode = (m: ModelMode) => () => get().workspace === 'prepare' && get().modelMode === m
  out.push({ id: 'mode-mimir', title: `Go to ${ASSISTANT_NAME}`, section: 'navigate', keywords: ['chat', 'cad', 'describe', 'agent', 'assistant'], enabled: () => mimirOn() && !inMode('mimir')(), tool: { permission: 'read' }, run: () => setModelMode('mimir') })
  if (editionHasCad()) {
    out.push(
      { id: 'mode-design', title: 'Go to Model', section: 'navigate', keywords: ['design', 'cad', 'sketch'], enabled: () => !inMode('design')(), tool: { permission: 'read' }, run: () => setModelMode('design') },
      { id: 'mode-slice', title: 'Go to Slice', section: 'navigate', keywords: ['plate', 'prepare'], enabled: () => !inMode('slice')(), tool: { permission: 'read' }, run: () => setModelMode('slice') },
    )
  }

  out.push(
    // mimir may start a new project too. It clears the plate, so it is the remove class (a card first by default, even
    // for a saved project); the discard question for unsaved work still goes to the person, and its answer comes back.
    { id: 'project-new', title: 'New project', section: 'plate', keywords: ['new', 'empty', 'blank', 'clear', 'start'], shortcut: 'Mod+N', tool: { permission: 'remove' }, run: async () => { const made = await newProject(); if (made) setWorkspace('prepare'); return { started: made } } },
    { id: 'plate-default', title: 'Start over with the example plate', section: 'plate', keywords: ['example', 'demo', 'new', 'reset'], workspace: 'prepare', tool: { permission: 'remove' }, run: async () => { if (!(await confirmDiscard('start over'))) return; setWorkspace('prepare'); await loadDefaultPlate(host) } },
    { id: 'plate-open', title: 'Open a model file', section: 'plate', keywords: ['import', 'stl', '3mf', 'obj', 'step', 'stp', 'iges', 'igs', 'add'], shortcut: 'Mod+O', workspace: 'prepare', run: async () => { setWorkspace('prepare'); await openModelFiles(host) } },
    { id: 'gcode-open', title: 'Open a G-code file to view', section: 'plate', keywords: ['gcode', 'view', 'preview', 'file'], run: () => pickGcodeFile(host) },
    { id: 'gcode-lines', title: 'Show or hide the G-code lines', section: 'view', keywords: ['gcode', 'text', 'lines', 'viewer'], workspace: 'prepare', enabled: () => get().preview !== null, run: () => { showSliced(); setGcodePanel(!gcodeView.getState().panel) } },
    { id: 'plate-remove', title: 'Remove the selected object', section: 'plate', keywords: ['delete'], workspace: 'prepare', enabled: () => get().selection !== null, run: removeSelected },
    { id: 'plate-clear', title: 'Clear the plate', section: 'plate', keywords: ['empty', 'reset'], workspace: 'prepare', enabled: hasJob, run: async () => { if (await confirmDiscard('clear the plate')) clearPlate() } },
  )
  for (const m of DEMO_MODELS) {
    out.push({ id: `plate-add-${m.slug}`, title: `Put the ${m.name} on the plate`, section: 'plate', keywords: [m.name, 'example', 'model'], workspace: 'prepare', tool: { permission: 'slice' }, run: async () => { if (!(await confirmDiscard('replace the plate'))) return; setWorkspace('prepare'); await loadDemoModel(host, m.slug, { replace: true }) } })
  }

  out.push(
    { id: 'slice', title: 'Slice the plate', section: 'slice', keywords: ['run', 'gcode'], shortcut: 'Mod+Enter', workspace: 'prepare', tool: { permission: 'slice' }, enabled: () => fullPlate(get()).length > 0, run: async () => { const plate = get().activePlate; if (get().modelMode !== 'slice') setModelMode('slice'); await slicePlate(host, { plate }); if (get().slice.status === 'done') showSliced() } },
    { id: 'slice-cancel', title: 'Cancel slicing', section: 'slice', keywords: ['stop', 'abort'], enabled: () => get().slice.status === 'running', run: cancelSlice },
    { id: 'export-gcode', title: 'Export G-code', section: 'slice', keywords: ['save', 'download', 'file'], shortcut: 'Mod+Shift+E', workspace: 'prepare', enabled: exportable, run: () => exportGcode(host) },
  )
  for (const [goal, name] of GOAL_NAMES) {
    out.push({
      id: `goal-${goal}`,
      // read when the palette lists it, from the same values as the Goal tile's subtitle, so the two always agree
      get title() {
        return goalTitle(goal, name, get().profile?.goalValues)
      },
      section: 'settings',
      keywords: ['quality', 'preset', 'layer height', goal],
      workspace: 'prepare',
      tool: { permission: 'slice' },
      run: () => setEasy(goalEasy(goal), goal),
    })
  }
  const speeds: [SpeedPreset, string][] = [['quality', 'Quality (50%)'], ['balanced', 'Balanced (100%)'], ['fast', 'Fast (124%)'], ['fastest', 'Fastest (166%)']]
  for (const [speed, label] of speeds) {
    out.push({ id: `speed-${speed}`, title: `Speed: ${label}`, section: 'settings', keywords: ['speed', 'fast', 'quiet'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ speed }) })
  }
  const supports: [SupportMode, string][] = [['off', 'Supports off'], ['auto', 'Supports: auto, tree from the build plate'], ['painted', 'Supports: only where painted']]
  for (const [mode, label] of supports) {
    out.push({ id: `supports-${mode}`, title: label, section: 'settings', keywords: ['support', 'overhang', 'tree'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ supports: mode }) })
  }
  out.push({ id: 'vary-layer-height', title: 'Turn sleipnir on or off', section: 'settings', keywords: ['sleipnir', 'smart layer', 'variable layer height', 'adaptive', 'detail', 'curves'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => {
      // A choice made here is the person's, so a fresh plate keeps it (lib/sleipnir-default.ts).
      set((s) => ({ easyTouched: s.easyTouched.includes('varyLayerHeight') ? s.easyTouched : [...s.easyTouched, 'varyLayerHeight'] }))
      setEasy({ varyLayerHeight: !(get().easy.varyLayerHeight ?? true) })
    } })
  out.push(
    { id: 'brim-toggle', title: 'Turn brim on or off', section: 'settings', keywords: ['adhesion', 'brim'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ brim: !get().easy.brim }) },
    { id: 'expert-open', title: 'Show expert settings', section: 'settings', keywords: ['advanced', 'all settings', 'orca'], workspace: 'prepare', run: () => { setWorkspace('prepare'); setRail('prepare', 'left', true); set({ expertOpen: true }); focusWhenReady('expert-search') } },
    { id: 'expert-reset', title: 'Reset expert overrides', section: 'settings', keywords: ['defaults', 'revert'], workspace: 'prepare', enabled: () => Object.keys(get().overrides).length > 0, run: () => { set({ overrides: {} }); markStale() } },
  )

  out.push(
    { id: 'theme-light', title: 'Use the light theme', section: 'view', keywords: ['appearance', 'bright', 'day'], enabled: () => get().scheme !== 'light', run: () => set({ scheme: 'light' }) },
    { id: 'theme-dark', title: 'Use the dark theme', section: 'view', keywords: ['appearance', 'night'], enabled: () => get().scheme !== 'dark', run: () => set({ scheme: 'dark' }) },
    { id: 'toggle-left', title: 'Toggle the left sidebar', section: 'view', keywords: ['panel', 'collapse', 'rail'], shortcut: 'Mod+B', run: () => toggleRail('left') },
    { id: 'toggle-right', title: 'Toggle the right sidebar', section: 'view', keywords: ['panel', 'collapse', 'rail'], shortcut: 'Mod+Alt+B', run: () => toggleRail('right') },
    { id: 'toggle-bottom', title: 'Show or hide the bottom panel', section: 'view', keywords: ['panel', 'timeline', 'collapse'], workspace: 'prepare', run: () => void toggleEdge('bottom') },
  )
  // Settings > Look and feel > Frame the view; each answers with the choice now in place, so a caller reads it back
  const framings: ['selection' | 'open', string][] = [['selection', 'Always'], ['open', 'On open and add']]
  for (const [framing, label] of framings) {
    out.push({ id: `model-framing-${framing}`, title: `Frame the view: ${label}`, section: 'view', keywords: ['camera', 'frame', 'zoom', 'selection', 'model'], tool: { permission: 'read' }, enabled: () => editionHasCad(currentEdition()) && get().appearance.modelFraming !== framing, run: () => {
      set({ appearance: { ...get().appearance, modelFraming: framing } })
      return { modelFraming: get().appearance.modelFraming }
    } })
  }
  const looks: [PrepareLook, string][] = [['studio', 'Studio'], ['clay', 'Clay'], ['xray', 'X-ray'], ['overhang', 'Overhang heat map'], ['filament', 'Filament colors']]
  for (const [look, label] of looks) {
    out.push({ id: `look-${look}`, title: `Show plate as ${label}`, section: 'view', keywords: ['render', 'material', 'look'], workspace: 'prepare', run: () => { setWorkspace('prepare'); set({ look }) } })
  }
  const cams: [CameraView, string][] = [['iso', 'Iso'], ['top', 'Top'], ['front', 'Front'], ['fit', 'Fit to plate']]
  out.push({ id: 'view-reset', title: 'Reset the view', section: 'view', keywords: ['camera', 'home', 'default view', 'iso'], shortcut: 'Mod+Shift+0', run: () => setCamera('iso') })
  for (const [camera, label] of cams) {
    out.push({ id: `camera-${camera}`, title: `Camera: ${label}`, section: 'view', keywords: ['view', 'camera', 'zoom'], run: () => setCamera(camera) })
  }
  const modes: [ColorMode, string][] = [['feature', 'feature type'], ['tool', 'filament'], ['speed', 'speed'], ['flow', 'volumetric flow'], ['layerTime', 'layer time']]
  for (const [colorMode, label] of modes) {
    out.push({ id: `color-${colorMode}`, title: `Color toolpaths by ${label}`, section: 'view', keywords: ['preview', 'legend', 'color'], workspace: 'prepare', enabled: sliced, run: () => { showSliced(); pickColorMode(colorMode) } })
  }
  out.push(
    { id: 'preview-first-layer', title: 'Show the first layer only', section: 'view', keywords: ['layer 1', 'adhesion'], workspace: 'prepare', enabled: sliced, run: () => { showSliced(); set({ layerHi: 1 }) } },
    { id: 'preview-all-layers', title: 'Show all layers', section: 'view', keywords: ['layers', 'full'], workspace: 'prepare', enabled: sliced, run: () => { showSliced(); set((s) => ({ layerHi: s.preview?.layerCount ?? 0 })) } },
    { id: 'preview-jump-layer', title: 'Jump to a layer', section: 'view', keywords: ['layer', 'go to', 'height', 'z'], workspace: 'prepare', enabled: sliced, run: () => { showSliced(); set({ layerJump: true, sliceLook: 'toolpaths' }) } },
  )

  out.push(
    { id: 'library-search', title: 'Search my models', section: 'library', keywords: ['find', 'models', 'catalog'], workspace: 'library', run: () => { setWorkspace('library'); focusWhenReady('library-search') } },
    { id: 'library-import', title: 'Import models from files', section: 'library', keywords: ['add', 'upload', 'stl', '3mf', 'obj', 'step'], workspace: 'library', run: () => openModelFiles(host) },
  )

  out.push(
    { id: 'help-docs', title: 'Documentation', section: 'help', keywords: ['manual', 'guide', 'help', 'docs'], run: () => openLink(helpLinks().docs) },
    ...(bugReportsOff(currentEdition()) ? [] : [{ id: 'help-report', title: 'Report a bug', section: 'help', keywords: ['bug', 'problem', 'issue', 'crash', 'support', 'feedback', 'discord'], run: () => set({ bugReportOpen: true }) } satisfies CommandSpec]),
    { id: 'help-shortcuts', title: 'Keyboard shortcuts', section: 'help', keywords: ['keys', 'hotkeys'], run: () => set({ shortcutsOpen: true }) },
    { id: 'settings-open', title: 'Open settings', section: 'settings', keywords: ['account', 'phone', 'preferences'], run: () => openSettings() },
    { id: 'help-diagnostics', title: 'Diagnostics: engine, threads and graphics', section: 'help', keywords: ['engine', 'webgl', 'workers', 'threads', 'version', 'about'], run: () => set({ aboutOpen: true }) },
    // Developer mode only: a real crash report, through the same capture path as any other.
    { id: 'dev-test-crash', title: 'Developer: trigger a test crash', section: 'help', keywords: ['crash', 'error', 'bug report', 'test'], enabled: () => get().settingsMode === 'developer', run: () => void import('../bugs/reports').then((m) => m.triggerTestCrash()) },
    { id: 'dev-exact-solids', title: 'Developer: exact solids in history replays (on or off)', section: 'help', keywords: ['brep', 'b-rep', 'smlib', 'exact', 'solid', 'kernel'], enabled: () => get().settingsMode === 'developer', run: () => void import('../cad/history/exact-flag').then((f) => toast(f.toggleExactSolids() ? 'Exact solids are on for history replays.' : 'Exact solids are off.', 'info')) },
    { id: 'dev-model-feel', title: 'Developer: new Model feel (on or off)', section: 'help', keywords: ['pick', 'select', 'edge', 'face', 'push', 'pull', 'model'], enabled: () => get().settingsMode === 'developer', run: () => void import('../cad/model-feel-flag').then((f) => toast(f.toggleModelFeel() ? 'The new Model feel is on.' : 'The new Model feel is off.', 'info')) },
    { id: 'dev-test-panic', title: 'Developer: trigger a test panic in the desktop shell', section: 'help', keywords: ['crash', 'panic', 'rust', 'bug report', 'test'], enabled: () => get().settingsMode === 'developer' && host.kind === 'desktop', run: () => import('../bugs/reports').then((m) => m.triggerTestPanic()) },
    ...(updaterRegistered() ? [{ id: 'help-updates', title: 'Check for updates', section: 'help', keywords: ['update', 'upgrade', 'new version', 'release', 'download'], run: () => void import('../updates/updates').then((m) => m.checkForUpdates({ manual: true })) } satisfies CommandSpec] : []),
    { id: 'help-about', title: `About ${appName()} and its source code`, section: 'help', keywords: ['version', 'license', 'agpl', 'commit'], run: () => set({ aboutOpen: true }) },
  )
  return out
}

