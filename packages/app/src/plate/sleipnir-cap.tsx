// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir prints layers of at most half the nozzle, whatever the layer height says, so a layer height above that with
// sleipnir on is passed over without a word: a 0.28 mm print on a 0.4 mm nozzle comes out at 0.20 mm and up to a third
// slower. This line says so where the layer height is set, with the one way to get the layer height asked for:
// sleipnir off. Under the Slice plate button it shows only while the settings are not on screen beside it (a phone with
// its settings sheet shut, or the settings pane shut), so it is never said twice at once. Nothing changes until the
// person presses the button.
import { isSmartLayerOn, smartLayerCap, smartLayerCapText } from '@slicerx/settings'
import { Button, Icon } from '@slicerx/ui'
import { useStore } from 'zustand'
import { matchGoal } from '../adapters/config'
import { useLayout } from '../first-run/look'
import { useCompactLayout } from '../lib/phone-layout'
import { useMediaQuery } from '../lib/media'
import { sheets } from '../shell/pane'
import { INPUTS, KEY_CONFIG } from '../state/slice-inputs'
import { plateSliceConfig } from '../state/slice-plate'
import { markStale, railOpen, set, useApp, type AppState } from '../state/store'

const READ = [...INPUTS, ...KEY_CONFIG] as const
let last: { from: unknown[]; text: string | null } | null = null

/**
 * The line for the active plate as it would slice, or null: sleipnir off, a layer height it reaches, or a plate whose
 * layers it does not plan (a calibration plate, the plate's own layer heights). Kept while the slice inputs stay the same.
 */
export function sleipnirCapText(s: AppState): string | null {
  // a plate object whose mesh has not come in yet (a project still opening) has no parts to slice: no line until it has
  if (s.plate.some((o) => !o.handle)) return null
  const from = READ.map((k) => s[k])
  if (last && last.from.every((v, i) => v === from[i])) return last.text
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const own = Boolean(s.calibration[s.activePlate]) || Boolean(meta?.settings.layerProfile?.length)
  const cap = own ? null : smartLayerCap(plateSliceConfig(s, meta) as Record<string, unknown>)
  last = { from, text: cap ? smartLayerCapText(cap) : null }
  return last.text
}

/** Turns sleipnir off as the person's own choice, in Easy and in an Expert value that turned it on. */
export function turnSleipnirOff(): void {
  set((s) => {
    // as the Layer height picker does (easy-settings.tsx update)
    const easy = { ...s.easy, varyLayerHeight: false }
    return {
      easy,
      goal: matchGoal(easy) ?? 'custom',
      easyTouched: s.easyTouched.includes('varyLayerHeight') ? s.easyTouched : [...s.easyTouched, 'varyLayerHeight'],
      ...(isSmartLayerOn([s.overrides['smart_layer']].flat()[0]) ? { overrides: { ...s.overrides, smart_layer: 'off' } } : {}),
    }
  })
  markStale()
}

export const SLEIPNIR_OFF = 'Turn sleipnir off'

/**
 * Whether the line goes under the Slice plate button: only while the settings, which say it under Layer height, are not
 * on screen. On a compact screen the settings are a sheet; otherwise a pane that can be shut.
 */
export function capUnderSlice(o: { compact: boolean; sheetOpen: boolean; paneOpen: boolean }): boolean {
  return o.compact ? !o.sheetOpen : !o.paneOpen
}

/** Whether the Slice tab's settings are on screen: their sheet open on a compact screen, else their pane open. */
function useSettingsShown(): boolean {
  const side = useLayout().sidebar.side
  const compact = useCompactLayout()
  const wide = useMediaQuery('(min-width: 1280px)')
  const sheetOpen = useStore(sheets, (s) => s.open === `prepare:${side}`)
  const paneOpen = useApp((s) => railOpen(s.rails, 'prepare', side, wide))
  return !capUnderSlice({ compact, sheetOpen, paneOpen })
}

/** The line with its button. `underSlice`: the one under the Slice plate button, shown only while the settings are not. */
export function SleipnirCapLine({ testId, underSlice = false }: { testId: string; underSlice?: boolean }) {
  const text = useApp(sleipnirCapText)
  const shown = useSettingsShown()
  if (!text || (underSlice && shown)) return null
  return (
    <div className="support-line" role="status" data-testid={testId}>
      <Icon name="alert" />
      <span className="support-body">
        <span className="sleipnir-cap-text">{text}</span>
        <Button size="sm" data-testid={`${testId}-off`} onClick={turnSleipnirOff}>
          {SLEIPNIR_OFF}
        </Button>
      </span>
    </div>
  )
}
