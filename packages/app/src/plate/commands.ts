// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Command bar entries for the plate tools. Shortcuts shown come from the active keymap, so the
// Shift+? list matches what the keys do in each look and feel.
import type { CommandSpec, Host, LookAndFeelChoice } from '@slicerx/contracts'
import { exportAllPlates, exportGcode3mf, saveProject } from '../export/actions'
import { keymapFor, type KeyAction } from '@slicerx/ui'
import { togglePrintable } from './object-list'
import { clipboard, copySelection, cutSelection, duplicateSelection, pasteClipboard } from './clipboard'
import { get, openSettings, selectedIds, set, toast, type VolumeRole } from '../state/store'
import { orientSelected, repairSelected } from './geom-ops'
import { addPrimitiveVolume } from './volumes'
import { addPrimitive, mergeSelected, splitSelectedToObjects, splitSelectedToParts, arrangePlate, centerSelected, dropSelectedToBed, fillBed, instanceCount, mirrorSelected, selectAll, setInstanceCount } from './edit'
import { history } from './history'
import { addPlate, duplicatePlate, removePlate, switchPlate } from './plates'
import { cameraBus, getPaintBus, setTool } from './tools'
import { appName, editionHasCad, MODELING_COMMANDS } from '../edition'

const hasSelection = () => get().selection !== null

function reportError(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e), 'error')
}

function stepPlate(d: 1 | -1): void {
  const { plates, activePlate } = get()
  const i = plates.findIndex((p) => p.id === activePlate)
  const next = plates[(i + d + plates.length) % plates.length]
  if (next) switchPlate(next.id)
}

/** The selected object's last history step, as object id and index. */
function lastStep(): { id: string; index: number } | null {
  const e = get().plate.find((p) => p.id === get().selection)
  const n = e?.history?.steps.length ?? 0
  return e && n > 0 ? { id: e.id, index: n - 1 } : null
}

