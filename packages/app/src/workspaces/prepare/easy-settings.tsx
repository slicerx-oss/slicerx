// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Easy mode: five controls that write Orca keys through @slicerx/settings.
import type { EasyGoal, EasySettings, PrintConfig, SettingValue, SpeedPreset, SupportMode } from '@slicerx/contracts'
import { Chip, Icon, Menu, MenuAnchor, MenuItem, MenuSeparator, Range, Seg, SwitchRow, tipAttrs, type IconName } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { easyConfig, easyConfigFor, goalEasy, goalKeys, GOALS, inferEasy, matchGoal, resolveConfig } from '../../adapters/config'
import { goalEstimate, goalSubtitle } from '../../lib/estimate-line'
import { goalEdits, goalEditsTip } from '../../lib/goal-edits'
import { choicePatch, chosenFrom, FIXED_HEIGHTS, SLEIPNIR, SLEIPNIR_LINE, type LayerChoice } from '../../lib/layer-choice'
import { OPTION_TIPS, settingTipAttrs } from '../../lib/tips'
import { useMore } from '../../shell/more'
import { beginLiveEdit } from '../../state/live-edit'
import { get, markStale, set, shownSlice, useApp, type Goal } from '../../state/store'
import { layerHeightConflict } from '../../plate/object-settings'
import { plateSequence } from '../../plate/plate-sequence'
import { scopeValue, setScopedMany, type SettingsScope } from '../../plate/scope'
import { easyGroups } from '../../plate/easy-groups'
import { useScope, useSettingsObjects } from './scope-bar'
import { usePhoneLayout } from '../../lib/phone-layout'
import './goal-tiles.css'

const GOAL_OPTIONS = [
  { value: 'draft', label: 'Draft', icon: 'preset-draft', testId: 'slice-goal-draft' },
  { value: 'standard', label: 'Standard', icon: 'preset-standard', testId: 'slice-goal-standard' },
  { value: 'fine', label: 'Fine', icon: 'preset-fine', testId: 'slice-goal-fine' },
  { value: 'strong', label: 'Strong', icon: 'preset-strong', testId: 'slice-goal-strong' },
] as const satisfies readonly { value: EasyGoal; label: string; icon: IconName; testId: string }[]

const GOAL_PLATE = 'A goal is for the whole plate. Pick Plate above to change it.'

const SPEEDS: { value: SpeedPreset; label: string; pct: number }[] = [
  { value: 'quality', label: 'Quality', pct: 50 },
  { value: 'balanced', label: 'Balanced', pct: 100 },
  { value: 'fast', label: 'Fast', pct: 124 },
  { value: 'fastest', label: 'Fastest', pct: 166 },
]

const SUPPORTS = [
  { value: 'off', label: 'Off', tip: { title: 'Off', demo: 'supports-off' } },
  { value: 'auto', label: 'Auto', tip: { title: 'Auto', demo: 'supports-auto' } },
  { value: 'painted', label: 'Painted', tip: { title: 'Painted', demo: 'supports-painted' } },
] as const satisfies readonly { value: SupportMode; label: string; tip: { title: string; demo: string } }[]
const SUPPORTS_PHONE = SUPPORTS.filter((o) => o.value !== 'painted')

function update(patch: Partial<EasySettings>, goal?: EasyGoal): void {
  set((s) => {
    const easy = { ...s.easy, ...patch }
    // Clicking the control a preset already shows still counts as the person's choice; picking a tier starts over.
    const touched = goal ? [] : [...new Set([...s.easyTouched, ...Object.keys(patch)])]
    return { easy, goal: goal ?? matchGoal(easy) ?? 'custom', easyTouched: touched, ...(goal ? { goalBase: goal } : {}) }
  })
  markStale()
}

/** Picks a goal, or presses the edited one: its stock values, with the overrides of what a goal decides dropped. */
function pickGoal(goal: EasyGoal): void {
  const keys = new Set(goalKeys())
  const overrides = get().overrides
  if (Object.keys(overrides).some((k) => keys.has(k))) set({ overrides: Object.fromEntries(Object.entries(overrides).filter(([k]) => !keys.has(k))) })
  update(goalEasy(goal), goal)
}

const same = (a: SettingValue | undefined, b: SettingValue | undefined) => JSON.stringify(a) === JSON.stringify(b)

/**
 * An Easy choice made for the selection: each key the control decides takes the value the choice gives, as the
 * selection's own, or goes back to the plate's where the two agree.
 */
