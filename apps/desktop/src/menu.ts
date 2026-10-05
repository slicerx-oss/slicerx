// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the shell's menu bar (apps/desktop/src-tauri/src/menu.rs) in step with the app's menu model
// (packages/app/src/commands/menu.ts). The bar the shell shows from the first frame stays on the window:
// replacing it would show a bar with menus missing, or none, for a frame. The shell patches the menus that
// differ, greys items in and out, and hands picks of command items back here as `sx-menu` events.
import type { CommandEntry, MenuEntry, MenuSection, NativeMenu } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import shellMenus from '../src-tauri/menu.json'

type Platform = NativeMenu['platform']

function platform(): Platform {
  const ua = navigator.userAgent
  return /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'macos' : 'linux'
}

async function quit(): Promise<void> {
  // The same path as closing the window: unsaved changes are asked about first.
  const { confirmDiscard } = await import('@slicerx/app')
  if (await confirmDiscard('quit')) await invoke('quit_app')
}

async function toggleFullscreen(): Promise<void> {
  const w = getCurrentWindow()
  await w.setFullscreen(!(await w.isFullscreen()))
}

function walk(items: readonly MenuEntry[], each: (e: MenuEntry) => void): void {
  for (const e of items) {
    each(e)
    if (e.kind === 'submenu') walk(e.items, each)
  }
}

/** The command items of the bar the shell starts with, and their accelerators. */
function startupItems(os: Platform): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of (shellMenus as Record<Platform, MenuSection[]>)[os]) {
    walk(s.items, (e) => {
      if (e.kind === 'command') out.set(e.id, e.accelerator ?? '')
    })
  }
  return out
}

export function createNativeMenu(): NativeMenu {
  const os = platform()
  let byCommand = new Map<string, CommandEntry>()
  let run: ((entry: CommandEntry) => void) | null = null
  let windowKeys: (() => void) | null = null
  let picks: Promise<unknown> | null = null

  return {
    platform: os,
    startup: startupItems(os),
    async set(sections: readonly MenuSection[], runEntry: (entry: CommandEntry) => void, accessKeys: readonly string[]) {
      const commands = new Map<string, CommandEntry>()
      const keyed: { accelerator: string; act: () => void }[] = []
      for (const s of sections) {
        walk(s.items, (e) => {
          if (e.kind === 'command') commands.set(e.id, e)
          else if (e.kind === 'window' && e.accelerator) keyed.push({ accelerator: e.accelerator, act: e.action === 'quit' ? () => void quit() : () => void toggleFullscreen() })
        })
      }
      byCommand = commands
      run = runEntry
      picks ??= listen<string>('sx-menu', (ev) => {
        const e = byCommand.get(ev.payload)
        if (e) run?.(e)
      })
      await picks
      await invoke('menu_sync', { sections })
      // Windows hands keys in the page to the page, so the window's own keys (F11) and the menus' access
      // keys (Alt+F opens File) are caught here.
      windowKeys?.()
      windowKeys = null
      if (os === 'windows') {
        const access = new Set(accessKeys)
        const onKey = (ev: KeyboardEvent) => {
          if (ev.ctrlKey || ev.metaKey) return
          if (ev.altKey) {
            const key = ev.key.toLowerCase()
            if (ev.shiftKey || !access.has(key)) return
            ev.preventDefault()
            void invoke('menu_key', { key })
            return
          }
          const hit = keyed.find((k) => k.accelerator === ev.key)
          if (!hit) return
          ev.preventDefault()
          hit.act()
        }
        window.addEventListener('keydown', onKey)
        windowKeys = () => window.removeEventListener('keydown', onKey)
      }
    },
    enable(id: string, on: boolean) {
      void invoke('menu_enable', { id, on }).catch(() => undefined)
    },
  }
}
