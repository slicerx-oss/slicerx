// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament block of the Prepare sidebar: every slot with its material, brand and color, filled in
// from the connected printer's AMS or MMU until the person changes it, plus the flush volume dialog
// and per-plate color swaps.
import { Block, Button, Icon, Input, LinkButton, Select, SwitchRow, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Swatch } from '../parts'
import { activeMeta } from '../plate/plates'
import { useHost } from '../host'
import { spoolFor, useSpools } from '../inventory/spools'
import { MoreButton, useMore } from '../shell/more'
import { set, useApp } from '../state/store'
import { nozzleText, tuneState } from '../calibration/tuned'
import { useResolvedSlots } from './use-slots'
import { SetupNotes } from './setup-plan'
import { OPTION_TIPS } from '../lib/tips'
import { moveTower, setTowerAuto, towerNote } from '../plate/tower'
import { MAX_SLOTS, resetSlots, setSlot, swapPlateSlots, type ResolvedSlot } from './slots'
import { resolveConfig } from '../adapters/config'
import { currentMap, hasRack, mapExtruders, masterExtruder, nozzleName, pickedMap, setNozzleAuto, setSlotNozzle } from './nozzle-map'

const Dialogs = lazy(() => import('./dialogs').then((m) => ({ default: () => (
  <>
    <m.SlotDialog />
    <m.FlushDialog />
  </>
) })))

/** Looks the printer's material names up in the filament presets, once the preset index has loaded. */
function usePresetMatch(maker: string): void {
  const printerSlots = useApp((s) => s.printerSlots)
  const key = printerSlots.map((p) => p.material ?? '').join('|')
  useEffect(() => {
    if (!key.replace(/\|/g, '')) return void set({ slotMatch: {} })
    let stale = false
    void import('./presets').then(({ matchProduct }) => {
      if (stale) return
      const next: Record<number, { brand: string; family: string; vendor: string }> = {}
      printerSlots.forEach((p, i) => {
        const hit = p.material ? matchProduct(p.material, maker) : undefined
        if (hit) next[i + 1] = { brand: hit.brand, family: hit.family, vendor: hit.vendor }
      })
      set({ slotMatch: next })
    })
    return () => {
      stale = true
    }
  }, [key, maker, printerSlots])
}

function unitOf(s: ResolvedSlot): string {
  return /^[A-Z]/.test(s.label) ? `AMS ${s.label.charCodeAt(0) - 64}` : 'Spools'
}

