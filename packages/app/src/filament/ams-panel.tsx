// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament block of the Prepare sidebar: every slot with its material, brand and color, filled in
// from the connected printer's AMS or MMU until the person changes it, plus the flush volume dialog
// and per-plate color swaps.
import { Block, Button, Icon, LinkButton, Menu, MenuAnchor, MenuItem, Popover, Select, SwitchRow, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Swatch } from '../parts'
import { activeMeta } from '../plate/plates'
import { useHost } from '../host'
import { spoolFor, useSpools } from '../inventory/spools'
import { effectiveMode, useLayout } from '../first-run/look'
import { estimateLine } from '../lib/estimate-line'
import { SlotRail, SlotRailEmpty, SlotRailSkeleton } from './slot-rail'
import { slotLabel } from './rail'
import { useFold } from '../shell/fold'
import { set, shownSlice, useApp } from '../state/store'
import { nozzleText, tuneState } from '../calibration/tuned'
import { useResolvedSlots } from './use-slots'
import { SetupNotes } from './setup-plan'
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
              {slotLabel(s)}
            </option>
          ))}
        </Select>
        <Icon name="color-change" size={14} />
        <Select id="swap-b" size="sm" aria-label="Second filament" value={to} onChange={(e) => setB(Number(e.target.value))}>
          {onPlate.map((s) => (
            <option key={s.index} value={s.index}>
              {slotLabel(s)}
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
  const mode = effectiveMode(useApp((s) => s.settingsMode), useLayout())
  const advanced = mode !== 'simple'
  const [open, setOpen] = useFold('filament')
  const host = useHost()
  const spools = useSpools(host)
  const links = useApp((s) => s.spoolLinks)
  const done = shownSlice(useApp((s) => s.slice))
  const line = estimateLine(done)
  /** What is left on the slot's spool: grams from Spoolman, else the printer's percentage. */
  const left = (s: ResolvedSlot): string | null => {
    const sp = spoolFor(s.index, spools, links, printerSlots[s.index - 1]?.spoolmanId)
    return sp ? `${Math.round(sp.remainingG)} g left` : s.remainingPct !== undefined ? `${s.remainingPct}% left` : null
  }
  const showUnused = useApp((s) => s.showUnusedSlots)
  const [menuOpen, setMenuOpen] = useState(false)
  // Swap colors opens from the menu, so the rail keeps its one row.
  const [swapOpen, setSwapOpen] = useState(false)
  // The rail shows the slots in use; "Show unused slots" in the menu adds the rest. Nothing in use yet: every slot.
  const shown = showUnused || used === 0 ? slots : slots.filter((s) => s.used)
  // The printer has a filament unit but has not reported its slots yet.
  const loading = (system === 'ams' || system === 'mmu') && !fromPrinter && !edited
  // After a slice: "148 g, 4 changes" (changes only on a multi-color plate).
  const total = line ? [line.grams, line.changes].filter(Boolean).join(', ') : null
  const menu = (
    <MenuAnchor className="fil-menu">
      <Button size="sm" variant="ghost" icon="more" aria-label="Filament options" aria-haspopup="menu" aria-expanded={menuOpen} data-testid="slice-filament-menu" tip={{ title: 'Filament options', body: 'Calibrate, flush volumes, swap colors, reset to the printer, unused slots.' }} onClick={() => setMenuOpen(!menuOpen)} />
      <Menu open={menuOpen} onClose={() => setMenuOpen(false)} label="Filament options" align="end">
        <MenuItem icon="calibration" data-testid="slice-filament-calibrate" onClick={() => set({ calibrationOpen: true, calibrationSlot: null })}>
          Calibrate
        </MenuItem>
        {used >= 2 ? (
          <MenuItem icon="flush-volume" data-testid="slice-filament-flush" onClick={() => set({ flushOpen: true })}>
            Flush volumes
          </MenuItem>
        ) : null}
        {fromPrinter && edited ? (
          <MenuItem icon="settings-reset" data-testid="slice-filament-reset" onClick={() => resetSlots()}>
            Reset to printer
          </MenuItem>
        ) : null}
        {used >= 2 ? (
          <MenuItem icon="color-change" data-testid="slice-filament-swap" onClick={() => {
            setMenuOpen(false)
            setSwapOpen(true)
          }}>
            Swap colors
          </MenuItem>
        ) : null}
        <MenuItem checked={showUnused} onClick={() => set({ showUnusedSlots: !showUnused })}>
          Show unused slots
        </MenuItem>
      </Menu>
      <Popover open={swapOpen} onClose={() => setSwapOpen(false)} label="Swap colors" align="end" className="fil-swap-pop">
        <SwapColors slots={slots} />
      </Popover>
    </MenuAnchor>
  )
  return (
    <Block
      title="Filament"
      icon="spool"
      id="filament-fold"
      {...(setOpen ? { expanded: open, onExpandedChange: setOpen } : {})}
      aside={
        !open ? (
          <span className="sec-sum">
            {slots.filter((s) => s.used).slice(0, 6).map((s) => (
              <Swatch key={s.index} color={s.color} size="sm" />
            ))}
            {`${used} of ${slots.length} used`}
          </span>
        ) : (
          <span className="fil-head">
            {total ? <span className="fil-total" data-testid="slice-filament-total">{total}</span> : null}
            {menu}
          </span>
        )
      }
      data-section="filament"
    >
      {loading ? <SlotRailSkeleton /> : slots.length === 0 ? <SlotRailEmpty /> : <SlotRail slots={shown} left={left} badge={tuneBadge} {...(advanced && !fromPrinter && slots.length < MAX_SLOTS ? { onAdd: () => setSlot(slots.length + 1, {}) } : {})} />}
      <NozzleRows slots={slots} />
      <SetupNotes />
      <Suspense fallback={null}>{dialogOpen ? <Dialogs /> : null}</Suspense>
    </Block>
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

