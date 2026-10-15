// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { geomEngine } from '../src/geom'

const bin = process.env['SLICERX_SX_GEOM_BIN']

it.skipIf(!bin)('preserves the native exact input refusal and permits a fresh exact call', async () => {
  const call = geomEngine(bin!, 20_000)
  const box = { min: [0, 0, 0], max: [20, 10, 5] }
  await expect(call('brep.box', { ...box, padding: 'x'.repeat(32 * 1024 * 1024) })).rejects.toThrow('exceeds 32 MiB')
  const fresh = await call('brep.box', box) as { body: number }
  expect(fresh.body).toBeGreaterThan(0)
}, 30_000)
