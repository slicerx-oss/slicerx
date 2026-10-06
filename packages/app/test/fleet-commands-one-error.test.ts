// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer whose status call fails must not take the other printers' commands with it.
import type { PrinterInfo } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { getCommand } from '../src/commands/registry'
import { fleetFeature } from '../src/features/fleet'

const info = (id: string): PrinterInfo => ({ id, name: id.toUpperCase(), vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan' }) as PrinterInfo

describe('printer commands', () => {
  it('are listed for every printer when one printer cannot be read', async () => {
    const host = {
      kind: 'desktop',
      capabilities: {},
      printers: {
        // The failing printer comes first, so the others are only reached past its error.
        list: async () => [info('bad'), info('good')],
        status: async (id: string) => {
          if (id === 'bad') throw Object.assign(new Error('printer bad rejected the credentials'), { code: 'auth' })
          return { printerId: id, state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date().toISOString() }
        },
        subscribe: () => () => undefined,
      },
    }
    fleetFeature.commands?.(host as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(getCommand('send-good')).toBeDefined()
  })
})
