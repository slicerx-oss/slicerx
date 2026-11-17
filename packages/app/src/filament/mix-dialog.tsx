// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mixed filament editor: two loaded filaments and how many layers of each a cycle prints, with the color the mix
// should read as (approximate) and what it costs in tool changes and flush on this plate. Saving puts the mix in the
// project as a filament of its own, which the spools, the part menus and the paint panel offer like a loaded one.
import { Button, Dialog, Field, Input, Select, SwatchRing } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { MAX_MIX_RATIO, mixLayerComponent, type MixedFilament } from '@slicerx/settings/mixed'
import { get, set, useApp } from '../state/store'
import { addMix, mixEstimate, mixSwatch, removeMix, updateMix, type MixEstimate } from './mixes'
import { slotLabel } from './rail'
import { useResolvedSlots } from './use-slots'

/** "A A B" for the first cycle of a ratio, the letters naming the two filaments. */
export function cycleWords(ratio: readonly [number, number]): string {
  const n = ratio[0] + ratio[1]
  return Array.from({ length: n }, (_, i) => (mixLayerComponent({ ratio: [ratio[0], ratio[1]] }, i) === 0 ? 'A' : 'B')).join(' ')
}

/** The line under the swatch: what the mix adds on this plate, from the estimate. */
export function costWords(e: MixEstimate | null): string {
  if (!e || e.basis === 'none') return 'Add an object to the plate to see what this mix adds.'
  const what = e.basis === 'parts' ? 'the parts on it' : 'the tallest object, if it printed with this mix'
  if (e.changes === 0) return `No extra tool changes for ${what}.`
  return `About ${e.changes} tool ${e.changes === 1 ? 'change' : 'changes'} and ${e.grams} g of flush for ${what}.`
}

const clampRatio = (v: string): number => Math.max(1, Math.min(MAX_MIX_RATIO, Math.round(Number(v) || 1)))

export function MixDialog() {
  const which = useApp((s) => s.mixDialog)
  const mixes = useApp((s) => s.mixes)
  const slots = useResolvedSlots()
  const loaded = slots.length
  const current = typeof which === 'number' ? mixes.find((m) => m.id === which) : undefined
  const [a, setA] = useState(1)
  const [b, setB] = useState(2)
  const [ra, setRa] = useState('1')
  const [rb, setRb] = useState('1')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The editor starts from the mix it edits, or from the first two filaments.
  useEffect(() => {
    if (which === null) return
    setA(current?.components[0] ?? 1)
    setB(current?.components[1] ?? Math.min(2, Math.max(1, loaded)))
    setRa(String(current?.ratio[0] ?? 1))
    setRb(String(current?.ratio[1] ?? 1))
    setName(current?.name ?? '')
    setError(null)
  }, [which, current?.id])
  const ratio: [number, number] = [clampRatio(ra), clampRatio(rb)]
  const colors = slots.map((s) => s.color)
  const swatch = mixSwatch({ components: [a, b], ratio }, colors)
  const label = (n: number) => slots[n - 1]?.label ?? String(n)
  const draft: MixedFilament = { id: current?.id ?? 0, name: (name.trim() || `Mix of ${label(a)} and ${label(b)}`).slice(0, 40), components: [a, b], ratio }
  const [estimate, setEstimate] = useState<MixEstimate | null>(null)
  const key = `${a},${b},${ratio.join(':')},${current?.id ?? 0}`
  useEffect(() => {
    if (which === null || a === b) return void setEstimate(null)
    let live = true
    void mixEstimate(get(), { ...draft, id: current?.id ?? -1 }).then((e) => live && setEstimate(e))
    return () => {
      live = false
    }
  }, [which, key])
  const close = () => set({ mixDialog: null })
  const save = () => {
    const out = current ? updateMix(current.id, { name: draft.name, components: draft.components, ratio: draft.ratio }, loaded) : addMix({ name: draft.name, components: draft.components, ratio: draft.ratio }, loaded)
    if (typeof out === 'string') return setError(out)
    close()
  }
  const problem = a === b ? 'Pick two different filaments.' : null
  const options = useMemo(() => slots.map((s) => ({ value: s.index, label: `${s.label}: ${slotLabel(s)}` })), [slots])
  const pick = (id: string, label: string, value: number, onChange: (v: number) => void) => (
    <Field htmlFor={id} label={label}>
      <Select id={id} size="sm" value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={id}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  )
  return (
    <Dialog
      open={which !== null && loaded >= 2}
      onClose={close}
      className="mix-dialog"
      testId="mix-dialog"
      title={current ? `Mix ${current.name}` : 'New mix'}
      splitFooter={Boolean(current)}
      footer={
        <>
          {current ? (
            <Button variant="ghost" icon="delete" data-testid="danger-mix-delete" tip={{ title: 'Delete mix', body: 'Parts on it go back to its first filament.' }} onClick={() => {
              removeMix(current.id)
              close()
            }}>
              Delete mix
            </Button>
          ) : null}
          <span className="mix-dialog-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" data-testid="mix-save" disabled={problem !== null} onClick={save}>
              {current ? 'Save' : 'Add mix'}
            </Button>
          </span>
        </>
      }
    >
      <p className="sx-small sx-muted">Prints the two filaments on alternating layers in this ratio, so their colors blend from a distance. Assign the mix like any filament.</p>
      <div className="mix-pair">
        {pick('mix-a', 'Filament A', a, setA)}
        {pick('mix-b', 'Filament B', b, setB)}
      </div>
      <div className="mix-pair">
        <Field htmlFor="mix-ra" label="Layers of A">
          <Input id="mix-ra" size="sm" type="number" min={1} max={MAX_MIX_RATIO} step={1} inputMode="numeric" value={ra} onChange={(e) => setRa(e.target.value)} onBlur={() => setRa(String(clampRatio(ra)))} data-testid="mix-ra" />
        </Field>
        <Field htmlFor="mix-rb" label="Layers of B">
          <Input id="mix-rb" size="sm" type="number" min={1} max={MAX_MIX_RATIO} step={1} inputMode="numeric" value={rb} onChange={(e) => setRb(e.target.value)} onBlur={() => setRb(String(clampRatio(rb)))} data-testid="mix-rb" />
        </Field>
      </div>
      <div className="mix-name">
        <Field htmlFor="mix-name" label="Name">
          <Input id="mix-name" size="sm" maxLength={40} placeholder={draft.name} value={name} onChange={(e) => setName(e.target.value)} data-testid="mix-name" />
        </Field>
      </div>
      <div className="mix-preview" data-testid="mix-preview">
        <SwatchRing color={swatch.color} size={40} mix={{ a: swatch.a, b: swatch.b, ratio }} />
        <SwatchRing color={swatch.color} size={40} />
        <div className="mix-preview-text">
          <span className="mix-color">
            Approximate color <span className="mix-hex">{swatch.color}</span>
          </span>
          <span className="sx-small sx-muted">Layers print {cycleWords(ratio)}, repeating.</span>
        </div>
      </div>
      <p className="mix-cost sx-small" data-testid="mix-cost" data-many={estimate?.many ? 'true' : undefined} role={estimate?.many ? 'alert' : undefined}>
        {estimate?.many ? 'Many tool changes. ' : ''}
        {costWords(estimate)}
      </p>
      {error || problem ? (
        <p className="mix-error sx-small" role="alert" data-testid="mix-error">
          {error ?? problem}
        </p>
      ) : null}
    </Dialog>
  )
}
