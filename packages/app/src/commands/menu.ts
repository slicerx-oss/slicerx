// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop app's native menu bar, built from the command registry: each item runs a registered
// command and shows that command's shortcut. The shell registers a NativeMenu that draws the model.
import type { CommandSpec } from '@slicerx/contracts'
import { isTextField } from '../lib/keys'
import { appName } from '../edition'
import { get } from '../state/store'
import { getCommand, isEnabled, runCommand } from './registry'

export type MenuPlatform = 'macos' | 'windows' | 'linux'

/** What an item does instead when focus is in a text field: the field's own editing. */
export type TextEdit = 'undo' | 'redo' | 'selectAll' | 'delete'

/** Items the system implements. Cut, copy and paste reach the page as key presses or clipboard events. */
export type NativeItem = 'cut' | 'copy' | 'paste' | 'hide' | 'hideOthers' | 'showAll' | 'fullscreen' | 'minimize' | 'maximize'

export type CommandEntry = { kind: 'command'; id: string; label: string; accelerator?: string; text?: TextEdit }
/** Window actions the shell carries out itself. Quit closes the window, so unsaved changes are asked about. */
export type WindowEntry = { kind: 'window'; action: 'quit' | 'fullscreen'; label: string; accelerator?: string }

export type MenuEntry = CommandEntry | WindowEntry | { kind: 'native'; item: NativeItem } | { kind: 'submenu'; label: string; items: MenuEntry[] } | { kind: 'separator' }

export interface MenuSection {
  label: string
  items: MenuEntry[]
}

export interface NativeMenu {
  platform: MenuPlatform
  /**
   * Replaces the menu bar. `run` is called when a command item is picked. `accessKeys` are the letters
   * whose Alt chord opens a menu (menuAccessKeys).
   */
  set(sections: readonly MenuSection[], run: (entry: CommandEntry) => void, accessKeys: readonly string[]): Promise<void>
  /** Greys a command's items out or back in. */
  enable(id: string, on: boolean): void
  /** The command items of the bar the shell shows before the page loads, with their accelerators ('' for none). */
  startup?: ReadonlyMap<string, string>
}

let native: NativeMenu | null = null

export function registerNativeMenu(menu: NativeMenu): void {
  native = menu
}

export function nativeMenu(): NativeMenu | null {
  return native
}

/**
 * A registry shortcut as a menu accelerator. Only chords with Ctrl, Cmd or Alt: a bare key in a menu
 * would take the key from text fields. Chords the look's keymap gives to another action are left off.
 */
export function toAccelerator(shortcut: string | undefined, taken: ReadonlySet<string> = new Set()): string | undefined {
  if (!shortcut || !/(^|\+)(Mod|Alt)\+/.test(shortcut)) return undefined
  if (taken.has(shortcut)) return undefined
  return shortcut.replace(/(^|\+)Mod(?=\+)/, '$1CmdOrCtrl')
}

/**
 * The menu bar for a platform, from the registered commands. Items whose command is not registered are left out,
 * except the ones in `startup` (the shell's first-frame menu): those stay, greyed out, with their accelerator, so
 * the menus do not shrink and grow back while the app registers its commands.
 */
