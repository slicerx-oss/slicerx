// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { BuildVolume, FindGuide } from '../types.ts'

export const rect = (x: number, y: number, z: number): BuildVolume => ({ shape: 'rectangular', x, y, z })
export const round = (diameter: number, z: number): BuildVolume => ({ shape: 'circular', diameter, z })

/** Find guides. The wording follows each maker's documentation; none has been read off a printer yet. */
export const find = (g: Omit<FindGuide, 'checkedOnPrinter'>): FindGuide => ({ ...g, checkedOnPrinter: false })

export const FIND_KLIPPER: FindGuide = find({
  ip: 'Your router\'s device list shows it. On the printer\'s computer, run hostname -I. Mainsail and Fluidd also show it in their address bar.',
  credential: 'Usually none. If SlicerX says it was rejected, add your network to trusted_clients in moonraker.conf, or read the key with curl http://PRINTER_IP:7125/access/api_key from a trusted machine.',
})
