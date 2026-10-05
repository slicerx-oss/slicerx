// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandEntry, MenuSection } from '@slicerx/app'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoked: [] as [string, unknown][],
  menusSet: 0,
  listeners: new Map<string, (e: { payload: string }) => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    tauri.invoked.push([cmd, args])
  },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: string }) => void) => {
    tauri.listeners.set(name, cb)
    return () => undefined
  },
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }))
// Any menu the page builds and sets would replace the shell's bar.
vi.mock('@tauri-apps/api/menu', () => {
  const made = async () => ({
    setAsAppMenu: async () => void tauri.menusSet++,
    setAsWindowMenu: async () => void tauri.menusSet++,
    close: async () => undefined,
  })
  return { Menu: { new: made }, Submenu: { new: made }, MenuItem: { new: made }, PredefinedMenuItem: { new: made } }
})

const undo: CommandEntry = { kind: 'command', id: 'undo', label: '&Undo', accelerator: 'CmdOrCtrl+Z', text: 'undo' }
const sections: MenuSection[] = [
  { label: '&Edit', items: [undo, { kind: 'separator' }, { kind: 'native', item: 'copy' }] },
  { label: '&View', items: [{ kind: 'command', id: 'open-prepare', label: 'Model', accelerator: 'CmdOrCtrl+1' }, { kind: 'window', action: 'fullscreen', label: '&Full screen', accelerator: 'F11' }] },
]

beforeEach(() => {
  tauri.invoked.length = 0
  tauri.menusSet = 0
  tauri.listeners.clear()
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})

describe('the native menu bar', () => {
  it('patches the menu the shell starts with and never sets a menu of its own', async () => {
    const { createNativeMenu } = await import('../src/menu')
    const menu = createNativeMenu()
    await menu.set(sections, () => undefined, ['e', 'v'])
    await menu.set([sections[0]!], () => undefined, ['e'])
    expect(tauri.menusSet).toBe(0)
    expect(tauri.invoked.filter(([c]) => c === 'menu_sync')).toEqual([
      ['menu_sync', { sections }],
      ['menu_sync', { sections: [sections[0]] }],
    ])
  })

  it('runs the command item the shell reports as picked', async () => {
    const { createNativeMenu } = await import('../src/menu')
    const ran: CommandEntry[] = []
    await createNativeMenu().set(sections, (e) => ran.push(e), [])
    tauri.listeners.get('sx-menu')?.({ payload: 'undo' })
    tauri.listeners.get('sx-menu')?.({ payload: 'not-a-command' })
    expect(ran).toEqual([undo])
  })

  it('tells the menu model which items the startup bar already shows', async () => {
    const { createNativeMenu } = await import('../src/menu')
    const startup = createNativeMenu().startup
    expect(startup?.get('project-save')).toBe('CmdOrCtrl+S')
    expect(startup?.get('help-about')).toBe('')
  })

  it('greys items in and out through the shell', async () => {
    const { createNativeMenu } = await import('../src/menu')
    createNativeMenu().enable('undo', false)
    await Promise.resolve()
    expect(tauri.invoked).toContainEqual(['menu_enable', { id: 'undo', on: false }])
  })
})
