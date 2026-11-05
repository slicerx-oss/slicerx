// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { lazyCamera } from '../pair/lazy'
import { onHomeNetwork } from './home-network'

const host = { camera: async () => null }

it('is home on the computer network and away through the relay', async () => {
  expect(await onHomeNetwork({ camera: () => lazyCamera(host, async () => 'lan') })).toBe(true)
  expect(await onHomeNetwork({ camera: () => lazyCamera(host, async () => 'relay') })).toBe(false)
  // A connection that cannot say counts as away.
  expect(await onHomeNetwork({ camera: () => lazyCamera(host, async () => Promise.reject(new Error('gone'))) })).toBe(false)
  // The demo fleet has no paired camera.
  expect(await onHomeNetwork({ camera: () => null })).toBe(true)
})
