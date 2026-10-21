// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sections Settings lists, in order: the ones features add (Account) and the base's own. Apart from the dialog so
// the app link can name and check them without loading it.
import type { EditionConfig } from '@slicerx/edition-config'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { IconName } from '@slicerx/ui'
import { bridgeConnector } from '../link/connector'
import { hostSlices } from '../state/model-mode'

export const PHONE_ID = 'phone'
export const BRIDGE_ID = 'bridge'
export const APPS_ID = 'apps'
export const CONTROLS_ID = 'controls'
export const PRESETS_ID = 'presets'
export const LOOK_ID = 'look'
export const SLICING_ID = 'slicing'
export const PILOT_ID = 'pilot'
export const MEMORY_ID = 'memory'
export const AGENTS_ID = 'agents'

export interface SettingsSectionRow {
  id: string
  label: string
  icon: IconName
}

/** The sections Settings shows for this edition and host, after the ones features add. */
export function settingsSections(edition: EditionConfig, features: readonly SettingsSectionRow[]): SettingsSectionRow[] {
  // the CAD-only browser build has no printers, presets or slicing to set
  const slices = hostSlices()
  const hasBridge = slices && bridgeConnector() !== null
  // Only the desktop app hosts the app link; the browser build's bridge never offers it.
  const hasAgents = bridgeConnector()?.automatic === true
  return [
    ...features.map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
    ...(edition.features.phonePairing && slices ? [{ id: PHONE_ID, label: 'Phone access', icon: 'phone' as IconName }] : []),
    ...(hasBridge
      ? [
          { id: BRIDGE_ID, label: 'Printer bridge', icon: 'connect-lan' as IconName },
          { id: APPS_ID, label: 'Connected apps', icon: 'plugin' as IconName },
        ]
      : []),
    ...(hasAgents ? [{ id: AGENTS_ID, label: 'Agents', icon: 'mcp' as IconName }] : []),
    ...(slices ? [{ id: PRESETS_ID, label: 'Presets', icon: 'save' as IconName }] : []),
    { id: CONTROLS_ID, label: 'Controls', icon: 'keyboard' },
    { id: LOOK_ID, label: 'Look and feel', icon: 'sliders' },
    slices ? { id: SLICING_ID, label: 'Slicing and modeling', icon: 'slice' } : { id: SLICING_ID, label: 'Modeling', icon: 'shapes' },
    ...(features.some((s) => s.id === PILOT_ID) ? [] : [{ id: PILOT_ID, label: ASSISTANT_NAME, icon: 'mimir' as IconName }]),
    // what mimir remembers, under its own section; an edition that keeps no notes has none to show
    ...(edition.ai.brain.memory.local ? [{ id: MEMORY_ID, label: 'Memory', icon: 'bookmark' as IconName }] : []),
  ]
}
