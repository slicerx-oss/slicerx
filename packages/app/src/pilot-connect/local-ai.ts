// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Set up local AI in the app: the shared logic lives in @slicerx/pilot/local-ai. This adds where
// the hardware read and the local requests come from: the desktop shell registers its own, the
// browser build reads navigator and uses fetch.
import type { Host } from '@slicerx/contracts'
import { fetchNet, type Hardware } from '@slicerx/pilot/local-ai'
import { useMemo, useSyncExternalStore } from 'react'
import { onLocalAiChange, registeredLocalAi, type LocalAiHost } from './local-ai-host'

export * from '@slicerx/pilot/local-ai'
export { registerLocalAi, type LocalAiHost } from './local-ai-host'

/** The browser's view: cores and, in Chromium, memory rounded down and capped at 8 GB. No graphics memory. */
export function browserHardware(
  nav: Pick<Navigator, 'hardwareConcurrency'> & {
    deviceMemory?: number
  } = navigator,
): Hardware {
  return {
    gpu: null,
    ramMb: nav.deviceMemory ? nav.deviceMemory * 1024 : null,
    cores: nav.hardwareConcurrency || null,
    source: 'browser',
  }
}

export function localAiFor(_host?: Host): LocalAiHost {
  const factory = registeredLocalAi()
  return factory ? factory() : { hardware: async () => browserHardware(), net: fetchNet() }
}

export function useLocalAi(): LocalAiHost {
  const f = useSyncExternalStore(onLocalAiChange, registeredLocalAi, () => null)
  return useMemo(() => (f ? f() : localAiFor()), [f])
}
