// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the shell's native menu bar in step with the registered commands, the look's keymap and
// which commands can run now. Does nothing where the shell has no menu (the browser).
import { keymapFor } from '@slicerx/ui'
import { useEffect, useRef } from 'react'
import { bugReportsOff } from '../bugs/where'
import { currentEdition } from '../edition'
import { useLookChoice } from '../first-run/look'
import { appStore } from '../state/store'
import { bridgeClipboard, menuAccessKeys, menuCommands, menuItemEnabled, menuModel, nativeMenu, runMenuCommand, type CommandEntry } from './menu'
import { useCommands } from './registry'

export function useNativeMenu(): void {
  const commands = useCommands()
  const choice = useLookChoice()
  const shown = useRef('')
  const items = useRef<CommandEntry[]>([])
  const enabled = useRef(new Map<string, boolean>())
  const queue = useRef(Promise.resolve())

  useEffect(() => {
    const menu = nativeMenu()
    if (!menu) return
    const taken = new Set(Object.values(keymapFor(choice.id, choice.overrides?.keys ?? {})).filter((k): k is string => Boolean(k)))
    // An edition with bug reports off drops Report a bug from the menu the shell started with, too.
    const omit = bugReportsOff(currentEdition()) ? new Set(['help-report']) : undefined
    const sections = menuModel(commands, { platform: menu.platform, taken, ...(menu.startup ? { startup: menu.startup } : {}), ...(omit ? { omit } : {}) })
    const access = menuAccessKeys(sections, [...taken, ...commands.flatMap((c) => (c.shortcut ? [c.shortcut] : []))])
    const sig = JSON.stringify([sections, access])
    if (sig === shown.current) return
    shown.current = sig
    // Builds run one at a time, so a quick change cannot leave an older menu on screen.
    queue.current = queue.current.then(async () => {
      await menu.set(sections, runMenuCommand, access)
      items.current = menuCommands(sections)
      enabled.current = new Map()
      sync()
    }).catch(() => undefined)
  }, [commands, choice])

  useEffect(() => {
    const menu = nativeMenu()
    if (!menu) return
    const off = appStore.subscribe(sync)
    const offClipboard = menu.platform === 'macos' ? bridgeClipboard() : () => undefined
    return () => {
      off()
      offClipboard()
    }
  }, [])

  function sync(): void {
    const menu = nativeMenu()
    if (!menu) return
    for (const e of items.current) {
      const on = menuItemEnabled(e)
      if (enabled.current.get(e.id) === on) continue
      enabled.current.set(e.id, on)
      menu.enable(e.id, on)
    }
  }
}