function updateScoped(scope: SettingsScope, easy: EasySettings, patch: Partial<EasySettings>, keys: readonly string[]): void {
  const plate = easyConfig(easy)
  const next = easyConfigFor({ ...easy, ...patch }, Object.keys(patch))
  setScopedMany(get(), scope, keys.map((k) => [k, same(next[k], plate[k]) ? undefined : next[k]] as const))
}


export function EasySettingsPanel() {
  const easy = useApp((s) => s.easy)
  const goal = useApp((s) => s.goal)
  const goalBase = useApp((s) => s.goalBase)
  // The picked tile: the goal, or while the settings differ from every goal, the one they started from, marked edited.
  const shownGoal: EasyGoal = goal === 'custom' ? goalBase : goal
  const touched = useApp((s) => s.easyTouched)
  const profile = useApp((s) => s.profile)
  const overrides = useApp((s) => s.overrides)
  // With a printer's presets under it, the readouts show the resolved configuration, not the Easy controls alone.
  const plateCfg = useMemo(() => easyConfig(easy), [easy, profile, overrides])
  // In the selection's scope the controls read the selection's own values over the plate's, and write them.
  const { scope } = useScope()
  const scoped = scope.kind !== 'plate'
  const plateEntries = useSettingsObjects()
  const objectSettings = useApp((s) => s.objectSettings)
  const keys = useMemo(() => easyGroups(easy), [easy, profile])
  const view = useMemo(() => {
    if (!scoped) return { cfg: plateCfg, mixed: new Set<string>(), own: new Set<string>() }
    const out: PrintConfig = { ...plateCfg }
    const mixed = new Set<string>()
    const own = new Set<string>()
    for (const k of new Set(Object.values(keys).flat())) {
      const sv = scopeValue({ plate: plateEntries, objectSettings }, plateCfg, k, scope)
      if (sv.source === 'mixed') mixed.add(k)
      else if (sv.value !== undefined) out[k] = sv.value
      if (sv.source === 'own') own.add(k)
    }
    return { cfg: out, mixed, own }
  }, [scoped, plateCfg, keys, plateEntries, objectSettings, scope])
  const cfg = view.cfg
  const mixedIn = (ks: readonly string[]) => ks.some((k) => view.mixed.has(k))
  const pick = (patch: Partial<EasySettings>, ks: readonly string[]) => (scoped ? updateScoped(scope, easy, patch, ks) : update(patch))
  const activeMeta = useApp((s) => s.plates.find((p) => p.id === s.activePlate))
  const conflict = useApp((s) => (scoped ? layerHeightConflict(s, plateSequence(activeMeta, plateCfg), Number(plateCfg.layer_height) || 0.2) : null))
  const inferred = useMemo(() => (profile ? inferEasy(cfg, easy) : null), [cfg, easy, profile])
  const strengthAt = scoped ? inferEasy(cfg, easy).strength : !inferred || touched.includes('strength') ? easy.strength : inferred.strength
  const speedIndex = Math.max(0, SPEEDS.findIndex((s) => s.value === easy.speed))
  const speed = SPEEDS[speedIndex]
  const layer = Number(cfg.layer_height).toFixed(2)
  const walls = Number(cfg.wall_loops)
  const infill = Number(cfg.sparse_infill_density)
  const angle = Number(cfg['support_threshold_angle'] ?? 25) || 25
  const vary = easy.varyLayerHeight ?? true
  const [pickerOpen, setPickerOpen] = useState(false)
  // The selection's own layer height is a fixed one: sleipnir plans the plate's layers. Until it has one, it prints
  // on the plate's layers, sleipnir's included.
  const layerOwn = scoped && keys.layer.some((k) => view.own.has(k))
  const sleipnirShown = vary && !layerOwn
  const chosen = chosenFrom(scoped ? false : vary, Number(cfg.layer_height))
  const layerMixed = scoped && mixedIn(keys.layer)
  const sleipnirTip = OPTION_TIPS['smart_layer.sleipnir']
  const choose = (c: LayerChoice) => {
    setPickerOpen(false)
    pick(choicePatch(c), keys.layer)
  }
  // On a multi-color plate, varying the layer height can add filament changes. The engine reports the cost of the last slice (negative when it saves).
  const cost = useApp((s) => (s.slice.status === 'done' && !s.slice.stale ? s.slice.result.varyLayerCost : undefined))
  const costNote = vary && cost && (cost.extraToolChanges > 0 || cost.extraPurgeG > 0) ? `Adds ${cost.extraToolChanges} filament changes and ${cost.extraPurgeG.toFixed(1)} g of purge.` : null
  // A control the person has not moved shows what the maker's preset does.
  const fromCfg: SupportMode = cfg['enable_support'] ? (String(cfg['support_type']) === 'tree(manual)' ? 'painted' : 'auto') : 'off'
  const supports: SupportMode = scoped ? fromCfg : !profile || touched.includes('supports') ? (easy.supports === 'everywhere' ? 'auto' : easy.supports) : fromCfg
  const brim: boolean = !scoped && (!profile || touched.includes('brim')) ? easy.brim : String(cfg['brim_type'] ?? 'no_brim') !== 'no_brim'
  // Simple shows Goal, Layer height and Supports, so the sidebar never scrolls; Advanced and up add the rest.
  const more = useMore('print')
  const phone = usePhoneLayout()
  // What each goal gives on this printer and nozzle: the printer's own tier presets, else SlicerX's goals.
  const goalValues = profile?.goalValues
  const subtitles = useMemo(() => Object.fromEntries(GOALS.map((g) => [g, goalSubtitle(g, goalValues?.[g] ?? easyConfig(goalEasy(g)))])) as Record<EasyGoal, string>, [goalValues, profile])
  // About how long and how much from the last slice: the picked tile's tooltip says it.
  const line = useApp((s) => goalEstimate(shownSlice(s.slice)))
  const edits = useMemo(() => (goal === 'custom' ? goalEdits(resolveConfig(easy, overrides), goalBase) : []), [goal, goalBase, easy, overrides, profile])
  const edited = edits.length > 0
  const baseName = GOAL_OPTIONS.find((o) => o.value === shownGoal)?.label ?? ''
  const editTip = edited ? goalEditsTip(edits, baseName) : null
  const tiles = useMemo(
    () =>
      GOAL_OPTIONS.map((o) => ({
        ...o,
        label: (
          <>
            <span className="goal-name">{o.label}</span>
            <span className="goal-sub sx-mono">{subtitles[o.value]}</span>
            {/* placed over the tile's corner, so marking it moves nothing */}
            {edited && o.value === shownGoal ? <span className="goal-edited-dot"><span className="sr-only">edited</span></span> : null}
          </>
        ),
        ...(line && o.value === shownGoal && !edited ? { tip: { title: o.label, body: line === 'Updating' ? 'Updating the estimate.' : `${line} from the last slice.` } } : {}),
        ...(editTip && o.value === shownGoal ? { tip: { title: `${o.label}, edited`, ...editTip } } : {}),
        // A goal is for the whole plate: in the selection's scope the tiles stay, still, so nothing below them moves.
        ...(scoped ? { disabled: true, tip: { title: o.label, reason: GOAL_PLATE } } : {}),
      })),
    [subtitles, line, shownGoal, edited, editTip, scoped],
  )
  return (
    <>
      <div className="goal-head">
        <div className="lbl" id="goal-label">
          Goal
        </div>
        {/* in the selection's scope the tiles hold the plate's goal: the reason sits where Custom would, same row */}
        {scoped ? (
          <span className="goal-plate sx-small sx-muted">Set on the plate</span>
        ) : edited && editTip ? (
          <Chip className="goal-custom" tabIndex={0} {...tipAttrs({ title: `${baseName}, edited`, ...editTip })}>
            Edited
          </Chip>
        ) : null}
      </div>
      <Seg<Goal> label="Goal" full className="goal-seg goal-tiles" value={shownGoal} options={tiles} onChange={(g) => !scoped && g !== 'custom' && pickGoal(g)} />

      <div className="srow" data-compact={!more || undefined} {...settingTipAttrs('layer_height', '.srow')}>
        <div className="srow-h">
          <span className="lbl-strong" id="easy-layer-label">
            Layer height
          </span>
        </div>
        <MenuAnchor>
          <button
            type="button"
            id="easy-layer"
            className="mini sx-mono"
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            aria-labelledby="easy-layer-label easy-layer"
            {...(sleipnirShown ? tipAttrs(sleipnirTip) : {})}
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            {layerMixed ? 'Mixed' : sleipnirShown ? <span className="seg-mark mark-sleipnir"><Icon name="sleipnir" size={15} />{SLEIPNIR}</span> : `${layer} mm`}
          </button>
          <Menu open={pickerOpen} onClose={() => setPickerOpen(false)} label="Layer height">
            {FIXED_HEIGHTS.map((h) => (
              <MenuItem key={h} checked={chosen === h} onClick={() => choose(h)}>
                {h.toFixed(2)} mm
              </MenuItem>
            ))}
            {scoped ? null : (
              <>
                <MenuSeparator />
                <MenuItem checked={chosen === SLEIPNIR} onClick={() => choose(SLEIPNIR)} {...tipAttrs(sleipnirTip)}>
                  <span className="seg-mark mark-sleipnir"><Icon name="sleipnir" size={15} />{SLEIPNIR}</span>
                  <br />
                  <small>{SLEIPNIR_LINE}</small>
                </MenuItem>
              </>
            )}
          </Menu>
        </MenuAnchor>
      </div>
      {conflict ? (
        <p className="support-line" role="status">
          <Icon name="alert" />
          {conflict}
        </p>
      ) : null}
      {costNote ? (
        <p className="support-line" role="status">
          <Icon name="alert" />
          {costNote}
        </p>
      ) : null}

      {more ? (
      <>
      <div className="srow" {...tipAttrs({ title: 'Strength', demo: 'strength' })}>
        <div className="srow-h">
          <label htmlFor="easy-strength">Strength</label>
          <output htmlFor="easy-strength">
            {walls} walls, {infill}% infill
          </output>
        </div>
        <Range id="easy-strength" onPointerDown={beginLiveEdit} min={0} max={100} step={5} value={strengthAt} onChange={(strength) => pick({ strength }, keys.strength)} aria-valuetext={`${walls} walls, ${infill} percent infill`} />
        <div className="ticks">
          <span>2 walls</span>
          <span>6 walls</span>
        </div>
      </div>

      {scoped ? null : (
      <div className="srow" {...tipAttrs({ title: 'Speed', demo: 'speed' })}>
        <div className="srow-h">
          <label htmlFor="easy-speed">Speed</label>
          <output htmlFor="easy-speed" {...(speed ? tipAttrs({ title: speed.label, demo: `speed-${speed.value}` }) : {})}>
            {speed?.label} ({speed?.pct}%)
          </output>
        </div>
        <Range id="easy-speed" onPointerDown={beginLiveEdit} min={0} max={3} step={1} value={speedIndex} onChange={(i) => update({ speed: SPEEDS[i]?.value ?? 'balanced' })} aria-valuetext={speed?.label ?? ''} />
        <div className="ticks">
          <span>Quality</span>
          <span>Fastest</span>
        </div>
      </div>
      )}
      </>
      ) : null}

      <div className="srow" data-compact={!more || undefined} {...settingTipAttrs('enable_support', '.srow')} data-tip-demo="supports">
        <div className="srow-h">
          <span className="lbl-strong">Supports</span>
        </div>
        {/* A phone can't paint supports, so it offers Off and Auto; a project that already paints them keeps Painted shown and picked. */}
        <Seg label="Supports" full value={scoped && mixedIn(keys.supports) ? ('' as SupportMode) : supports} options={phone && supports !== 'painted' ? SUPPORTS_PHONE : SUPPORTS} onChange={(supports) => pick({ supports }, keys.supports)} />
        {phone && supports === 'painted' ? <p className="support-line">The painted supports are edited on the desktop.</p> : null}
        {more ? <p className={supports === 'off' ? 'support-line' : 'support-line ok'}>
          <Icon name={supports === 'off' ? 'alert' : 'check'} />
          {supports === 'off'
            ? `No supports. Overhangs past ${angle} degrees print in the air.`
            : supports === 'auto'
              ? `Auto: tree supports from the build plate under overhangs past ${angle} degrees.`
              : 'Only where you paint support.'}
        </p> : null}
      </div>

      {more ? (
        <div {...tipAttrs({ title: 'Brim', demo: 'brim' })}>
          <SwitchRow className="mt14" id="easy-brim" label="Brim" detail={scoped && mixedIn(keys.brim) ? 'Mixed' : brim ? `${Number(cfg.brim_width) || 5} mm, helps small feet stick` : 'Off'} checked={brim} onChange={(brim) => pick({ brim }, keys.brim)} />
        </div>
      ) : null}
    </>
  )
}
