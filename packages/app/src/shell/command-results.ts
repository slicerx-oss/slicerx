// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Search results load when the command bar opens; its input stays in the shell.
import type { CommandSpec, PrinterInfo } from '@slicerx/contracts'
import type { IconName, PaletteGroup, PaletteItem } from '@slicerx/ui'
import type { SettingsApi } from '../adapters/load'
import { navEntries, rankCommands, readsAsQuestion, settingEntries, suggestions, type HubEntry } from '../commands/hub'
import { scoreCommand } from '../commands/fuzzy'
import { getCommand, isEnabled, searchCommands } from '../commands/registry'
import { selectObject } from '../plate/select'
import { allPlates, switchPlate } from '../plate/plates'
import { isMac } from '../lib/keys'
import type { ActiveWorkspace } from '../features'
import { hostSlices } from '../state/model-mode'
import { get, set, setWorkspace, toast, type AppState, type pilotState } from '../state/store'
import { ASK } from './command-bar-id'
export { askContext, askPrompt } from '../commands/hub'

type Input = Pick<AppState, 'recents' | 'plate' | 'plates' | 'activePlate' | 'userPresets' | 'settingsMode' | 'easy' | 'overrides'> & {
  open: boolean
  all: readonly CommandSpec[]
  query: string
  workspace: string
  spaces: readonly ActiveWorkspace[]
  pilot: boolean
  pilotMode: ReturnType<typeof pilotState>
  toolHint: string | null
  fleet: { data: readonly PrinterInfo[] | undefined }
  actions: Map<string, () => void>
  pilotLabel: string | undefined
  settingsApi: SettingsApi | null
}

const SECTION_LABEL: Record<CommandSpec['section'], string> = {
  navigate: 'Go to',
  plate: 'Plate',
  slice: 'Slice',
  printers: 'Printers',
  library: 'Vault',
  pilot: 'Assistant',
  settings: 'Print settings',
  view: 'View',
  help: 'Help',
}

const SECTION_ICON: Record<CommandSpec['section'], IconName> = {
  navigate: 'grid',
  plate: 'prepare',
  slice: 'slice',
  printers: 'printer',
  library: 'library',
  pilot: 'pilot',
  settings: 'sliders',
  view: 'preview',
  help: 'alert',
}


