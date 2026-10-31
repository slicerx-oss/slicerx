// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's tabs by name, for mimir's prompt on a local model: read from the navigate commands registered now, so a
// build without the Vault or the printers never names them.
import type { CommandSpec } from '@slicerx/contracts'

const GO_TO = 'Go to '

/**
 * The tabs the registered commands go to: the plate's modes first (mimir, which is this chat, then Model and Slice),
 * then the workspaces in tab order (commands/builtin.ts), each name once.
 */
export function appTabs(commands: readonly CommandSpec[]): string[] {
  const go = commands.filter((c) => c.section === 'navigate' && c.title.startsWith(GO_TO))
  const modes = go.filter((c) => c.id.startsWith('mode-'))
  const workspaces = go.filter((c) => c.id.startsWith('open-'))
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of [...modes, ...workspaces]) {
    const name = c.title.slice(GO_TO.length)
    if (seen.has(name)) continue
    seen.add(name)
    out.push(c.id === 'mode-mimir' ? `${name} (this chat)` : name)
  }
  return out
}
