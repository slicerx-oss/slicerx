// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's camera bound to the current source's feed, for the Printers tab tiles.
import { useFeed } from '../camera/use-feed'
import { LiveView } from '../components/printers/live-view'
import type { VideoProps } from '../screens/printers-screen'

export function LiveVideo({ printer, quality }: VideoProps) {
  const available = printer.status?.cameraAvailable === true && printer.status.state !== 'offline'
  const feed = useFeed(printer.info.id, available, quality)
  return <LiveView {...feed} name={printer.info.name} available={available} aspect={9 / 16} quiet />
}
