// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer whose status call fails (a wrong access code, a driver error) shows as offline with the reason
// on its own tile; the other printers are still listed.
import type { PrinterHost, PrinterInfo } from '@slicerx/contracts'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { fleetQuery } from '../src/lib/queries'

const info = (id: string): PrinterInfo => ({ id, name: id.toUpperCase(), vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan' }) as PrinterInfo

describe('the printers list', () => {
  it('keeps every printer when one printer\'s status fails', async () => {
    const printers = {
      list: async () => [info('a'), info('b')],
      status: async (id: string) => {
        if (id === 'b') throw Object.assign(new Error('printer b rejected the credentials'), { code: 'auth' })
        return { printerId: id, state: 'idle', updatedAt: new Date().toISOString() }
      },
    } as unknown as PrinterHost
    const rows = await new QueryClient().fetchQuery(fleetQuery(printers))
    expect(rows.map((r) => [r.id, r.status.state])).toEqual([
      ['a', 'idle'],
      ['b', 'offline'],
    ])
    expect(rows[1]!.status.message).toMatch(/rejected the credentials/)
  })
})
