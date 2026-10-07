// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Commands from every workspace, registered at launch so Cmd+K and Pilot see
// them before a workspace has loaded. Workspace modules stay lazy.
import type { CommandSpec, EasySettings, Host, SmartLayerMode, SpeedPreset, SupportMode } from '@slicerx/contracts'
import { goalEasy } from '../adapters/config'
import { confirmDiscard } from '../project/unsaved'
import { gcodeView, pickGcodeFile, setGcodePanel } from '../workspaces/preview/gcode-file'
import { cancelSlice, clearPlate, exportGcode, loadDefaultPlate, loadDemoModel, openModelFiles, removeSelected, slicePlate } from '../state/actions'
import { get, markStale, openSettings, pickColorMode, set, setCamera, setModelMode, setRail, setWorkspace, showSliced, type CameraView, type ColorMode, type Goal, type PrepareLook } from '../state/store'
import { DEMO_MODELS } from '../lib/demo-models'
import { printBlock } from '../plate/heimdall'
import { helpLinks, openLink } from '../lib/links'
import { newProject } from '../project/new'
import { appName, currentEdition, editionHasCad } from '../edition'
import { modelMode, railKey } from '../state/model-mode'
import { bugReportsOff } from '../bugs/where'
import { updaterRegistered } from '../updates/hold'

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
const sliced = () => get().slice.status === 'done'
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
  // The first tab's two modes. Ctrl+E (Cmd+E) flips between them; it lives in the keymap, not here.
  if (editionHasCad()) {
    const inMode = (m: 'design' | 'slice') => () => get().workspace === 'prepare' && get().modelMode === m
    out.push(
      { id: 'mode-design', title: 'Switch to Design', section: 'navigate', keywords: ['model', 'cad', 'sketch'], enabled: () => !inMode('design')(), tool: { permission: 'read' }, run: () => setModelMode('design') },
      { id: 'mode-slice', title: 'Switch to Slice', section: 'navigate', keywords: ['plate', 'prepare'], enabled: () => !inMode('slice')(), tool: { permission: 'read' }, run: () => setModelMode('slice') },
    )
  }

  out.push(
    { id: 'project-new', title: 'New project', section: 'plate', keywords: ['new', 'empty', 'blank', 'clear', 'start'], shortcut: 'Mod+N', run: async () => { if (await newProject()) setWorkspace('prepare') } },
    { id: 'plate-default', title: 'Start over with the example plate', section: 'plate', keywords: ['example', 'demo', 'new', 'reset'], workspace: 'prepare', tool: { permission: 'slice' }, run: async () => { if (!(await confirmDiscard('start over'))) return; setWorkspace('prepare'); await loadDefaultPlate(host) } },
    { id: 'plate-open', title: 'Open a model file', section: 'plate', keywords: ['import', 'stl', '3mf', 'obj', 'step', 'stp', 'add'], shortcut: 'Mod+O', workspace: 'prepare', run: async () => { setWorkspace('prepare'); await openModelFiles(host) } },
    { id: 'gcode-open', title: 'Open a G-code file to view', section: 'plate', keywords: ['gcode', 'view', 'preview', 'file'], run: () => pickGcodeFile(host) },
    { id: 'gcode-lines', title: 'Show or hide the G-code lines', section: 'view', keywords: ['gcode', 'text', 'lines', 'viewer'], workspace: 'prepare', enabled: () => get().preview !== null, run: () => { showSliced(); setGcodePanel(!gcodeView.getState().panel) } },
    { id: 'plate-remove', title: 'Remove the selected object', section: 'plate', keywords: ['delete'], workspace: 'prepare', enabled: () => get().selection !== null, run: removeSelected },
    { id: 'plate-clear', title: 'Clear the plate', section: 'plate', keywords: ['empty', 'reset'], workspace: 'prepare', enabled: hasPlate, run: async () => { if (await confirmDiscard('clear the plate')) clearPlate() } },
  )
  for (const m of DEMO_MODELS) {
    out.push({ id: `plate-add-${m.slug}`, title: `Put the ${m.name.toLowerCase()} on the plate`, section: 'plate', keywords: [m.name, 'example', 'model'], workspace: 'prepare', tool: { permission: 'slice' }, run: async () => { if (!(await confirmDiscard('replace the plate'))) return; setWorkspace('prepare'); await loadDemoModel(host, m.slug, { replace: true }) } })
  }

  out.push(
    { id: 'slice', title: 'Slice the plate', section: 'slice', keywords: ['run', 'gcode'], shortcut: 'Mod+Enter', workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasPlate, run: async () => { await slicePlate(host); if (get().slice.status === 'done') showSliced() } },
    { id: 'slice-cancel', title: 'Cancel slicing', section: 'slice', keywords: ['stop', 'abort'], enabled: () => get().slice.status === 'running', run: cancelSlice },
    { id: 'export-gcode', title: 'Export G-code', section: 'slice', keywords: ['save', 'download', 'file'], shortcut: 'Mod+Shift+E', workspace: 'prepare', enabled: exportable, run: () => exportGcode(host) },
  )
  const goals: [Exclude<Goal, 'custom'>, string][] = [['draft', 'Draft (0.28 mm, fastest)'], ['standard', 'Standard (0.20 mm)'], ['fine', 'Fine (0.12 mm)'], ['strong', 'Strong (5 walls, 35% infill)']]
  for (const [goal, label] of goals) {
    out.push({ id: `goal-${goal}`, title: `Goal: ${label}`, section: 'settings', keywords: ['quality', 'preset', 'layer height', goal], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy(goalEasy(goal), goal) })
  }
  const speeds: [SpeedPreset, string][] = [['quality', 'Quality (50%)'], ['balanced', 'Balanced (100%)'], ['fast', 'Fast (124%)'], ['fastest', 'Fastest (166%)']]
  for (const [speed, label] of speeds) {
    out.push({ id: `speed-${speed}`, title: `Speed: ${label}`, section: 'settings', keywords: ['speed', 'fast', 'quiet'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ speed }) })
  }
  const supports: [SupportMode, string][] = [['off', 'Supports off'], ['auto', 'Supports: auto, tree from the build plate'], ['painted', 'Supports: only where painted']]
  for (const [mode, label] of supports) {
    out.push({ id: `supports-${mode}`, title: label, section: 'settings', keywords: ['support', 'overhang', 'tree'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ supports: mode }) })
  }
  out.push({ id: 'vary-layer-height', title: 'Turn sleipnir on or off', section: 'settings', keywords: ['sleipnir', 'smart layer', 'variable layer height', 'adaptive', 'detail', 'curves'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => setEasy({ varyLayerHeight: !(get().easy.varyLayerHeight ?? false) }) })
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
  )
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
    { id: 'dev-test-panic', title: 'Developer: trigger a test panic in the desktop shell', section: 'help', keywords: ['crash', 'panic', 'rust', 'bug report', 'test'], enabled: () => get().settingsMode === 'developer' && host.kind === 'desktop', run: () => import('../bugs/reports').then((m) => m.triggerTestPanic()) },
    ...(updaterRegistered() ? [{ id: 'help-updates', title: 'Check for updates', section: 'help', keywords: ['update', 'upgrade', 'new version', 'release', 'download'], run: () => void import('../updates/updates').then((m) => m.checkForUpdates({ manual: true })) } satisfies CommandSpec] : []),
    { id: 'help-about', title: `About ${appName()} and its source code`, section: 'help', keywords: ['version', 'license', 'agpl', 'commit'], run: () => set({ aboutOpen: true }) },
  )
  return out
}

export function toggleRail(side: 'left' | 'right'): void {
  const ws = railKey(get().workspace, modelMode())
  const cur = get().rails[ws]?.[side]
  const wide = window.matchMedia('(min-width: 1280px)').matches
  setRail(ws, side, !(cur ?? wide))
}
