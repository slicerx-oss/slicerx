// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the printer, filament and process layer under the Easy choices in step with the selected printer, the
// quality tier and the filaments in use. The layer builds from the shipped presets (adapters/profile.ts), loads with
// the settings on first use, and slicing waits for the build that is under way.
import type { EasyGoal, EasySettings } from '@slicerx/contracts'
import { setProfileLayer } from '../adapters/config'
import { excludeBoxes, setAvoidAreas } from '../plate/arrange'
import { installPrintMargins } from '../plate/footprint'
import { loadSettings } from '../adapters/load'
import { resolveSlots } from '../filament/slots'
import { withoutDirtying } from '../project/unsaved'
import { appStore, get, set, markStale, type AppState } from './store'
import { GENERIC_BED } from '../adapters/generic-bed'
import { areaOrigin } from '../plate/bed-origin'

const CONTROLS = ['detail', 'strength', 'speed', 'supports', 'brim', 'varyLayerHeight'] as const

/** The Easy controls whose value differs between two settings. */
export function changedControls(a: EasySettings, b: EasySettings): string[] {
  return CONTROLS.filter((c) => (a[c] ?? (c === 'varyLayerHeight' ? false : undefined)) !== (b[c] ?? (c === 'varyLayerHeight' ? false : undefined)))
}

const TIERS: readonly EasyGoal[] = ['draft', 'standard', 'fine', 'strong']
let lastTier: EasyGoal = 'standard'
let key = ''
let building: Promise<void> = Promise.resolve()

function tierOf(s: Pick<AppState, 'goal'>): EasyGoal {
  if ((TIERS as readonly string[]).includes(s.goal)) lastTier = s.goal as EasyGoal
  return lastTier
}

function slotsOf(s: AppState): { type: string; vendor?: string; family?: string }[] {
  const slots = resolveSlots(s)
  const top = slots.reduce((n, r) => (r.used ? Math.max(n, r.index) : n), 0)
  const list = top >= 2 ? slots.slice(0, top) : [slots.find((r) => r.used) ?? slots[0]]
  return list.filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => ({ type: r.type, ...(r.vendor ? { vendor: r.vendor } : {}), ...(r.family ? { family: r.family } : {}) }))
}

/** No printer layer: the plate goes back to the generic bed the configuration slices for. */
function dropLayer(): void {
  setProfileLayer(null, [])
  setAvoidAreas([])
  const { bed, profile } = get()
  const generic = bed.widthMm === GENERIC_BED.widthMm && bed.depthMm === GENERIC_BED.depthMm && bed.heightMm === GENERIC_BED.heightMm
  if (profile || !generic) withoutDirtying(() => set({ profile: null, ...(generic ? {} : { bed: { ...GENERIC_BED } }), overrides: { ...get().overrides } }))
}

async function rebuild(): Promise<void> {
  const s = get()
  const model = s.printerModel
  if (!model) {
    dropLayer()
    return
  }
  await loadSettings()
  const { buildProfileLayer } = await import('../adapters/profile')
  const reported = model.id ? s.nozzleReported[model.id] : undefined
  const chosen = model.id ? s.printerNozzles[model.id] : undefined
  const extruders = model.id ? s.printerExtruders[model.id] : undefined
  const layer = await buildProfileLayer({ printer: model, tier: tierOf(s), slots: slotsOf(s), ...(reported ? { nozzle: reported, nozzleFrom: 'printer' as const } : chosen ? { nozzle: chosen, nozzleFrom: 'choice' as const } : {}), ...(extruders && !reported ? { extruders } : {}) })
  if (!layer) {
    dropLayer()
    return
  }
  setProfileLayer(layer.values, get().easyTouched)
  // The no-print areas are machine coordinates; arranging works on the plate.
  const [ox, oy] = areaOrigin(layer.values['printable_area'])
  setAvoidAreas(excludeBoxes(layer.values['bed_exclude_area']).map((r) => ({ ...r, x: r.x - ox, y: r.y - oy })))
  const bed = get().bed
  const same = bed.widthMm === layer.bed.widthMm && bed.depthMm === layer.bed.depthMm && bed.heightMm === layer.bed.heightMm
  // A new overrides object makes every panel that reads the resolved configuration read it again. Following the
  // printer is not an edit of the project, so a plate that was clean stays clean.
  withoutDirtying(() =>
    set({ profile: { printerId: layer.printerId, nozzle: layer.nozzle, nozzles: layer.nozzles, nozzleFrom: layer.nozzleFrom, tier: layer.tier, source: layer.source, shippedGcode: layer.shippedGcode, gcodeKeys: layer.gcodeKeys, limits: layer.limits, filamentIds: layer.filamentIds, goalValues: layer.goalValues }, ...(same ? {} : { bed: layer.bed }), overrides: { ...get().overrides } }),
  )
  markStale()
}

function schedule(): void {
  building = building.then(rebuild).catch(() => undefined)
}

/** Sets the nozzle size for a printer. A printer that reports its own size overrides it until it stops reporting. */
export function setPrinterNozzle(printerId: string, mm: number): void {
  set((s) => ({ printerNozzles: { ...s.printerNozzles, [printerId]: mm } }))
}

/** Resolves when the layer matches the current printer, tier and filaments. Slicing awaits it. */
export async function profileReady(): Promise<void> {
  const s = get()
  const nz = s.printerModel?.id ? `${s.nozzleReported[s.printerModel.id] ?? ''}/${s.printerNozzles[s.printerModel.id] ?? ''}/${JSON.stringify(s.printerExtruders[s.printerModel.id] ?? [])}` : ''
  const next = `${s.printerModel ? `${s.printerModel.id ?? ''}|${s.printerModel.vendor}|${s.printerModel.model}` : ''}|${nz}|${tierOf(s)}|${JSON.stringify(slotsOf(s))}`
  if (next !== key) {
    key = next
    schedule()
  }
  await building
}

/** For tests: forgets the inputs the layer was last built for, so the next `profileReady` builds it again. */
export function resetProfileReady(): void {
  key = ''
}

let started = false

/** Follows the store: tracks which Easy controls were moved, and rebuilds the layer when its inputs change. */
export function startProfileSync(): void {
  if (started) return
  started = true
  installPrintMargins(get)
  appStore.subscribe((s, prev) => {
    if (s.easy !== prev.easy || s.goal !== prev.goal) {
      let touched = s.easyTouched
      // A change that says which controls it moved (the Easy panel) is taken as it is. Otherwise picking a quality
      // tier starts over from that tier's preset, and any other change marks the controls it moved.
      if (s.easyTouched !== prev.easyTouched) touched = s.easyTouched
      else if (s.goal !== 'custom' && s.goal !== prev.goal) touched = []
      else if (s.easy !== prev.easy) touched = [...new Set([...touched, ...changedControls(prev.easy, s.easy)])]
      if (touched.length !== s.easyTouched.length || touched.some((t, i) => t !== s.easyTouched[i])) {
        set({ easyTouched: touched })
        // The Easy part of the resolved configuration changed with it.
        schedule()
        return
      }
    }
    // The layer applies only the moved controls, so it follows every change to that list.
    if (s.easyTouched !== prev.easyTouched) {
      schedule()
      return
    }
    if (s.printerModel !== prev.printerModel || s.printerNozzles !== prev.printerNozzles || s.printerExtruders !== prev.printerExtruders || s.nozzleReported !== prev.nozzleReported || s.goal !== prev.goal || s.slotSetup !== prev.slotSetup || s.printerSlots !== prev.printerSlots || s.plate !== prev.plate || s.plates !== prev.plates) void profileReady()
  })
  void profileReady()
}