export function menuModel(commands: readonly CommandSpec[], o: { platform: MenuPlatform; taken?: ReadonlySet<string>; startup?: ReadonlyMap<string, string>; app?: string; omit?: ReadonlySet<string> }): MenuSection[] {
  const byId = new Map(commands.map((c) => [c.id, c]))
  // The product name in About, Quit and the app menu. menu.json is written with `{app}`, which the shell fills in.
  const app = o.app ?? appName()
  const mac = o.platform === 'macos'
  const sep: MenuEntry = { kind: 'separator' }
  const cmd = (id: string, label: string, extra: { text?: TextEdit; accelerator?: string | null } = {}): MenuEntry | null => {
    const c = byId.get(id)
    const early = o.startup?.get(id)
    if (o.omit?.has(id) || (!c && early === undefined)) return null
    const accelerator = extra.accelerator === null ? undefined : (extra.accelerator ?? (c ? toAccelerator(c.shortcut, o.taken) : early || undefined))
    return { kind: 'command', id, label, ...(accelerator ? { accelerator } : {}), ...(extra.text ? { text: extra.text } : {}) }
  }
  const sub = (label: string, items: (MenuEntry | null)[]): MenuEntry => ({ kind: 'submenu', label, items: tidy(items) })
  // The tabs, in the look's order and with its names.
  const tabs = commands.filter((c) => c.section === 'navigate' && c.id.startsWith('open-')).map((c) => cmd(c.id, c.title.replace(/^Go to /, '').replace(/&/g, '&&')))

  const sections: MenuSection[] = []
  if (mac) {
    sections.push({
      label: app,
      items: tidy([cmd('help-about', `About ${app}`), cmd('help-updates', 'Check for updates…'), sep, cmd('settings-open', 'Settings…', { accelerator: 'CmdOrCtrl+,' }), sep, { kind: 'native', item: 'hide' }, { kind: 'native', item: 'hideOthers' }, { kind: 'native', item: 'showAll' }, sep, { kind: 'window', action: 'quit', label: `Quit ${app}`, accelerator: 'CmdOrCtrl+Q' }]),
    })
  }
  sections.push({
    label: '&File',
    items: tidy([
      cmd('project-new', '&New project'),
      cmd('plate-open', '&Open…'),
      cmd('project-recent', 'Open &recent…'),
      sub('&Import', [cmd('library-import', '&Models into the Vault…'), cmd('user-presets', '&Presets…')]),
      sep,
      cmd('project-save', '&Save'),
      cmd('project-save-as', 'Save &as…'),
      sub('&Export', [cmd('export-gcode', '&G-code…'), cmd('export-gcode-3mf', 'Printer file (.gcode.&3mf)…'), cmd('project-export-locked', `&Locked ${app} project (.sxlock)…`), cmd('export-plate-stl', 'Plate as &STL…'), cmd('export-plate-obj', 'Plate as &OBJ…')]),
      ...(mac ? [] : [sep, { kind: 'window', action: 'quit', label: o.platform === 'windows' ? 'E&xit' : '&Quit', ...(o.platform === 'linux' ? { accelerator: 'CmdOrCtrl+Q' } : {}) } satisfies WindowEntry]),
    ]),
  })
  sections.push({
    label: '&Edit',
    items: tidy([
      cmd('undo', '&Undo', { text: 'undo' }),
      cmd('redo', '&Redo', { text: 'redo' }),
      sep,
      { kind: 'native', item: 'cut' },
      { kind: 'native', item: 'copy' },
      { kind: 'native', item: 'paste' },
      cmd('plate-remove', '&Delete', { text: 'delete', accelerator: o.platform === 'windows' ? 'Delete' : null }),
      cmd('select-all', 'Select &all', { text: 'selectAll' }),
      ...(mac ? [] : [sep, cmd('settings-open', '&Settings…')]),
    ]),
  })
  sections.push({
    label: '&View',
    items: tidy([...tabs, sep, cmd('zoom-in', 'Zoom &in'), cmd('zoom-out', 'Zoom &out'), cmd('view-reset', '&Reset view'), cmd('camera-fit', 'Fit to &plate'), sep, mac ? { kind: 'native', item: 'fullscreen' } : { kind: 'window', action: 'fullscreen', label: '&Full screen', accelerator: 'F11' }]),
  })
  if (mac) sections.push({ label: 'Window', items: [{ kind: 'native', item: 'minimize' }, { kind: 'native', item: 'maximize' }] })
  sections.push({ label: '&Help', items: tidy([cmd('help-docs', '&Documentation'), cmd('help-report', '&Report a bug…'), sep, cmd('help-shortcuts', '&Keyboard shortcuts'), ...(mac ? [] : [sep, cmd('help-updates', 'Check for &updates…'), cmd('help-about', `&About ${app}`)])]) })
  return sections.filter((s) => s.items.length > 0)
}

/** Drops missing items and empty submenus, and separators at either end or next to each other. */
function tidy(items: readonly (MenuEntry | null)[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const e of items) {
    if (!e || (e.kind === 'submenu' && e.items.length === 0)) continue
    if (e.kind === 'separator' && (out.length === 0 || out[out.length - 1]?.kind === 'separator')) continue
    out.push(e)
  }
  while (out[out.length - 1]?.kind === 'separator') out.pop()
  return out
}

/**
 * The letters whose Alt chord opens a menu: Alt+F opens &File. On Windows the page gets these keys before the
 * menu bar does, so the shell passes them on. A letter whose Alt chord is one of the app's own shortcuts
 * stays with the app.
 */
export function menuAccessKeys(sections: readonly MenuSection[], shortcuts: Iterable<string>): string[] {
  const own = new Set([...shortcuts].map((s) => s.toLowerCase()))
  return sections.flatMap((s) => {
    const k = /&([^&])/.exec(s.label)?.[1]?.toLowerCase()
    return k && !own.has(`alt+${k}`) ? [k] : []
  })
}

/** Every command item in the model. */
export function menuCommands(sections: readonly MenuSection[]): CommandEntry[] {
  const out: CommandEntry[] = []
  const walk = (items: readonly MenuEntry[]) => {
    for (const e of items) {
      if (e.kind === 'command') out.push(e)
      else if (e.kind === 'submenu') walk(e.items)
    }
  }
  for (const s of sections) walk(s.items)
  return out
}

/** Whether a command item can be picked now. Items with a text fallback stay on for text fields. */
export function menuItemEnabled(e: CommandEntry): boolean {
  if (e.text) return true
  const c = getCommand(e.id)
  return c !== undefined && isEnabled(c)
}

/** Runs a picked item: the text field's own edit when one has focus and the item has one, else the command. */
export function runMenuCommand(e: CommandEntry): void {
  // Nothing runs behind the pre-alpha agreement.
  if (get().agreementOpen) return
  const el = document.activeElement
  if (e.text && isTextField(el)) {
    if (e.text === 'selectAll' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select()
    else document.execCommand(e.text === 'delete' ? 'forwardDelete' : e.text)
    return
  }
  void runCommand(e.id)
}

/**
 * On macOS, Cut and Copy picked from the menu reach the page as clipboard events, not keys. Outside text
 * they act on the selected objects, the same as the keys. Paste already goes through the plate's paste event.
 */
export function bridgeClipboard(): () => void {
  const on = (id: 'copy' | 'cut') => (e: ClipboardEvent) => {
    const text = window.getSelection()
    if (isTextField(e.target) || (text && !text.isCollapsed)) return
    const s = get()
    if (s.workspace !== 'prepare' || s.selection === null) return
    e.preventDefault()
    void runCommand(id)
  }
  const copy = on('copy')
  const cut = on('cut')
  window.addEventListener('copy', copy)
  window.addEventListener('cut', cut)
  return () => {
    window.removeEventListener('copy', copy)
    window.removeEventListener('cut', cut)
  }
}