/** "Mod+Shift+K" to one cap per key, as the palette expects. */
function keyCaps(shortcut: string | undefined): string[] | undefined {
  if (!shortcut) return undefined
  const mac = isMac()
  return shortcut.split('+').map((k) => {
    if (k === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (k === 'Shift') return mac ? '⇧' : 'Shift'
    if (k === 'Alt') return mac ? '⌥' : 'Alt'
    if (k === 'Enter') return mac ? '↩' : 'Enter'
    return k
  })
}

function toItem(c: CommandSpec, workspace: string, spaces: readonly ActiveWorkspace[], toolHint: string | null): PaletteItem {
  const icon = c.section === 'navigate' ? (spaces.find((w) => `open-${w.id}` === c.id)?.icon ?? 'grid') : SECTION_ICON[c.section]
  const hint = c.tool && toolHint ? toolHint : c.workspace && c.workspace !== workspace && c.section !== 'navigate' ? spaces.find((w) => w.id === c.workspace)?.label : undefined
  const keys = keyCaps(c.shortcut)
  return { id: c.id, label: c.title, icon, ...(hint ? { hint } : {}), ...(keys ? { keys } : {}) }
}

export function commandGroups({ open, all, query, recents, workspace, spaces, pilot, pilotMode, toolHint, plate, plates, activePlate, userPresets, settingsMode, easy, overrides, fleet, actions, pilotLabel, settingsApi }: Input): PaletteGroup[] {
  if (!open) return []
  actions.clear()
  const q = query.trim()
  // Not yet connected, the row still shows: choosing it opens the connect step, and the question waits there.
  const askOn = pilot && pilotMode !== 'off' && Boolean(getCommand(ASK))
  const toRow = (h: HubEntry): PaletteItem => {
    actions.set(h.id, h.run)
    return { id: h.id, label: h.label, hint: h.hint, icon: h.icon as IconName }
  }
  if (q) {
    const askRow: PaletteGroup = { title: pilotLabel ?? 'Assistant', items: [{ id: ASK, label: `Ask ${pilotLabel ?? 'the assistant'}: ${q.replace(/^\?+\s*/, '')}`, icon: 'pilot', hint: pilotMode === 'connect' ? 'Connect ChatGPT or an API key first' : 'Sends what you have selected as context' }] }
    // A line that starts with "?" is a question, nothing else.
    if (q.startsWith('?')) return askOn ? [askRow] : [{ title: 'Assistant', items: [] }]
    const ranked = rankCommands(q, all, workspace, (text, c) => scoreCommand(text, c.title, c.keywords)).slice(0, 40)
    const out: PaletteGroup[] = []
    const open_ = (def: import('@slicerx/contracts').SettingDef, mode: import('../state/store').SettingsMode) => {
      set({ settingsMode: mode, settingFocus: { key: def.key, label: def.label }, ...(def.section === 'printer' ? { printerSettingsOpen: true } : { expertOpen: true }) })
      setWorkspace('prepare')
    }
    const nav = navEntries(
      q,
      {
        plates: allPlates({ plates, plate, activePlate }).map((p) => ({ id: p.id, name: p.name, count: p.objects.length })),
        activePlate,
        objects: plate.map((p) => ({ id: p.id, name: p.name })),
        printers: hostSlices() ? (fleet.data ?? []).map((r) => ({ id: r.id, name: r.name, model: r.model })) : [],
        presets: hostSlices() ? userPresets.map((p) => ({ id: p.id, name: p.name, kind: p.kind })) : [],
      },
      {
        plate: (id) => { setWorkspace('prepare'); switchPlate(id) },
        object: (id) => { setWorkspace('prepare'); selectObject(id, false) },
        printer: (id) => { set({ printerId: id }); setWorkspace('printers') },
        preset: (id) => void import('../presets/presets').then((m) => { m.applyPreset(id); toast('Preset in use', 'ok') }),
      },
    )
    // The setting index loads the first time the bar opens; until then only commands and jump targets show.
    // print settings mean nothing without an engine, so a host that cannot slice leaves them out
    const settings = settingsApi && hostSlices() ? settingEntries(q, { easy, overrides, settingsMode }, open_, settingsApi) : []
    if (ranked.length) out.push({ title: `${ranked.length === 40 ? 'Top 40' : ranked.length} ${ranked.length === 1 ? 'command' : 'commands'}`, items: ranked.map((m) => toItem(m.command, workspace, spaces, toolHint)) })
    if (nav.length) out.push({ title: 'Go to', items: nav.map(toRow) })
    if (settings.length) out.push({ title: 'Settings', items: settings.map(toRow) })
    const found = ranked.length + nav.length + settings.length
    // mimir is offered last when the line reads as a question or a request, or when nothing else matched.
    if (askOn && (readsAsQuestion(q) || found === 0)) out.push(askRow)
    return out
  }
  const seen = new Set<string>()
  const out: PaletteGroup[] = []
  const recent = recents.map((id) => getCommand(id)).filter((c): c is CommandSpec => c !== undefined && isEnabled(c))
  if (recent.length) {
    out.push({ title: 'Recent', items: recent.map((c) => toItem(c, workspace, spaces, toolHint)) })
    for (const c of recent) seen.add(c.id)
  }
  const suggested = suggestions(get(), new Set(all.filter(isEnabled).map((c) => c.id)))
    .filter((id) => !seen.has(id))
    .map((id) => getCommand(id))
    .filter((c): c is CommandSpec => c !== undefined)
  if (suggested.length) {
    out.push({ title: 'Suggested', items: suggested.map((c) => toItem(c, workspace, spaces, toolHint)) })
    for (const c of suggested) seen.add(c.id)
  }
  const enabled = searchCommands('', all).map((m) => m.command).filter((c) => !seen.has(c.id))
  const here = enabled.filter((c) => c.workspace === workspace && c.section !== 'navigate')
  if (here.length) {
    out.push({ title: `In ${spaces.find((w) => w.id === workspace)?.label ?? 'this workspace'}`, items: here.map((c) => toItem(c, workspace, spaces, toolHint)) })
    for (const c of here) seen.add(c.id)
  }
  for (const section of Object.keys(SECTION_LABEL) as CommandSpec['section'][]) {
    const items = enabled.filter((c) => c.section === section && !seen.has(c.id))
    if (items.length) out.push({ title: SECTION_LABEL[section], items: items.map((c) => toItem(c, workspace, spaces, toolHint)) })
  }
  return out
}
