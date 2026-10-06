// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { BuildVolume, FindGuide } from '../types.ts'

export const rect = (x: number, y: number, z: number): BuildVolume => ({ shape: 'rectangular', x, y, z })
export const round = (diameter: number, z: number): BuildVolume => ({ shape: 'circular', diameter, z })

/** Find guides. The wording follows each maker's documentation; none has been read off a printer yet. */
export const find = (g: Omit<FindGuide, 'checkedOnPrinter'>): FindGuide => ({ ...g, checkedOnPrinter: false })

export const FIND_KLIPPER: FindGuide = find({
  ip: 'Your router\'s device list shows it. On the printer\'s computer, run hostname -I. Mainsail and Fluidd also show it in their address bar. SlicerX uses Moonraker on port 7125, or port 80 where the web page passes it through.',
  credential: 'Usually none. If SlicerX says it was rejected, add your network to trusted_clients in moonraker.conf and restart Moonraker (it reads the file only when it starts), or read the key with curl http://PRINTER_IP:7125/access/api_key from a trusted machine. The printer\'s own address is not trusted on its own. A printer that requires logins also takes its user name and password.',
})

/** QIDI: Fluidd is on port 10088, Moonraker on 7125 (QIDI's X-Max 3 repository, HelixScreen and Obico guides). */
export const FIND_QIDI: FindGuide = find({
  ip: 'On the touchscreen, open the network settings to see the IP address, or look in your router\'s device list. The Fluidd page is at port 10088; SlicerX uses Moonraker on port 7125 behind it.',
  credential: 'Usually none. If SlicerX says it was rejected, read the key with curl http://PRINTER_IP:7125/access/api_key from a trusted machine, or enter the Fluidd login when your firmware asks for one.',
})
