// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slot editor (material, brand, product, color) and the flush volume dialog. Both edit the store
// live, so there is no Save step; undo steps back through changes.
import { materialType } from './slots'
import { useHost } from '../host'
import { filterSpools, spoolLabel, spoolVendors, useSpools, type Spool } from '../inventory/spools'
import { Button, Dialog, Field, Input, Range, Seg, Select, tipAttrs } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { Swatch } from '../parts'
import { get, set, useApp } from '../state/store'
import { clampFlush, FLUSH_DEFAULTS, FLUSH_LIMIT, flushMatrix, pairKey } from './flush'
import { brandList, productsFor, typeList, typesFor } from './presets'
import { useResolvedSlots } from './use-slots'
import { flushPlan, normalizeColor, resetSlots, setFlush, setFlushManual, setSlot } from './slots'
import { usePrinter } from '../lib/use-printer'
import { slotMatches, slotSettingFor, slotWriter, writeSlot } from './slot-write'

const NO_BRAND = ''

export function SlotDialog() {
  const index = useApp((s) => s.slotDialog)
  const slots = useResolvedSlots()
  const printer = useApp((s) => (index ? s.printerSlots[index - 1] : undefined))
  const slot = slots.find((r) => r.index === index)
  const brands = useMemo(() => brandList(), [])
  const types = slot?.brand ? typesFor(slot.brand) : typeList()
  const products = slot?.brand ? productsFor(slot.brand, slot.type) : []
  const close = () => set({ slotDialog: null })
  const host = useHost()
  const spools = useSpools(host)
  const links = useApp((s) => s.spoolLinks)
  const linked = index ? (links[index] ?? printer?.spoolmanId) : undefined
  // Writing the slot back to the printer: only where the hub can, for a slot set here that differs from what the printer reports.
  const target = usePrinter().printer
  const slotSetup = useApp((st) => st.slotSetup)
  const printerSlots = useApp((st) => st.printerSlots)
  const profile = useApp((st) => st.profile)
  const easy = useApp((st) => st.easy)
  const overrides = useApp((st) => st.overrides)
  const write = useMemo(
    () => (index && target && slotWriter(host) ? slotSettingFor({ ...get(), slotSetup, printerSlots, profile, easy, overrides }, index, target) : null),
    [index, target, host, slotSetup, printerSlots, profile, easy, overrides],
  )
  const differs = write && 'setting' in write ? !slotMatches(printer, write.setting) : false
  return (
    <Dialog
      open={index !== null && Boolean(slot)}
      onClose={close}
      className="slot-dialog"
      title={slot ? `Filament ${slot.label === String(slot.index) ? slot.index : `${slot.index} (${slot.label})`}` : 'Filament'}
      footer={
        <>
          {printer && slot?.source === 'user' ? (
            <Button variant="ghost" onClick={() => resetSlots(slot.index)}>
              Use what the printer reports
            </Button>
          ) : null}
          {printer && target && slot?.source === 'user' && write && (differs || 'reason' in write) ? (
            <Button
              icon="send-to-printer"
              disabled={'reason' in write}
              tip={{ title: 'Set on the printer', body: `Writes this filament to slot ${printer.id} of ${target.name}, as Bambu Studio does. Asks first.`, ...('reason' in write ? { reason: write.reason } : {}) }}
              onClick={() => void writeSlot(host, target, slot.index)}
            >
              Set on printer
            </Button>
          ) : null}
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      {slot ? (
        <div className="slot-form">
          {spools.length > 0 ? (
            <SpoolPicker
              spools={spools}
              linked={linked}
              onPick={(id) => {
                set((st) => {
                  const links = { ...st.spoolLinks }
                  if (id === undefined) delete links[slot.index]
                  else links[slot.index] = id
                  return { spoolLinks: links }
                })
                const sp = spools.find((x) => x.id === id)
                if (sp) setSlot(slot.index, { type: materialType(sp.material), brand: sp.vendor || slot.brand, color: sp.color })
              }}
            />
          ) : null}
          <Field htmlFor="slot-brand" label="Brand">
            <Select id="slot-brand" value={slot.brand} onChange={(e) => setSlot(slot.index, { brand: e.target.value, type: slot.type, ...(e.target.value === slot.brand ? {} : { family: '', vendor: '' }) })}>
              <option value={NO_BRAND}>Any brand</option>
              {slot.brand && !brands.includes(slot.brand) ? <option value={slot.brand}>{slot.brand}</option> : null}
              {brands.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Field htmlFor="slot-type" label="Material">
            <Select id="slot-type" value={slot.type} onChange={(e) => setSlot(slot.index, { type: e.target.value, family: '', vendor: '' })}>
              {(types.includes(slot.type) ? types : [slot.type, ...types]).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          {slot.brand ? (
            <Field htmlFor="slot-family" label="Product" hint={products.length === 0 ? `${slot.brand} has no ${slot.type} presets.` : undefined}>
              <Select
                id="slot-family"
                value={slot.family ? `${slot.vendor}|${slot.family}` : ''}
                onChange={(e) => {
                  const [vendor = '', ...rest] = e.target.value.split('|')
                  setSlot(slot.index, { vendor, family: rest.join('|') })
                }}
              >
                <option value="">Not chosen</option>
                {products.map((p) => (
                  <option key={`${p.vendor}|${p.family}`} value={`${p.vendor}|${p.family}`}>
                    {p.family}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field htmlFor="slot-color" label="Color" aside={<span className="sx-mono">{slot.color}</span>}>
            <div className="slot-color">
              <input id="slot-color" type="color" className="color-input" value={slot.color} onChange={(e) => setSlot(slot.index, { color: normalizeColor(e.target.value, slot.color) })} />
              <Input id="slot-hex" aria-label="Color as hex" maxLength={7} value={slot.color} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && setSlot(slot.index, { color: e.target.value.toLowerCase() })} />
            </div>
          </Field>
          {slot.source === 'printer' ? <p className="sx-muted sx-small">Filled in from the printer. Change anything here to keep your values instead.</p> : null}
        </div>
      ) : null}
    </Dialog>
  )
}

export function FlushDialog() {
  const open = useApp((s) => s.flushOpen)
  const flush = useApp((s) => s.flush)
  const slots = useResolvedSlots()
  const top = slots.reduce((n, r) => (r.used ? Math.max(n, r.index) : n), 0)
  const list = slots.slice(0, Math.max(2, top))
  const colorKey = list.map((r) => r.color).join()
  const count = Math.max(2, top)
  // Strings keep the selector's result stable between renders.
  const planKey = useApp((s) => {
    const p = flushPlan(s, count)
    return p.nozzles.map((z) => `${z.dataset}|${z.mins.join(',')}`).join(';')
  })
  // A dual nozzle printer has one matrix per nozzle, each from that nozzle's own data set.
  const nozzleKeys = planKey.split(';')
  const [nozzle, setNozzle] = useState(0)
  const shown = Math.min(nozzle, nozzleKeys.length - 1)
  const matrix = useMemo(() => {
    const [dataset, mins] = (nozzleKeys[shown] ?? '0|').split('|')
    return flushMatrix(colorKey ? colorKey.split(',') : [], FLUSH_DEFAULTS, (mins ?? '').split(',').map(Number), Number(dataset))
  }, [colorKey, planKey, shown])
  const close = () => set({ flushOpen: false })
  const hasManual = Object.keys(flush.manual).length > 0
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      className="flush-dialog"
      title="Flush volumes"
      splitFooter
      footer={
        <>
          <Button variant="ghost" disabled={!hasManual && flush.multiplier === 1} onClick={() => setFlush({ manual: {}, multiplier: 1 })}>
            Back to auto
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <p className="sx-muted sx-small">Filament pushed through the nozzle (mm3) when the print changes from the color in the row to the color in the column. Auto values come from how different the two colors are, most for dark to light.</p>
      {nozzleKeys.length > 1 && (
        <Seg<string>
          label="Nozzle"
          size="sm"
          value={String(shown)}
          onChange={(v) => setNozzle(Number(v))}
          options={nozzleKeys.map((_, i) => ({ value: String(i), label: i === 0 ? 'Left nozzle' : i === 1 ? 'Right nozzle' : `Nozzle ${i + 1}` }))}
        />
      )}
      <div className="flush-scroll">
        <table className="flush-table">
          <caption className="sr-only">Flush volume in mm3, from row to column</caption>
          <thead>
            <tr>
              <th scope="col">From \ to</th>
              {list.map((c) => (
                <th key={c.index} scope="col" {...tipAttrs({ title: `Filament ${c.index}` })}>
                  <Swatch color={c.color} size="sm" /> {c.index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((from, i) => (
              <tr key={from.index}>
                <th scope="row">
                  <Swatch color={from.color} size="sm" /> {from.index}
                </th>
                {list.map((to, j) => {
                  if (i === j) return <td key={to.index} className="flush-self">0</td>
                  const key = pairKey(from.index, to.index)
                  const typed = flush.manual[key]
                  return (
                    <td key={to.index}>
                      <input
                        className={typed !== undefined ? 'flush-cell typed' : 'flush-cell'}
                        type="number"
                        min={0}
                        max={FLUSH_LIMIT}
                        inputMode="numeric"
                        aria-label={`From filament ${from.index} to ${to.index}, mm3`}
                        value={typed ?? matrix[i]![j]!}
                        onChange={(e) => setFlushManual(key, e.target.value === '' ? undefined : clampFlush(Number(e.target.value)))}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field htmlFor="flush-mult" label="Flush multiplier" aside={<span className="sx-mono">{flush.multiplier.toFixed(2)}</span>} hint="Scales every value. Raise it if the new color still shows the old one.">
        <Range id="flush-mult" min={0.5} max={3} step={0.05} value={flush.multiplier} onChange={(v) => setFlush({ multiplier: v })} />
      </Field>
    </Dialog>
  )
}

/** The Spoolman spools as rows with their color, narrowed by vendor and by a few typed words. Picking one fills in the slot. */
function SpoolPicker({ spools, linked, onPick }: { spools: Spool[]; linked: number | undefined; onPick: (id: number | undefined) => void }) {
  const [vendor, setVendor] = useState('')
  const [query, setQuery] = useState('')
  const vendors = useMemo(() => spoolVendors(spools), [spools])
  const shown = filterSpools(spools, vendor, query)
  return (
    <Field htmlFor="slot-spool-search" label="Spool" hint="From your Spoolman inventory. Picking one fills in the material and color.">
      <div className="spool-pick">
        <div className="spool-filter">
          {vendors.length > 1 ? (
            <Select id="slot-spool-vendor" aria-label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          ) : null}
          <Input id="slot-spool-search" type="search" placeholder="Search spools" aria-label="Search spools" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ul className="spool-list" role="listbox" aria-label="Spools">
          <li role="option" aria-selected={linked === undefined}>
            <button type="button" className={linked === undefined ? 'spool-row sel' : 'spool-row'} onClick={() => onPick(undefined)}>
              Not linked
            </button>
          </li>
          {shown.map((sp) => (
            <li key={sp.id} role="option" aria-selected={linked === sp.id}>
              <button type="button" className={linked === sp.id ? 'spool-row sel' : 'spool-row'} onClick={() => onPick(sp.id)}>
                <Swatch color={sp.color} size="sm" />
                <span className="n">{spoolLabel(sp)}</span>
                <span className="sx-small sx-muted">
                  {sp.material}, {Math.round(sp.remainingG)} g left
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 ? <li className="sx-small sx-muted">No spool matches.</li> : null}
        </ul>
      </div>
    </Field>
  )
}
