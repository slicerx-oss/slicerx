// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Estimate block's electricity figure: mimir's energy_estimate run as a plain function.
// Shown as an estimate: the wattage is the printer's typical draw. The price per kWh is the person's setting.
import { tipAttrs } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { energyFigure, plateMaterial, printerName, type EnergyFigure } from '../../plate/checks'
import { useApp } from '../../state/store'

/** A price with at least two decimals and no more than four: 0.15, 0.2175. */
export function priceText(price: number): string {
  const s = String(Number(price.toFixed(4)))
  const decimals = s.includes('.') ? s.split('.')[1]!.length : 0
  return decimals >= 2 ? s : price.toFixed(2)
}

export function EnergyRow({ timeS }: { timeS: number }) {
  const printer = useApp((s) => printerName(s))
  const material = useApp((s) => plateMaterial(s))
  const { pricePerKwh, symbol } = useApp((s) => s.electricity)
  const [fig, setFig] = useState<EnergyFigure | null>(null)
  useEffect(() => {
    let live = true
    void energyFigure(timeS, printer, material, pricePerKwh)
      .then((f) => live && setFig(f))
      .catch(() => live && setFig(null))
    return () => {
      live = false
    }
  }, [timeS, printer, material, pricePerKwh])
  if (!fig) return null
  return (
    <div>
      <dt>Electricity</dt>
      <dd {...tipAttrs({ title: 'Electricity', body: `${fig.assumed ? 'Estimated from a typical draw for this kind of printer' : "Estimated from the printer's typical draw while printing"}, at ${symbol}${priceText(pricePerKwh)} per kWh. Change the price in Settings.` })}>
        about {fig.kwh.toFixed(2)} kWh, {symbol}{fig.cost.toFixed(2)}
      </dd>
    </div>
  )
}
