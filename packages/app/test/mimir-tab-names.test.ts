// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tabs mimir's prompt names on a local model come from the navigate commands the app registers, so a build
// without the Vault or the printers never names them.
import type { Host } from '@slicerx/contracts'
import { tabsLine } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { resolveFeatures } from '../src/features'
import { fleetFeature } from '../src/features/fleet'
import { storeFeature } from '../src/features/store'
import { appTabs } from '../src/workspaces/mimir/tabs'

/** The tab names for a host, through the same path the app takes: its features' workspaces, then the built-in commands. */
function tabsFor(host: Host): string[] {
  const { workspaces } = resolveFeatures(host, [storeFeature, fleetFeature])
  return appTabs(builtinCommands(host, workspaces))
}

const full = { kind: 'desktop', store: {}, printers: {}, approvals: {} } as unknown as Host
const bare = { kind: 'desktop' } as unknown as Host

describe('the tabs a local model is told about', () => {
  it('names the plate modes and every workspace the build has, each once', () => {
    expect(tabsFor(full)).toEqual(['mimir (this chat)', 'Model', 'Slice', 'Vault', 'My models', 'Printers'])
    expect(tabsLine(tabsFor(full))).toBe('The app has these tabs: mimir (this chat), Model, Slice, Vault, My models and Printers. Name no other tab.')
  })

  it('leaves out the Vault and Printers in a build without the store and the printers', () => {
    const tabs = tabsFor(bare)
    expect(tabs).toEqual(['mimir (this chat)', 'Model', 'Slice', 'My models'])
    const line = tabsLine(tabs)
    expect(line).toBe('The app has these tabs: mimir (this chat), Model, Slice and My models. Name no other tab.')
    expect(line).not.toMatch(/Vault|Printers/)
  })

  it('names only the workspaces registered: the Vault without the printers', () => {
    expect(tabsFor({ kind: 'desktop', store: {} } as unknown as Host)).toEqual(['mimir (this chat)', 'Model', 'Slice', 'Vault', 'My models'])
  })

  it('names nothing without navigate commands', () => {
    expect(appTabs([])).toEqual([])
    expect(tabsLine([])).toBe('')
  })
})
