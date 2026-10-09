// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The machine card at the top of the Slice sidebar: one row of three boxes, the printer (its picture, name, model and
// status), its nozzle (size and type) and the active plate's plate type (its icon). Each box opens a popover to change
// it in place. Without a printer the card says what the slice is for and offers to add one.
import { Block, Button, Icon, LinkButton, MenuAnchor, Pill, Popover, tipAttrs, type IconName } from '@slicerx/ui'
import { lazy, Suspense, useMemo, useState, type KeyboardEvent } from 'react'
import { resolveConfig } from '../../adapters/config'
import { GENERIC_BED } from '../../adapters/generic-bed'
import { effectiveMode, openSetup, useLayout } from '../../first-run/look'
import { usePrinter } from '../../lib/use-printer'
import { shortPrinterName } from '../../lib/short-name'
import { BED_TYPE_OPTIONS, plateBedType, type BedType } from '../../plate/bed-type'
import { activeMeta, setPlateSettings } from '../../plate/plates'
import { setPrinterNozzle } from '../../state/profile-sync'
import { set, useApp } from '../../state/store'
import { printerPill } from './prepare-panes'
import './machine-card.css'

// The printer's picture needs the printer catalog, which stays out of the startup code.
const PrinterThumb = lazy(() => import('./printer-thumb').then((m) => ({ default: m.PrinterThumb })))
const PrinterSettingsDialog = lazy(() => import('./printer-settings').then((m) => ({ default: m.PrinterSettingsDialog })))

/** Each plate type's icon in the plate popover. */
export const BED_ICON: Record<BedType, IconName> = {
  'textured-pei': 'textured-plate',
  'smooth-pei': 'smooth-plate',
  cool: 'plate-cool',
  engineering: 'engineering-plate',
  'high-temp': 'plate-high-temp',
}

/** Nozzle types in words, as setup records them. */
const NOZZLE_TYPE: Record<string, string> = { brass: 'Brass', 'hardened-steel': 'Hardened steel', 'stainless-steel': 'Stainless steel', 'tungsten-carbide': 'Tungsten carbide' }
/** The nozzle type in one word for the nozzle box. */
const NOZZLE_SHORT: Record<string, string> = { brass: 'Brass', 'hardened-steel': 'Hardened', 'stainless-steel': 'Stainless', 'tungsten-carbide': 'Carbide' }

/** The one-line summary of a folded card: name, nozzle, plate type and status, such as "Desk A1, 0.4 mm, Cool plate, Ready". */
export function machineSummary(name: string, nozzle: number | null, plate: string, status: string): string {
  return [name, nozzle !== null ? `${nozzle} mm` : null, plate, status].filter(Boolean).join(', ')
}

/** Arrow keys move between the options of a popover list, as in a radio group. */
function arrows(e: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'))
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
  e.preventDefault()
}