function SwapColors({ slots }: { slots: ResolvedSlot[] }) {
  const meta = useApp((s) => activeMeta(s))
  const onPlate = slots.filter((s) => s.used)
  const [a, setA] = useState(0)
  const [b, setB] = useState(0)
  const map = meta?.settings.slotMap
  if (!meta || onPlate.length < 2) return null
  const from = a || onPlate[0]!.index
  const to = b || onPlate.find((s) => s.index !== from)!.index
  return (
    <div className="swap-colors" role="group" aria-label="Swap colors on this plate">
      <span className="sx-small sx-muted">Swap colors on {meta.name}</span>
      <div className="swap-row">
        <Select id="swap-a" size="sm" aria-label="First filament" value={from} onChange={(e) => setA(Number(e.target.value))}>
          {onPlate.map((s) => (
            <option key={s.index} value={s.index}>
              Filament {s.index}
            </option>
          ))}
        </Select>
        <Icon name="color-change" size={14} />
        <Select id="swap-b" size="sm" aria-label="Second filament" value={to} onChange={(e) => setB(Number(e.target.value))}>
          {onPlate.map((s) => (
            <option key={s.index} value={s.index}>
              Filament {s.index}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={from === to} onClick={() => swapPlateSlots(meta.id, from, to)}>
          Swap
        </Button>
      </div>
      {map ? (
        <p className="sx-small swap-state">
          {Object.entries(map).map(([k, v]) => `${k} prints as ${v}`).join(', ')}.{' '}
          <LinkButton onClick={() => set((s) => ({ plates: s.plates.map((p) => (p.id === meta.id ? { ...p, settings: (({ slotMap: _m, ...rest }) => rest)(p.settings) } : p)) }))}>Undo swaps</LinkButton>
        </p>
      ) : null}
    </div>
  )
}

export function AmsPanel({ maker, system }: { maker: string; system?: 'ams' | 'mmu' | 'toolchanger' | undefined }) {
  const printerSlots = useApp((s) => s.printerSlots)
  const slotSetup = useApp((s) => s.slotSetup)
  const dialogOpen = useApp((s) => s.slotDialog !== null || s.flushOpen)
  const slots = useResolvedSlots()
  const presets = useApp((s) => s.userPresets)
  const profile = useApp((s) => s.profile)
  /** "Tuned" once calibration results exist for this spool, printer and nozzle; a retune hint when only another nozzle has them. */
  const tuneBadge = (s: ResolvedSlot) => {
    const t = tuneState(presets, s, profile?.printerId ?? '', profile?.nozzle ?? 0.4)
    const open = () => set({ calibrationOpen: true, calibrationSlot: s.index })
    if (t.state === 'tuned') return <span className="tuned-badge" {...tipAttrs({ title: 'Tuned', body: t.results.map((r) => `${r.label}: ${r.value}`).join(', ') })}>Tuned</span>
    if (t.state === 'retune') return <button type="button" className="tuned-badge retune" onClick={open} {...tipAttrs({ title: 'Retune', body: `Calibrated on a ${nozzleText(t.fromNozzleMm)} nozzle. Retune for ${nozzleText(profile?.nozzle ?? 0.4)}.` })}>Retune</button>
    // A spool in use that was never tuned here offers the tests the plan says it needs.
    if (s.used) return <button type="button" className="tuned-badge need" onClick={open} {...tipAttrs({ title: 'Tune this filament', body: 'Prints only the tests this spool needs on this printer and nozzle.' })}>Tune</button>
    return null
  }
  usePresetMatch(maker)
  const used = slots.filter((s) => s.used).length
  const fromPrinter = printerSlots.length > 0
  const edited = Object.keys(slotSetup).length > 0
  const more = useMore('filament')
  const host = useHost()
  const spools = useSpools(host)
  const links = useApp((s) => s.spoolLinks)
  /** What is left on the slot's spool: grams from Spoolman, else the printer's percentage. */
  const left = (s: ResolvedSlot): string | null => {
    const sp = spoolFor(s.index, spools, links, printerSlots[s.index - 1]?.spoolmanId)
    return sp ? `${Math.round(sp.remainingG)} g left` : s.remainingPct !== undefined ? `${s.remainingPct}% left` : null
  }
  const [showUnused, setShowUnused] = useState(false)
  // Simple shows the slots in use, one line each; the rest open with More or with the unused-slots row.
  const basics = slots.filter((s) => s.used)
  const unusedCount = slots.length - Math.max(basics.length, 1)
  const shown = more || showUnused ? slots : basics.length ? basics : slots.slice(0, 1)
  // One or two filaments in use read as a single line of swatches; More or the unused-slots row opens the list.
  const strip = !more && !showUnused && basics.length > 0 && basics.length <= 2
  const groups = new Map<string, ResolvedSlot[]>()
  for (const s of shown) {
    const unit = fromPrinter && s.index <= printerSlots.length ? unitOf(s) : 'Slots'
    groups.set(unit, [...(groups.get(unit) ?? []), s])
  }
  return (
    <>
    <Block
      title="Filament"
      aside={
        <span className="fil-aside">
          <span className="fil-count sx-mono">{`${used} of ${slots.length} used`}</span>
          {more ? (
            <Button size="sm" variant="ghost" icon="calibration" aria-label="Calibrate" tip={{ title: 'Calibrate', body: 'Run flow, pressure advance and temperature tests for these filaments.' }} onClick={() => set({ calibrationOpen: true, calibrationSlot: null })} />
          ) : null}
          {more && used >= 2 ? (
            <Button size="sm" variant="ghost" icon="flush-volume" aria-label="Flush volumes" tip={{ title: 'Flush volumes', body: 'Set how much filament each color change purges.' }} onClick={() => set({ flushOpen: true })} />
          ) : null}
          <MoreButton id="filament" changed={edited} />
        </span>
      }
      data-section="filament"
    >
      {more && fromPrinter ? (
        <p className="sx-small sx-muted fil-sync">
          {system === 'mmu' ? 'MMU' : 'AMS'} values come from the printer.{' '}
          {edited ? <LinkButton onClick={() => resetSlots()}>Reset to printer</LinkButton> : null}
        </p>
      ) : more ? (
        <p className="sx-small sx-muted fil-sync">No printer reports slots. Set the filaments yourself.</p>
      ) : null}
      {strip ? (
        <div className="slot-strip">
          {basics.map((s) => (
            <div key={s.index} className="slot strip-slot" data-slot={s.index}>
              <button type="button" className="slot-swatch" aria-label={`Edit filament ${s.index}`} {...tipAttrs({ title: `Filament ${s.label}`, body: `${s.type}${left(s) ? `, ${left(s)}` : ''}. Click to change it.` })} onClick={() => set({ slotDialog: s.index })}>
                <Swatch color={s.color} />
              </button>
              <span className="sname">{s.type}</span>
              {tuneBadge(s)}
            </div>
          ))}
        </div>
      ) : null}
      {strip ? null : [...groups].map(([unit, list]) => (
        <div key={unit}>
          {more || groups.size > 1 ? <div className="ams-h">
            <span>{unit}</span>
            <span>
              {list[0]?.label} to {list[list.length - 1]?.label}
            </span>
          </div> : null}
          {list.map((s) => (
            <div key={s.index} className={s.used ? 'slot' : 'slot unused'} data-slot={s.index}>
              <button type="button" className="slot-swatch" aria-label={`Edit filament ${s.index}`} onClick={() => set({ slotDialog: s.index })}>
                <Swatch color={s.color} />
              </button>
              <span className="sid">{s.label}</span>
              <span className="sname">
                {s.type}
                {s.brand ? ` · ${s.brand}` : ''} {tuneBadge(s)}
                <small>
                  {(more ? [s.family && s.family !== s.brand ? s.family : null, s.used ? 'In use' : 'Not used', left(s)] : [left(s)]).filter(Boolean).join(', ')}
                </small>
              </span>
            </div>
          ))}
        </div>
      ))}
      {!more && !showUnused && unusedCount > 0 ? (
        <button type="button" className="fil-unused" aria-expanded={false} onClick={() => setShowUnused(true)}>
          <Icon name="chevron-right" size={12} />
          {unusedCount === 1 ? '1 unused slot' : `${unusedCount} unused slots`}
        </button>
      ) : null}
      {more && !fromPrinter && slots.length < MAX_SLOTS ? (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setSlot(slots.length + 1, {})}>
          Add filament
        </Button>
      ) : null}
      <NozzleRows slots={slots} />
      <SetupNotes />
      <Suspense fallback={null}>{dialogOpen ? <Dialogs /> : null}</Suspense>
    </Block>
    {more && used >= 2 ? (
      <section className="sx-block" data-section="color-tools" aria-label="Color changes">
        <SwapColors slots={slots} />
        <TowerRow />
      </section>
    ) : null}
    </>
  )
}

/**
 * On a printer with two extruders fed by their own AMS (H2D, H2C): which nozzle prints each filament in use. The
 * slicer picks it unless the plate sets it; picking a nozzle for one filament sets the plate's map by hand.
 */
export function NozzleRows({ slots }: { slots: ResolvedSlot[] }) {
  const meta = useApp((s) => activeMeta(s))
  const picked = useApp((s) => pickedMap(s))
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const cfg = useMemo(() => resolveConfig(easy, overrides) as Record<string, unknown>, [easy, overrides])
  if (!meta || mapExtruders(cfg) !== 2) return null
  const shown = slots.filter((s) => s.used)
  if (shown.length === 0) return null
  const rack = hasRack(cfg)
  const current = currentMap(meta, picked, slots.length, masterExtruder(cfg))
  const auto = !meta.settings.nozzleMap
  return (
    <div className="nozzle-map" role="group" aria-label="Nozzle for each filament">
      <SwitchRow
        id="nozzle-auto"
        icon="nozzle"
        label="Pick nozzles automatically"
        detail={auto ? 'Each filament goes where it flushes least, so a nozzle switch needs only a short prime.' : 'Set by hand for this plate.'}
        checked={auto}
        onChange={(on) => (on ? setNozzleAuto(meta.id) : setSlotNozzle(meta.id, 1, current[0] ?? 1, current))}
      />
      {shown.map((s) => (
        <div key={s.index} className="nozzle-row" data-slot={s.index}>
          <Swatch color={s.color} />
          <span className="sname">Filament {s.label}</span>
          <Select
            id={`nozzle-${s.index}`}
            size="sm"
            aria-label={`Nozzle for filament ${s.index}`}
            value={current[s.index - 1] ?? 1}
            onChange={(e) => setSlotNozzle(meta.id, s.index, Number(e.target.value), current)}
          >
            <option value={1}>{nozzleName(1, rack)}</option>
            <option value={2}>{nozzleName(2, rack)}</option>
          </Select>
        </div>
      ))}
      {auto && !picked ? <p className="sx-small sx-muted">Slice the plate to see where each filament goes.</p> : null}
    </div>
  )
}

const ATLAS_TIP = OPTION_TIPS['prime_tower.atlas']!

/** The prime tower's place: automatic by default, or typed (dragging it in the 3D view does the same). */
function TowerRow() {
  const tower = useApp((s) => s.tower)
  const reported = useApp((s) => (s.slice.status === 'done' ? s.slice.result.primeTower : undefined))
  const note = towerNote(reported, tower.auto)
  return (
    <div className="tower-row">
      <div data-tip-title={ATLAS_TIP.title} data-tip-body={ATLAS_TIP.body}>
        <SwitchRow
          id="tower-auto"
          icon="atlas"
          label="atlas prime tower"
          detail={tower.auto ? 'Automatic: clear of the objects and the printer\'s no-go zones' : 'Set by hand. Drag the tower in the view or type a spot.'}
          checked={tower.auto}
          onChange={setTowerAuto}
        />
      </div>
      {tower.auto ? null : (
        <div className="tower-xy">
          <label>
            X (mm)
            <Input id="tower-x" type="number" value={tower.x} onChange={(e) => moveTower(Number(e.currentTarget.value), tower.y)} />
          </label>
          <label>
            Y (mm)
            <Input id="tower-y" type="number" value={tower.y} onChange={(e) => moveTower(tower.x, Number(e.currentTarget.value))} />
          </label>
        </div>
      )}
      {note ? (
        <p className="sx-small sx-muted seg-mark mark-atlas" role="status" data-tip-title={ATLAS_TIP.title} data-tip-body={ATLAS_TIP.body}>
          <Icon name="atlas" size={14} />
          {note}
        </p>
      ) : null}
    </div>
  )
}
