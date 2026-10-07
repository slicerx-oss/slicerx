// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandSpec, Host } from '@slicerx/contracts'
import { keymapFor } from '@slicerx/ui'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { menuAccessKeys, menuCommands, menuModel, runMenuCommand, toAccelerator, type MenuEntry, type MenuSection } from '../src/commands/menu'
import { registerCommands } from '../src/commands/registry'
import { plateCommands } from '../src/plate/commands'

const workspaces = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'preview', label: 'Preview' },
  { id: 'library', label: 'Vault' },
]
const all: CommandSpec[] = [...builtinCommands({} as Host, workspaces), ...plateCommands(() => ({ id: 'slicerx' }), { slicer: {} } as Host)]
const byId = new Map(all.map((c) => [c.id, c]))

function labels(items: readonly MenuEntry[]): string[] {
  return items.flatMap((e) => (e.kind === 'command' || e.kind === 'window' ? [e.label] : e.kind === 'submenu' ? [e.label, ...labels(e.items)] : []))
}

function section(model: MenuSection[], label: string): MenuSection {
  const s = model.find((m) => m.label === label)
  if (!s) throw new Error(`no ${label} menu`)
  return s
}

describe('native menu', () => {
  it('turns registry shortcuts into accelerators and leaves bare keys off', () => {
    expect(toAccelerator('Mod+Shift+Z')).toBe('CmdOrCtrl+Shift+Z')
    expect(toAccelerator('Mod+Alt+B')).toBe('CmdOrCtrl+Alt+B')
    expect(toAccelerator('B')).toBeUndefined()
    expect(toAccelerator('+')).toBeUndefined()
    expect(toAccelerator('Mod+1', new Set(['Mod+1']))).toBeUndefined()
  })

  it('maps every item to a registered command with that command\'s shortcut', () => {
    for (const platform of ['windows', 'linux', 'macos'] as const) {
      const items = menuCommands(menuModel(all, { platform }))
      expect(items.length).toBeGreaterThan(15)
      for (const e of items) {
        const c = byId.get(e.id)
        expect(c, e.id).toBeDefined()
        if (e.id !== 'settings-open' && e.id !== 'plate-remove') expect(e.accelerator, e.id).toBe(toAccelerator(c?.shortcut))
      }
    }
  })

  it('wires the standard items to the app commands', () => {
    const items = new Map(menuCommands(menuModel(all, { platform: 'windows', app: 'SlicerX' })).map((e) => [e.id, e]))
    expect(items.get('plate-open')?.accelerator).toBe('CmdOrCtrl+O')
    expect(items.get('project-save')?.accelerator).toBe('CmdOrCtrl+S')
    expect(items.get('export-gcode')?.accelerator).toBe('CmdOrCtrl+E')
    expect(items.get('undo')).toMatchObject({ accelerator: 'CmdOrCtrl+Z', text: 'undo' })
    expect(items.get('redo')).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+Z', text: 'redo' })
    expect(items.get('select-all')).toMatchObject({ accelerator: 'CmdOrCtrl+A', text: 'selectAll' })
    expect(items.get('open-preview')).toMatchObject({ label: 'Preview', accelerator: 'CmdOrCtrl+2' })
    expect(items.get('project-new')?.accelerator).toBe('CmdOrCtrl+N')
    expect(items.get('project-save-as')?.accelerator).toBe('CmdOrCtrl+Shift+S')
    expect(items.get('zoom-in')?.accelerator).toBe('CmdOrCtrl+=')
    expect(items.get('zoom-out')?.accelerator).toBe('CmdOrCtrl+-')
    expect(items.get('view-reset')?.accelerator).toBe('CmdOrCtrl+Shift+0')
    expect(items.get('project-export-locked')?.label).toBe('&Locked SlicerX project (.sxlock)…')
    for (const id of ['help-docs', 'help-report', 'project-recent', 'library-import', 'user-presets', 'export-gcode-3mf', 'camera-fit', 'help-shortcuts', 'help-about', 'settings-open']) expect(items.has(id), id).toBe(true)
  })

  it('has the same menus everywhere, with the app menu and window menu on macOS', () => {
    expect(menuModel(all, { platform: 'windows' }).map((s) => s.label)).toEqual(['&File', '&Edit', '&View', '&Help'])
    expect(menuModel(all, { platform: 'linux' }).map((s) => s.label)).toEqual(['&File', '&Edit', '&View', '&Help'])
    const mac = menuModel(all, { platform: 'macos', app: 'SlicerX' })
    expect(mac.map((s) => s.label)).toEqual(['SlicerX', '&File', '&Edit', '&View', 'Window', '&Help'])
    expect(section(mac, 'SlicerX').items).toContainEqual({ kind: 'window', action: 'quit', label: 'Quit SlicerX', accelerator: 'CmdOrCtrl+Q' })
    expect(labels(section(mac, '&File').items)).not.toContain('E&xit')
    const win = menuModel(all, { platform: 'windows' })
    expect(section(win, '&File').items.at(-1)).toEqual({ kind: 'window', action: 'quit', label: 'E&xit' })
    expect(section(win, '&View').items.at(-1)).toMatchObject({ kind: 'window', action: 'fullscreen', accelerator: 'F11' })
  })

  it('leaves off a tab key the look gives to a view', () => {
    const taken = new Set(Object.values(keymapFor('orcaslicer')).filter((k): k is string => Boolean(k)))
    const items = new Map(menuCommands(menuModel(all, { platform: 'linux', taken })).map((e) => [e.id, e]))
    expect(items.get('open-preview')?.accelerator).toBeUndefined()
    expect(items.get('plate-open')?.accelerator).toBe('CmdOrCtrl+O')
  })

  it('drops items whose command is missing and the separators around them', () => {
    const model = menuModel(builtinCommands({} as Host, workspaces), { platform: 'windows' })
    const file = section(model, '&File').items
    expect(menuCommands([{ label: 'f', items: file }]).map((e) => e.id)).not.toContain('project-save')
    expect(file[0]?.kind).not.toBe('separator')
    expect(file.some((e, i) => e.kind === 'separator' && file[i + 1]?.kind === 'separator')).toBe(false)
  })

  it('keeps labels in plain American English', () => {
    for (const platform of ['windows', 'macos'] as const) {
      for (const l of menuModel(all, { platform }).flatMap((s) => [s.label, ...labels(s.items)])) {
        expect(l).not.toMatch(/[\u2013\u2014]|\p{Extended_Pictographic}/u)
        expect(l).not.toMatch(/colour|licence|cancelled/i)
      }
    }
  })

  it('runs the command, or the text field\'s own edit when one has focus', async () => {
    let ran = 0
    const off = registerCommands([{ id: 'select-all', title: 'Select all', section: 'plate', run: () => void ran++ }])
    runMenuCommand({ kind: 'command', id: 'select-all', label: 'Select all', text: 'selectAll' })
    await Promise.resolve()
    expect(ran).toBe(1)
    const input = document.createElement('input')
    input.value = 'abc'
    document.body.append(input)
    input.focus()
    runMenuCommand({ kind: 'command', id: 'select-all', label: 'Select all', text: 'selectAll' })
    await Promise.resolve()
    expect(ran).toBe(1)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3])
    input.remove()
    off()
  })

  it('gives no two items the same accelerator, in any look', () => {
    for (const look of ['slicerx', 'orcaslicer', 'bambu-studio', 'prusaslicer']) {
      const taken = new Set(Object.values(keymapFor(look)).filter((k): k is string => Boolean(k)))
      for (const platform of ['windows', 'linux', 'macos'] as const) {
        const keys = menuCommands(menuModel(all, { platform, taken })).flatMap((e) => (e.accelerator ? [e.accelerator] : []))
        expect(new Set(keys).size, `${look} ${platform}`).toBe(keys.length)
      }
    }
  })

  it('gives no two items in a menu the same access key, so Alt and a letter runs the item', () => {
    // Windows' own Cut, Copy and Paste items.
    const native: Partial<Record<string, string>> = { cut: 't', copy: 'c', paste: 'p' }
    const accessKey = (label: string) => /&([^&])/.exec(label)?.[1]?.toLowerCase()
    const check = (items: readonly MenuEntry[], where: string) => {
      const keys = items.flatMap((e) => {
        const k = e.kind === 'native' ? native[e.item] : e.kind === 'separator' ? undefined : accessKey(e.label)
        return k ? [k] : []
      })
      expect(new Set(keys).size, `${where}: ${keys.join(' ')}`).toBe(keys.length)
      for (const e of items) if (e.kind === 'submenu') check(e.items, `${where} > ${e.label}`)
    }
    for (const platform of ['windows', 'linux'] as const) {
      check(
        menuModel(all, { platform }).map((s) => ({ kind: 'submenu', label: s.label, items: s.items })),
        platform,
      )
    }
  })

  it('passes Alt and a menu letter to the menu bar, unless the app uses that chord itself', () => {
    const model = menuModel(all, { platform: 'windows' })
    expect(menuAccessKeys(model, ['Mod+Alt+B', 'Mod+K'])).toEqual(['f', 'e', 'v', 'h'])
    expect(menuAccessKeys(model, ['Alt+V'])).toEqual(['f', 'e', 'h'])
    expect(menuAccessKeys(menuModel(all, { platform: 'macos' }), [])).toEqual(['f', 'e', 'v', 'h'])
  })

  it('keeps the startup items, greyed out, while the app is still registering their commands', () => {
    const full = menuModel(all, { platform: 'windows' })
    const startup = new Map(menuCommands(full).map((e) => [e.id, e.accelerator ?? '']))
    const early = menuModel(all.slice(0, 3), { platform: 'windows', startup })
    expect(early.map((s) => s.label)).toEqual(full.map((s) => s.label))
    for (const label of ['&File', '&Edit', '&Help']) expect(section(early, label), label).toEqual(section(full, label))
    expect(menuModel(all.slice(0, 3), { platform: 'windows' }).length).toBeLessThan(full.length)
  })

  // The shell draws this file from the first frame, before the page loads. SX_WRITE_MENU=1 rewrites it.
  it('matches the menu the desktop shell starts with', () => {
    const file = resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/menu.json')
    const model = { windows: menuModel(all, { platform: 'windows', app: '{app}' }), linux: menuModel(all, { platform: 'linux', app: '{app}' }), macos: menuModel(all, { platform: 'macos', app: '{app}' }) }
    if (process.env['SX_WRITE_MENU']) writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(model)))
  })
})