export function MachineCard() {
  const { rows, printer } = usePrinter()
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const profile = useApp((s) => s.profile)
  const noPrinter = useApp((s) => s.noPrinter)
  const printerSettingsOpen = useApp((s) => s.printerSettingsOpen)
  // The nozzle choice is kept per printer under the id the profile sync uses.
  const nozzleKey = useApp((s) => s.printerModel?.id)
  // In the store, so a note's "Change printer" can open the printer list.
  const chooserOpen = useApp((s) => s.printerChooserOpen)
  const extruders = useApp((s) => (printer ? s.printerExtruders[printer.id] : undefined))
  const meta = useApp(activeMeta)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  // Which chip's popover is open; one at a time.
  const [pop, setPop] = useState<string | null>(null)
  const cfg = useMemo(() => resolveConfig(easy, overrides), [easy, overrides, profile])
  // The plate type the active plate prints on, and the one it gets with none of its own.
  const plate = useMemo(() => plateBedType(meta, cfg), [meta, cfg])
  const fallback = useMemo(() => plateBedType(undefined, cfg), [cfg])
  const printerOpen = pop === 'printer' || chooserOpen
  const closePrinter = () => {
    setPop(null)
    if (chooserOpen) set({ printerChooserOpen: false })
  }

  if (!printer) {
    return (
      <Block className="machine-card" data-section="printer" data-testid="slice-machine-card" data-state="none">
        <div className="mc-none">
          <span className="mc-generic" {...tipAttrs({ title: 'No printer yet', body: `Until you add one, slices are for a generic ${GENERIC_BED.widthMm} by ${GENERIC_BED.depthMm} mm bed, ${GENERIC_BED.heightMm} mm tall.` })}>
            <Icon name="printer" size={16} />
            Generic {GENERIC_BED.widthMm} mm bed
          </span>
          <Button size="sm" icon="plus" data-testid="slice-machine-printer-add" onClick={() => openSetup('printer')}>
            Add printer
          </Button>
          {noPrinter ? null : (
            <LinkButton onClick={() => set({ noPrinter: true })} {...tipAttrs({ title: 'Slice without a printer', body: 'Keeps the generic bed and stops opening printer setup at launch. Add a printer here any time.' })}>
              Slice without a printer
            </LinkButton>
          )}
        </div>
      </Block>
    )
  }

  const pill = printerPill(printer)
  const error = printer.status.state === 'error' ? printer.status.message : undefined
  // The printer's profile loads after the printer is picked; until then the nozzle chip keeps its place as a skeleton.
  const loading = profile === null
  const nozzle = loading ? null : profile.nozzle
  const fixedNozzle = profile?.nozzleFrom === 'printer'
  // The model beside the name, muted: a bay name alone says little with several printers of different models.
  const modelName = [printer.vendor, printer.model].filter(Boolean).join(' ')
  const modelLine = modelName + (nozzle !== null ? `, ${nozzle} mm` : '')
  const summary = machineSummary(printer.name, nozzle, plate.label, pill.label)
  const setPlate = (v: BedType | '') => {
    if (!meta) return
    const { bedType: _drop, ...rest } = meta.settings
    setPlateSettings(meta.id, v ? { ...rest, bedType: v } : rest, true)
    setPop(null)
  }

  const status = (
    <Pill state={pill.state} className="mc-status" data-testid="slice-machine-status" {...tipAttrs(error ? { title: 'Error', body: error } : { title: pill.label })}>
      {pill.label}
    </Pill>
  )
  const nozzleType = extruders?.[0]?.type
  const nozzleWord = nozzleType ? (NOZZLE_SHORT[nozzleType] ?? nozzleType) : null

  return (
    <Block className="machine-card" data-section="printer" data-testid="slice-machine-card">
      <div className="mc-row" data-summary={summary}>
        <MenuAnchor className="mc-printer">
          <button
            type="button"
            className="mc-box mc-name"
            data-testid="slice-machine-printer"
            aria-haspopup="dialog"
            aria-expanded={printerOpen}
            {...tipAttrs({ title: modelLine, body: 'Pick another printer, or add one.' })}
            onClick={() => (printerOpen ? closePrinter() : setPop('printer'))}
          >
            <Suspense fallback={<span className="mc-thumb" aria-hidden="true" />}>
              <PrinterThumb vendor={printer.vendor} model={printer.model} />
            </Suspense>
            <span className="mc-ptext">
              <span className="printer-name">{shortPrinterName(printer.name)}</span>
              <span className="mc-pline">
                {modelName && modelName !== printer.name ? (
                  <span className="mc-model" data-testid="slice-machine-model">
                    {modelName}
                  </span>
                ) : null}
                {status}
              </span>
            </span>
            <Icon name="chevron-down" size={14} className="mc-caret" />
          </button>
          <Popover open={printerOpen} onClose={closePrinter} label="Printer" className="mc-pop">
            <ul className="mc-list" aria-label="Choose a printer" onKeyDown={arrows}>
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={r.id === printer.id}
                    data-testid="slice-machine-printer-option"
                    data-printer-id={r.id}
                    onClick={() => {
                      set({ printerId: r.id })
                      closePrinter()
                    }}
                  >
                    <Icon name="check" size={14} className="mc-check" />
                    <span className="mc-opt">
                      {r.name} <span className="sx-muted">{r.model}</span>
                    </span>
                    <Pill state={printerPill(r).state}>{printerPill(r).label}</Pill>
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="choose-add"
                  data-testid="slice-machine-printer-add"
                  onClick={() => {
                    closePrinter()
                    openSetup('printer')
                  }}
                >
                  <Icon name="plus" size={14} />
                  <span className="mc-opt">Add printer</span>
                </button>
              </li>
              {mode !== 'simple' ? (
                <>
                  <li role="separator" className="mc-sep" />
                  <li>
                    <button
                      type="button"
                      data-testid="slice-machine-printer-settings"
                      onClick={() => {
                        closePrinter()
                        set({ printerSettingsOpen: true })
                      }}
                    >
                      <Icon name="sliders" size={14} />
                      <span className="mc-opt">Printer settings</span>
                    </button>
                  </li>
                </>
              ) : null}
            </ul>
          </Popover>
        </MenuAnchor>

        <MenuAnchor className="mc-nozzle">
          {loading ? (
            <span className="mc-box mc-skel" aria-hidden="true" data-w="nozzle" />
          ) : (
            <button
              type="button"
              className="mc-box mc-nbox"
              data-testid="slice-machine-nozzle"
              data-nozzle={nozzle}
              aria-haspopup="dialog"
              aria-expanded={pop === 'nozzle'}
              aria-label={`Nozzle: ${nozzle} mm`}
              {...tipAttrs({ title: `Nozzle, ${nozzle} mm${nozzleType ? `, ${(NOZZLE_TYPE[nozzleType] ?? nozzleType).toLowerCase()}` : ''}`, body: fixedNozzle ? 'The printer reports this nozzle.' : 'The size picks the presets that match it.' })}
              onClick={() => setPop(pop === 'nozzle' ? null : 'nozzle')}
            >
              <span className="mc-nhead">
                <Icon name="nozzle" size={14} />
                Nozzle
              </span>
              <span className="mc-nsize">
                {nozzle}
                <small> mm</small>
              </span>
              {nozzleWord ? <span className="mc-ntype">{nozzleWord}</span> : null}
              <Icon name="chevron-down" size={12} className="mc-caret" />
            </button>
          )}
          <Popover open={pop === 'nozzle'} onClose={() => setPop(null)} label="Nozzle" className="mc-pop">
              <div className="mc-list" role="radiogroup" aria-label="Nozzle size" onKeyDown={arrows}>
                {(profile?.nozzles ?? []).map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={n === nozzle}
                    disabled={fixedNozzle && n !== nozzle}
                    data-testid="slice-machine-nozzle-option"
                    data-nozzle={n}
                    onClick={() => {
                      setPrinterNozzle(nozzleKey ?? printer.id, n)
                      setPop(null)
                    }}
                  >
                    <Icon name="check" size={14} className="mc-check" />
                    <span className="mc-opt sx-mono">{n} mm</span>
                  </button>
                ))}
              </div>
              {fixedNozzle ? <p className="mc-note">The printer reports this nozzle.</p> : null}
              {extruders && extruders.length > 0 ? (
                <dl className="mc-extruders">
                  {extruders.map((x, i) => (
                    <div key={i}>
                      <dt>{extruders.length > 1 ? (i === 0 ? 'Left' : 'Right') : 'Nozzle'}</dt>
                      <dd>
                        {x.mm} mm{x.type ? `, ${(NOZZLE_TYPE[x.type] ?? x.type).toLowerCase()}` : ''}
                        {x.highFlow ? ', high flow' : ''}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </Popover>
        </MenuAnchor>

        <MenuAnchor className="mc-plate">
          <button
            type="button"
            className="mc-box mc-bbox"
            data-testid="slice-machine-plate"
            data-bed-type={plate.value}
            aria-haspopup="dialog"
            aria-expanded={pop === 'plate'}
            aria-label={`Plate: ${plate.label}`}
            {...tipAttrs({ title: plate.label, body: 'Set per plate. Change it here or in plate settings.' })}
            onClick={() => setPop(pop === 'plate' ? null : 'plate')}
          >
            <Icon name={BED_ICON[plate.value]} size={28} />
            <span className="sr-only">{plate.label}</span>
            <Icon name="chevron-down" size={12} className="mc-caret" />
          </button>
            <Popover open={pop === 'plate'} onClose={() => setPop(null)} label="Plate type" align="end" className="mc-pop">
              <div className="mc-list" role="radiogroup" aria-label="Plate type" onKeyDown={arrows}>
                <button type="button" role="radio" aria-checked={!meta?.settings.bedType} data-testid="slice-machine-plate-option" data-bed-type="" onClick={() => setPlate('')}>
                  <Icon name={BED_ICON[fallback.value]} size={16} />
                  <span className="mc-opt">Printer default ({fallback.label})</span>
                </button>
                {BED_TYPE_OPTIONS.map((o) => (
                  <button key={o.value} type="button" role="radio" aria-checked={meta?.settings.bedType === o.value} data-testid="slice-machine-plate-option" data-bed-type={o.value} onClick={() => setPlate(o.value)}>
                    <Icon name={BED_ICON[o.value]} size={16} />
                    <span className="mc-opt">{o.label}</span>
                  </button>
                ))}
              </div>
            </Popover>
        </MenuAnchor>
      </div>
      {printerSettingsOpen ? (
        <Suspense fallback={null}>
          <PrinterSettingsDialog printer={printer} />
        </Suspense>
      ) : null}
    </Block>
  )
}
