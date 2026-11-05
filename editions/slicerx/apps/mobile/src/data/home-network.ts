// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the phone reaches the computer on its own network or through the relay, from the same signal the camera
// uses. A printer's own web page is offered only at home: away, its address (192.168.1.20, octopi.local) would open
// whatever answers to it on the network the phone is on, which may ask for the printer's password.
import type { PairedCamera } from '../camera/feed'

/** True on the computer's network; false through the relay, or when the connection cannot say. The demo fleet is home. */
export async function onHomeNetwork(printers: { camera(): PairedCamera | null }): Promise<boolean> {
  const camera = printers.camera()
  if (!camera) return true
  if (!camera.remote) return false
  return !(await camera.remote().catch(() => true))
}