export function plateCommands(choice: () => LookAndFeelChoice, full?: Host): CommandSpec[] {
  const historyRun = async (fn: (o: typeof import('../cad/history/ops'), host: Host['slicer'], id: string, index: number) => Promise<unknown>) => {
    const last = lastStep()
    if (!last || !full) return
    try {
      await fn(await import('../cad/history/ops'), full.slicer, last.id, last.index)
    } catch (e) {
      reportError(e)
    }
  }
  const host = full?.slicer
  const addVolume = async (role: VolumeRole) => {
    if (!host) return
    try {
      await addPrimitiveVolume(host, role, 'box')
    } catch (e) {
      reportError(e)
    }
  }
  const key = (a: KeyAction) => {
    const c = choice()
    return keymapFor(c.id, c.overrides?.keys ?? {})[a] ?? undefined
  }
  const withKey = (spec: CommandSpec, a?: KeyAction): CommandSpec => {
    const k = a ? key(a) : undefined
    return k ? { ...spec, shortcut: k } : spec
  }
  const cadOn = () => get().cadTools
  const list: CommandSpec[] = [
    { id: 'undo', title: 'Undo', section: 'plate', keywords: ['revert', 'back'], shortcut: 'Mod+Z', enabled: () => history().canUndo(), run: () => void history().undo() },
    { id: 'redo', title: 'Redo', section: 'plate', keywords: ['again'], shortcut: 'Mod+Shift+Z', enabled: () => history().canRedo(), run: () => void history().redo() },
    withKey({ id: 'tool-move', title: 'Move tool', section: 'plate', keywords: ['gizmo', 'translate', 'position'], workspace: 'prepare', run: () => setTool('move') }, 'tool.move'),
    withKey({ id: 'tool-rotate', title: 'Rotate tool', section: 'plate', keywords: ['gizmo', 'turn', 'angle'], workspace: 'prepare', run: () => setTool('rotate') }, 'tool.rotate'),
    withKey({ id: 'tool-scale', title: 'Scale tool', section: 'plate', keywords: ['size', 'resize', 'percent'], workspace: 'prepare', run: () => setTool('scale') }, 'tool.scale'),
    withKey({ id: 'tool-face', title: 'Lay on face', section: 'plate', keywords: ['place on face', 'flat', 'orient'], workspace: 'prepare', run: () => setTool('face') }, 'tool.placeOnFace'),
    { id: 'drop-to-bed', title: 'Drop the selected object to the bed', section: 'plate', keywords: ['floor', 'z zero', 'lower'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void dropSelectedToBed() },
    { id: 'center-object', title: 'Center the selected object on the bed', section: 'plate', keywords: ['middle'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void centerSelected() },
    { id: 'mirror-x', title: 'Mirror the selected object along X', section: 'plate', keywords: ['flip'], workspace: 'prepare', enabled: hasSelection, run: () => void mirrorSelected(0) },
    { id: 'mirror-y', title: 'Mirror the selected object along Y', section: 'plate', keywords: ['flip'], workspace: 'prepare', enabled: hasSelection, run: () => void mirrorSelected(1) },
    { id: 'mirror-z', title: 'Mirror the selected object along Z', section: 'plate', keywords: ['flip', 'upside down'], workspace: 'prepare', enabled: hasSelection, run: () => void mirrorSelected(2) },
    withKey({ id: 'arrange-all', title: 'Arrange all objects', section: 'plate', keywords: ['pack', 'layout', 'auto arrange'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: () => get().plate.length > 0, run: () => void arrangePlate('all') }, 'plate.arrange'),
    withKey({ id: 'arrange-selection', title: 'Arrange the selected objects', section: 'plate', keywords: ['pack', 'layout'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void arrangePlate('selection') }, 'plate.arrangeSelected'),
    { id: 'calibration', title: 'Calibration: temperature, flow, pressure advance, retraction', section: 'plate', keywords: ['calibrate', 'temp tower', 'flow ratio', 'max volumetric speed', 'filament test'], workspace: 'prepare', run: () => set({ calibrationOpen: true }) },
    { id: 'user-presets', title: 'Presets: save, import and export printer, filament and process presets', section: 'settings', keywords: ['user preset', 'profile', 'save settings', 'import orca', 'export'], run: () => openSettings('presets') },
    { id: 'flush-volumes', title: 'Flush volumes for color changes', section: 'plate', keywords: ['purge', 'multi color', 'ams', 'waste'], workspace: 'prepare', run: () => set({ flushOpen: true }) },
    withKey({ id: 'copy', title: 'Copy the selected objects', section: 'plate', keywords: ['clipboard', 'duplicate'], workspace: 'prepare', enabled: hasSelection, run: () => void copySelection() }, 'edit.copy'),
    withKey({ id: 'cut', title: 'Cut the selected objects', section: 'plate', keywords: ['clipboard', 'move'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void cutSelection() }, 'edit.cut'),
    withKey({ id: 'paste', title: 'Paste', section: 'plate', keywords: ['clipboard', 'objects', 'volume'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: () => clipboard() !== null, run: () => void pasteClipboard() }, 'edit.paste'),
    withKey({ id: 'duplicate', title: 'Duplicate the selected objects', section: 'plate', keywords: ['clone', 'copy'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void duplicateSelection() }, 'edit.duplicate'),
    { id: 'tool-paint', title: 'Paint tool: color, seam and support', section: 'plate', keywords: ['paint', 'brush', 'color paint', 'multicolor', 'mmu', 'painting'], workspace: 'prepare', run: () => { setTool('paint'); getPaintBus()?.set({ layer: 'color' }) } },
    withKey({ id: 'paint-support', title: 'Paint support: enforce and block', section: 'plate', keywords: ['support painting', 'enforcer', 'blocker', 'paint supports'], workspace: 'prepare', run: () => { setTool('paint'); getPaintBus()?.set({ layer: 'support', state: 1 }) } }, 'tool.supports'),
    { id: 'paint-seam', title: 'Paint seam: place and avoid', section: 'plate', keywords: ['seam painting', 'seam position'], workspace: 'prepare', run: () => { setTool('paint'); getPaintBus()?.set({ layer: 'seam', state: 1 }) } },
    { id: 'paint-fuzzy', title: 'Paint fuzzy skin', section: 'plate', keywords: ['fuzzy skin painting', 'rough surface', 'texture', 'grip'], workspace: 'prepare', run: () => { setTool('paint'); getPaintBus()?.set({ layer: 'fuzzy', state: 1 }) } },
    { id: 'volume-negative', title: 'Add a negative volume to the selected object', section: 'plate', keywords: ['cut', 'hole', 'subtract', 'negative part'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void addVolume('negative') },
    { id: 'volume-blocker', title: 'Add a support blocker to the selected object', section: 'plate', keywords: ['no support', 'support blocker', 'block support'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void addVolume('support_blocker') },
    { id: 'volume-enforcer', title: 'Add a support enforcer to the selected object', section: 'plate', keywords: ['force support', 'support enforcer'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void addVolume('support_enforcer') },
    { id: 'volume-modifier', title: 'Add a modifier to the selected object', section: 'plate', keywords: ['modifier part', 'region settings', 'local infill', 'different settings'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void addVolume('modifier') },
    { id: 'object-cut', title: 'Cut the selected object with a plane', section: 'plate', keywords: ['cut tool', 'split', 'slice model', 'connectors'], workspace: 'prepare', enabled: hasSelection, run: () => set({ objectTool: 'cut' }) },
    { id: 'object-orient', title: 'Auto orient the selected object', section: 'plate', keywords: ['orient', 'best orientation', 'rotate to print', 'fewer supports'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void orientSelected().catch(reportError) },
    { id: 'object-repair', title: 'Repair the mesh of the selected object', section: 'plate', keywords: ['fix mesh', 'holes', 'non manifold', 'open edges'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void (full ? repairSelected(full.slicer).catch(reportError) : undefined) },
    { id: 'object-hollow', title: 'Hollow the selected object', section: 'plate', keywords: ['shell', 'save filament', 'hollowing'], workspace: 'prepare', enabled: hasSelection, run: () => set({ objectTool: 'hollow' }) },
    { id: 'object-text', title: 'Text on a face', section: 'plate', keywords: ['emboss', 'deboss', 'engrave', 'label', 'lettering', 'add text'], workspace: 'prepare', run: () => set({ objectTool: 'facetext' }) },
    { id: 'object-shape', title: 'Shape on a face: rectangle, circle, slot or polygon', section: 'plate', keywords: ['extrude', 'boss', 'pocket', 'hole', 'join', 'cut', 'sketch'], workspace: 'prepare', run: () => set({ objectTool: 'shape' }) },
    { id: 'object-array', title: 'Array: linear, grid or circular copies', section: 'plate', keywords: ['pattern', 'copies', 'repeat', 'instances', 'circular pattern'], workspace: 'prepare', enabled: hasSelection, run: () => set({ objectTool: 'array' }) },
    { id: 'object-sketch', title: 'Sketch on the bed or a face, then extrude or revolve', section: 'plate', keywords: ['draw', 'profile', 'line', 'arc', 'circle', 'rectangle', 'extrude', 'revolve', 'bracket', 'boss'], workspace: 'prepare', run: () => set({ objectTool: 'sketch' }) },
    { id: 'object-svg-face', title: 'SVG outline on a face: join, cut or new body', section: 'plate', keywords: ['logo', 'vector', 'emboss', 'deboss', 'engrave', 'artwork', 'svg', 'inlay'], workspace: 'prepare', run: () => set({ objectTool: 'facesvg' }) },
    { id: 'dimensions-show', title: 'Show or hide all kept dimensions', section: 'plate', keywords: ['dimension', 'measurement', 'annotation', 'label', 'size'], workspace: 'prepare', run: () => set((s) => ({ showDimensions: !s.showDimensions })) },
    { id: 'object-push', title: 'Push or pull a face', section: 'plate', keywords: ['push pull', 'press pull', 'extrude face', 'move face', 'offset face', 'thicken', 'deepen'], workspace: 'prepare', run: () => set({ objectTool: 'push' }) },
    { id: 'history-edit-last', title: 'Edit the last step of the selected object\'s history', section: 'plate', keywords: ['cad history', 'timeline', 'feature', 'change step', 'parametric', 'undo step'], workspace: 'prepare', enabled: () => lastStep() !== null, run: () => void historyRun((o, host, id, i) => o.beginEdit(host, id, i)) },
    { id: 'history-suppress-last', title: 'Suppress or bring back the last history step', section: 'plate', keywords: ['cad history', 'turn off step', 'skip step', 'suppress feature'], workspace: 'prepare', enabled: () => lastStep() !== null, run: () => void historyRun((o, host, id, i) => o.setSuppressed(host, id, i, !get().plate.find((p) => p.id === id)?.history?.steps[i]?.suppressed)) },
    { id: 'history-stop', title: 'Stop editing the history step', section: 'plate', keywords: ['cancel edit', 'cad history'], workspace: 'prepare', enabled: () => get().historyEdit !== null, run: () => void import('../cad/history/ops').then((o) => o.cancelEdit()) },
    { id: 'object-holefit', title: 'Fit a hole for a screw or insert', section: 'plate', keywords: ['hole', 'resize hole', 'heat-set insert', 'counterbore', 'countersink', 'clearance', 'screw', 'tap'], workspace: 'prepare', run: () => set({ objectTool: 'holefit' }) },
    { id: 'object-thread', title: 'Cut a thread in a hole or on a rod', section: 'plate', keywords: ['thread', 'screw thread', 'tap', 'bolt', 'nut', 'cap', 'iso metric', 'internal thread', 'external thread'], workspace: 'prepare', run: () => set({ objectTool: 'thread' }) },
    { id: 'object-fillet', title: 'Fillet or chamfer edges', section: 'plate', keywords: ['round edge', 'bevel', 'radius', 'edge break', 'soften corners', 'chamfer'], workspace: 'prepare', run: () => set({ objectTool: 'fillet' }) },
    { id: 'object-measure', title: 'Measure distance, angle and radius', section: 'plate', keywords: ['ruler', 'dimension', 'diameter', 'length', 'caliper'], workspace: 'prepare', run: () => set({ objectTool: 'measure' }) },
    { id: 'object-simplify', title: 'Simplify the mesh of the selected object', section: 'plate', keywords: ['reduce triangles', 'decimate', 'lighter mesh'], workspace: 'prepare', enabled: hasSelection, run: () => set({ objectTool: 'simplify' }) },
    { id: 'object-subtract', title: 'Subtract a shape from the selected object', section: 'plate', keywords: ['boolean', 'hole', 'difference'], workspace: 'prepare', enabled: hasSelection, run: () => set({ objectTool: 'hole' }) },
    { id: 'printer-settings', title: 'Printer settings', section: 'settings', keywords: ['machine settings', 'nozzle', 'retraction', 'motion', 'acceleration', 'printer profile', 'advanced'], workspace: 'prepare', run: () => set({ printerSettingsOpen: true }) },
    { id: 'controls-open', title: 'Controls: mouse and keyboard shortcuts', section: 'settings', keywords: ['keys', 'keyboard', 'shortcuts', 'bindings', 'mouse buttons', 'remap', 'hotkeys'], run: () => openSettings('controls') },
    { id: 'bridge-open', title: 'Printer bridge: connect to sx-link', section: 'settings', keywords: ['connect printers', 'sx-link', 'pairing code', 'real printers', 'local bridge'], run: () => openSettings('bridge') },
    withKey({ id: 'toggle-printable', title: 'Toggle printable for the selected objects', section: 'plate', keywords: ['exclude', 'skip', 'hide from print', 'disable object', 'printable'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void togglePrintable() }, 'object.printable'),
    { id: 'select-all', title: 'Select all objects', section: 'plate', keywords: ['everything'], shortcut: 'Mod+A', workspace: 'prepare', enabled: () => get().plate.length > 0, run: selectAll },
    { id: 'fill-bed', title: 'Fill the bed with copies of the selected object', section: 'plate', keywords: ['instances', 'duplicate', 'batch', 'copies'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void fillBed() },
    { id: 'instance-add', title: 'Add an instance of the selected object', section: 'plate', keywords: ['copy', 'duplicate', 'plus'], shortcut: '+', workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => { const id = get().selection; if (id) setInstanceCount(id, instanceCount(id) + 1) } },
    { id: 'instance-remove', title: 'Remove an instance of the selected object', section: 'plate', keywords: ['minus', 'fewer'], shortcut: '-', workspace: 'prepare', enabled: () => { const id = get().selection; return id !== null && instanceCount(id) > 1 }, run: () => { const id = get().selection; if (id) setInstanceCount(id, instanceCount(id) - 1) } },
    ...(host
      ? ([
          { id: 'split-objects', title: 'Split the selected object to objects', section: 'plate', keywords: ['separate', 'pieces', 'explode'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void splitSelectedToObjects(host) },
          { id: 'split-parts', title: 'Split the selected object to parts', section: 'plate', keywords: ['separate', 'pieces', 'multi-color'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: hasSelection, run: () => void splitSelectedToParts(host) },
          { id: 'merge-objects', title: 'Merge the selected objects', section: 'plate', keywords: ['combine', 'join', 'assemble'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: () => get().selectedIds.length > 1, run: () => void mergeSelected(host) },
          ...(['box', 'cylinder', 'sphere', 'cone'] as const).map((shape): CommandSpec => ({ id: `add-${shape}`, title: `Add a ${shape}`, section: 'plate', keywords: ['primitive', 'shape', 'new object'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => void addPrimitive(host, shape, 'object') })),
        ] satisfies CommandSpec[])
      : []),
    ...(full
      ? ([
          { id: 'project-save', title: 'Save the project', section: 'plate', keywords: ['sx3mf', 'save as', 'export', 'file', 'plates'], shortcut: 'Mod+S', run: () => void saveProject(full) },
          { id: 'project-export-locked', title: `Export a locked ${appName()} project (.sxlock)`, section: 'plate', keywords: ['sxlock', 'lock', 'encrypt', 'protect', 'private', 'account', 'export'], run: () => void import('../export/locked').then((m) => m.exportLockedProject(full)) },
          { id: 'project-save-as', title: 'Save the project as a new file', section: 'plate', keywords: ['save as', 'sx3mf', 'copy', 'file'], shortcut: 'Mod+Shift+S', run: () => void saveProject(full, { as: true }) },
          { id: 'project-recent', title: 'Open a recent project', section: 'plate', keywords: ['recent', 'reopen', 'restore', 'autosave', 'sx3mf'], run: () => set({ projectsDialog: 'recent' }) },
          { id: 'export-selection-stl', title: 'Export the selection as STL', section: 'plate', keywords: ['mesh', 'save', 'model'], enabled: () => selectedIds().length > 0, run: () => void import('../export/mesh').then((m) => m.exportMesh(full, 'selection', 'stl')) },
          { id: 'export-selection-obj', title: 'Export the selection as OBJ', section: 'plate', keywords: ['mesh', 'save', 'model'], enabled: () => selectedIds().length > 0, run: () => void import('../export/mesh').then((m) => m.exportMesh(full, 'selection', 'obj')) },
          { id: 'export-plate-stl', title: 'Export the plate as STL', section: 'plate', keywords: ['mesh', 'save', 'model', 'all'], run: () => void import('../export/mesh').then((m) => m.exportMesh(full, 'plate', 'stl')) },
          { id: 'export-plate-obj', title: 'Export the plate as OBJ', section: 'plate', keywords: ['mesh', 'save', 'model', 'all'], run: () => void import('../export/mesh').then((m) => m.exportMesh(full, 'plate', 'obj')) },
          { id: 'export-gcode-3mf', title: 'Export the sliced plate as .gcode.3mf', section: 'slice', keywords: ['bambu', 'printer file', 'send'], run: () => void exportGcode3mf(full) },
          { id: 'export-all-plates', title: 'Slice and export every plate', section: 'slice', keywords: ['all plates', 'batch', 'gcode.3mf'], enabled: () => get().plates.length > 1, run: () => void exportAllPlates(full) },
        ] satisfies CommandSpec[])
      : []),
    ...[0.15, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1.0].map((mm): CommandSpec => ({
      id: `nozzle-${mm}`,
      title: `Set the nozzle to ${mm} mm`,
      section: 'settings',
      keywords: ['nozzle size', 'nozzle diameter', 'printer', 'hotend'],
      workspace: 'prepare',
      enabled: () => Boolean(get().profile?.nozzles.includes(mm)) && get().profile?.nozzleFrom !== 'printer' && get().profile?.nozzle !== mm,
      run: () => {
        const id = get().printerModel?.id
        if (id) set((s) => ({ printerNozzles: { ...s.printerNozzles, [id]: mm } }))
      },
    })),
    { id: 'plate-add', title: 'Add a plate', section: 'plate', keywords: ['new plate', 'build plate'], workspace: 'prepare', tool: { permission: 'slice' }, run: () => void addPlate() },
    { id: 'plate-duplicate', title: 'Duplicate this plate with its objects', section: 'plate', keywords: ['copy plate', 'clone plate', 'repeat print'], workspace: 'prepare', tool: { permission: 'slice' }, enabled: () => get().plate.length > 0, run: () => void duplicatePlate() },
    { id: 'plate-next', title: 'Show the next plate', section: 'plate', keywords: ['plates', 'switch'], workspace: 'prepare', enabled: () => get().plates.length > 1, run: () => stepPlate(1) },
    { id: 'plate-previous', title: 'Show the previous plate', section: 'plate', keywords: ['plates', 'switch'], workspace: 'prepare', enabled: () => get().plates.length > 1, run: () => stepPlate(-1) },
    { id: 'plate-delete', title: 'Delete this plate and its objects', section: 'plate', keywords: ['remove plate'], workspace: 'prepare', enabled: () => get().plates.length > 1, run: () => void removePlate(get().activePlate) },
    withKey({ id: 'zoom-selection', title: 'Zoom to the selection', section: 'view', keywords: ['frame', 'focus'], run: () => cameraBus()?.zoomToSelection?.({ animate: true }) }, 'view.zoomSelection'),
    { id: 'toolpath-palette', title: 'Toggle color-blind friendly toolpath colors', section: 'view', keywords: ['color vision', 'deuteranopia', 'protanopia', 'accessibility', 'palette', 'preview'], run: () => set({ toolpathPalette: get().toolpathPalette === 'colorblind' ? 'standard' : 'colorblind' }) },
    { id: 'zoom-in', title: 'Zoom in', section: 'view', keywords: ['closer', 'magnify', 'camera'], shortcut: 'Mod+=', enabled: () => Boolean(cameraBus()?.zoomBy), run: () => cameraBus()?.zoomBy?.(1.25) },
    { id: 'zoom-out', title: 'Zoom out', section: 'view', keywords: ['farther', 'camera'], shortcut: 'Mod+-', enabled: () => Boolean(cameraBus()?.zoomBy), run: () => cameraBus()?.zoomBy?.(0.8) },
    withKey({ id: 'zoom-bed', title: 'Zoom to the bed', section: 'view', keywords: ['plate', 'frame'], run: () => cameraBus()?.zoomToBed?.({ animate: true }) }, 'view.zoomBed'),
    withKey({ id: 'toggle-projection', title: 'Switch perspective and orthographic', section: 'view', keywords: ['ortho', 'camera'], run: () => void cameraBus()?.toggleProjection?.() }, 'view.projection'),
  ]
  // Drawing commands exist only when the drawing tools are on. Measure, arrays, hollow, repair and simplify always do.
  const cad = new Set(['object-text', 'object-shape', 'object-subtract', 'add-box', 'add-cylinder', 'add-sphere', 'add-cone'])
  // An edition without the modeling tools has none of their commands: its geometry engine cannot run them.
  const shipped = editionHasCad() ? list : list.filter((c) => !MODELING_COMMANDS.has(c.id))
  return shipped.map((c) => (cad.has(c.id) ? { ...c, enabled: c.enabled ? () => cadOn() && c.enabled!() : cadOn } : c))
}
