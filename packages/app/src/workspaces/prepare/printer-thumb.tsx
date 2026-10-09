// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The picture in the machine card's printer box.
import { Icon, type IconName } from '@slicerx/ui'
import { useState } from 'react'
import { printerImage } from '../../first-run/printer-images'
import { typeIcon } from '../../first-run/printer-form'
import { catalogModel } from '../../plate/preflight'

/** The printer's picture from the catalog, or a line drawing of its kind of machine (bed slinger, CoreXY box, delta and
 * so on) when the catalog has none or does not know the model: never an empty box. */
export function printerPicture(vendor: string, model: string): { src: string } | { icon: IconName } {
  const known = catalogModel({ vendor, model })
  const src = known ? printerImage(known.id) : null
  return src ? { src } : { icon: known ? typeIcon(known) : 'printer-corexy-open' }
}

export function PrinterThumb({ vendor, model }: { vendor: string; model: string }) {
  const pic = printerPicture(vendor, model)
  const [broken, setBroken] = useState(false)
  if ('src' in pic && !broken) return <img className="mc-thumb" src={pic.src} alt="" width={28} height={40} decoding="async" onError={() => setBroken(true)} />
  return (
    <span className="mc-thumb" data-drawn="">
      <Icon name={'icon' in pic ? pic.icon : 'printer-corexy-open'} size={28} />
    </span>
  )
}
