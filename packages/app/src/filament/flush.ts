// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Flush volumes: how much filament (mm3) a color change purges through the nozzle before the new color runs clean.
// The calculation lives in @slicerx/settings, shared with the MCP server's project slices; the app redoes its flush
// values once the measured tables load.
import { onFlushData } from '@slicerx/settings/flush'

export * from '@slicerx/settings/flush'

// A store write every reader of flush values depends on; imported here so the store need not import this module.
// It is a refresh, not an edit, so it leaves no undo step.
onFlushData(() => Promise.all([import('../state/store'), import('../plate/history')]).then(([s, h]) => h.quietly(() => s.set((state) => ({ flush: { ...state.flush } })))))
