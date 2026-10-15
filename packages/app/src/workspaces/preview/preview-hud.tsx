// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { EdgeTab, Icon, keymapFor, Menu, MenuAnchor, MenuItem, Range, ResizeEdge, Seg, tipAttrs, type IconName } from '@slicerx/ui'
import { COLORBLIND_THEME, FEATURE_COLORS, SCENE } from '@slicerx/viewport/palette'
import type { MarkerKind } from '@slicerx/viewport'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { playback, playbackTime } from './playback'
import { buildTimeline, clock, fitOf, movesAt, movesOf, positionAt, sliderOf, timeOfSlider } from '../../lib/preview-timeline'
import { toolChangerFor } from '../../lib/toolchanger'
import { lengthLabel, previewStats } from '../../lib/preview-stats'
import { resolveSlots } from '../../filament/slots'
import { Swatch } from '../../parts'
import { ColorBy } from '../view-menus'
import { LayerJump } from './layer-jump'
import { LayerTrack } from './layer-track'
import { layerKeyStep, stepLayer } from './layer-step'
import { usePaneSize } from '../../shell/pane'
import { registerEdge } from '../../shell/edge-keys'
import { useLookChoice } from '../../first-run/look'
import { useCompactLayout } from '../../lib/phone-layout'
import { colorblindToolpaths, get, set, shownSlice, useApp } from '../../state/store'
import { PLAYBACK_SPEEDS } from '../../state/prefs'
import { setGcodePanel, useGcodeView } from './gcode-file'
import { MARKERS, setMarkerShown, useMarkers } from './markers'
import { purgeReadout, usePurgeView, type PlayPurge } from './purge-view'
import { MoveStrikes, TimeStrikes } from './strike-slots'

/** Heights in px the playback bar snaps between: slim (transport only), medium and full. */
export const DOCK = { min: 56, max: 240, full: 174 } as const
/** Under this width the bar's two control rows fold into one. */
const NARROW = 1000
/** Playback speeds as the speed control shows them; the store keeps the number (PLAYBACK_SPEEDS). */
const speedLabel = (v: number) => (v < 1 ? `${v === 0.25 ? '¼' : '½'}x` : `${v}x`)
const speedTitle = (v: number) => (v === 1 ? 'Real time: as fast as the printer moves' : v < 1 ? `${v === 0.25 ? 'Quarter' : 'Half'} of real time` : `${v} times real time`)
const TOOLHEAD_TIP = { title: 'Show toolhead', body: 'Draw the moving toolhead at the current move. The tool rack or dock, the purge chute and the wiper stay in view either way.' }
const GANTRY_TIP = { title: 'Show gantry', body: 'Draw the gantry over the toolhead at the clearance height your printer profile gives, and the carriage a docked toolhead hangs on. A layer where the gantry would hit the print shows it either way.' }
const FOLLOW_TIP = { title: 'Follow the nozzle', body: 'Keep the camera on the nozzle while the print plays. Your angle and zoom stay as they are.' }

/** The playback speed as one button showing the rate, for a narrow bar. */
function SpeedMenu({ speed }: { speed: number }) {
  const [open, setOpen] = useState(false)
  return (
    <MenuAnchor className="dock-speed">
      <button type="button" className="dock-speed-btn sx-mono" aria-haspopup="menu" aria-expanded={open} aria-label={`Playback speed ${speedLabel(speed)}`} {...tipAttrs({ title: 'Playback speed', body: speedTitle(speed) })} onClick={() => setOpen(!open)}>
        <span>{speedLabel(speed)}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label="Playback speed">
        {PLAYBACK_SPEEDS.map((v) => (
          <MenuItem key={v} checked={v === speed} aside={v === 1 ? 'real time' : undefined} onClick={() => (setOpen(false), set({ playbackSpeed: v }))}>
            {speedLabel(v)}
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  )
}

/** True while the element is narrower than `px`; false where it cannot be measured. */
function useNarrower(ref: { current: HTMLElement | null }, px: number, on: boolean): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el || typeof ResizeObserver === 'undefined') return setNarrow(false)
    const measure = () => setNarrow(el.getBoundingClientRect().width < px)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, px, on])
  return narrow
}

/**
 * Whether the playback bar starts open, with its sliders. People start with it shut to its transport row and open it
 * from its ^ tab; browser test runs (session flag `sx-e2e`) start with it open, and `sx-preview-drawer` set to `shut`
 * or `open` decides it either way.
 */
export function drawerStartsOpen(): boolean {
  try {
    const v = sessionStorage.getItem('sx-preview-drawer')
    if (v) return v === 'open'
    return sessionStorage.getItem('sx-e2e') !== null
  } catch {
    return false
  }
}

/** Label and color of a toolpath feature, in the palette the person picked. Callers subscribe to `appearance.colorVision` to redraw. */
export function featureStyle(id: number): { label: string; color: string } {
  const f = FEATURE_COLORS.find((x) => x.id === id)
  if (!f) return { label: 'Other', color: 'var(--dim)' }
  return { label: f.label, color: (colorblindToolpaths() ? COLORBLIND_THEME.features[f.id] : undefined) ?? f.color }
}

/** Marker swatch in the shape the viewport draws: discs, a diamond for wipes, squares for changes and pauses. */
const MARKER_SWATCH: Record<MarkerKind, { color: keyof typeof SCENE; shape: 'disc' | 'diamond' | 'square' }> = {
  retractions: { color: 'retraction', shape: 'disc' },
  seams: { color: 'seam', shape: 'disc' },
  lifts: { color: 'lift', shape: 'disc' },
  wipes: { color: 'wipe', shape: 'diamond' },
  toolChanges: { color: 'toolChange', shape: 'square' },
  pauses: { color: 'pause', shape: 'square' },
}

function MarkerToggles({ hasExtras }: { hasExtras: boolean }) {
  const shown = useMarkers((s) => s.shown)
  const counts = useMarkers((s) => s.counts)
  return (
    <li className="legend-markers">
      <span className="legend-cap">Markers</span>
      {MARKERS.filter((m) => m.fromGcode || hasExtras).map((m) => {
        const sw = MARKER_SWATCH[m.kind]
        const n = counts[m.kind]
        return (
          <label key={m.kind} {...tipAttrs({ title: m.label, body: m.tip, demo: m.demo })}>
            <input type="checkbox" checked={shown[m.kind]} onChange={(e) => setMarkerShown(m.kind, e.target.checked)} />
            <i className={`mark-key ${sw.shape}`} style={{ background: SCENE[sw.color] }} />
            <span>{m.label}</span>
            {shown[m.kind] && n !== undefined ? <b>{n === 0 ? 'none' : n.toLocaleString('en-US')}</b> : null}
          </label>
        )
      })}
    </li>
  )
}

export function Legend() {
  const preview = useApp((s) => s.preview)
  const colorMode = useApp((s) => s.colorMode)
  const vision = useApp((s) => s.appearance.colorVision)
  // The slots' colors, which the filament view draws with; a string, so the selector stays stable.
  const slotColors = useApp((s) => resolveSlots(s).map((r) => r.color).join())
  // Each slot reads the filament it uses, as Filament use does, so the two agree; the toolpath length is the fallback
  // for a slice that reports no filament.
  const filamentMm = useApp((s) => shownSlice(s.slice)?.result.stats.filamentMm)
  const hidden = useApp((s) => s.legendHidden)
  if (!preview || hidden) return null
  const stats = colorMode === 'feature' ? previewStats(preview) : null
  const tools = colorMode === 'tool' ? previewStats(preview).toolLengthM : null
  const colors = slotColors.split(',')
  return (
    <ul className="legend sx-overlay" aria-label="Toolpath legend">
      <li className="legend-mode">
        <ColorBy />
      </li>
      {tools?.flatMap((m, i) =>
        m > 0
          ? [
              <li key={i} data-testid="legend-slot" data-slot={i + 1}>
                <Swatch color={colors[i] ?? 'var(--dim)'} size="sm" />
                <span>Slot {i + 1}</span>
                {filamentMm?.[i] ? (
                  <b {...tipAttrs({ title: 'Filament used', body: `${lengthLabel(m)} of toolpaths` })}>{`${(filamentMm[i]! / 1000).toFixed(2)} m`}</b>
                ) : (
                  <b {...tipAttrs({ title: 'Toolpath length' })}>{lengthLabel(m)}</b>
                )}
              </li>,
            ]
          : [],
      )}
      {stats?.features.slice(0, 7).map((f) => (
        <li key={f.feature}>
          <i className="bar-key" style={{ background: featureStyle(f.feature).color }} />
          <span>{featureStyle(f.feature).label}</span>
          <b>{lengthLabel(f.lengthM)}</b>
        </li>
      ))}
      {stats ? (
        <li className="legend-palette">
          <label>
            <input type="checkbox" checked={vision !== 'standard'} onChange={(e) => set({ appearance: { ...get().appearance, colorVision: e.target.checked ? 'redgreen' : 'standard' } })} /> Color vision colors
          </label>
        </li>
      ) : null}
      <MarkerToggles hasExtras={preview.extrasOffset >= 0} />
    </ul>
  )
}

const NO_PURGES: PlayPurge[] = []

/** Playback bar: play, pause and speed, scrub by print time or by layer, and the readouts for both. */
export function LayerDock() {
  const preview = useApp((s) => s.preview)
  const layerHi = useApp((s) => s.layerHi)
  const moveCut = useApp((s) => s.moveCut)
  const layerJump = useApp((s) => s.layerJump)
  const advanced = useApp((s) => s.settingsMode !== 'simple')
  const gcodeOn = useGcodeView((s) => s.panel)
  const showToolhead = useApp((s) => s.showToolhead)
  const showGantry = useApp((s) => s.showGantry)
  const playing = useStore(playback.state, (s) => s.playing)
  const clockT = useStore(playback.state, (s) => s.time)
  const setPlaying = (on: boolean) => on ? playback.play() : playback.pause()
  // The last speed chosen, kept between sessions; a first view plays at half speed, since a fast printer at real
  // speed is faithful but too quick to follow.
  const speed = useApp((s) => s.playbackSpeed)
  const followNozzle = useApp((s) => s.followNozzle)
  const changer = useApp(toolChangerFor)
  const stats = useApp((s) => shownSlice(s.slice)?.result.stats ?? null)
  const timeline = useMemo(() => (preview ? buildTimeline(preview, changer, fitOf(stats)) : null), [preview, changer, stats])
  const toolChange = useApp((s) => s.toolChange)
  // heimdall: a jump to a strike plays the seconds before it and stops on it.
  const strikeJump = useApp((s) => s.strikeJump)
  // The purge at the chute (Bambu printers), read from the G-code once the preview is up.
  const purges = usePurgeView((s) => (s.timeline === timeline ? s.plans : NO_PURGES))
  useLayoutEffect(() => preview && timeline ? playback.bind(preview, timeline) : undefined, [preview, timeline])

  const n = preview?.layerCount ?? 0
  const top = Math.max(1, Math.min(layerHi, n))
  const now = preview && timeline ? playbackTime(preview, timeline, clockT) : 0

  const seek = playback.seek
  const toggle = playback.toggle
  useEffect(() => {
    if (!strikeJump || !timeline || !preview) return
    playback.strike(strikeJump.timeS)
    set({ strikeJump: null })
  }, [strikeJump?.seq])

  // Profiling hook (localStorage 'slicerx.debug', like the viewport's __vp): the timeline and a seek, for scripts.
  useEffect(() => {
    try {
      if (localStorage.getItem('slicerx.debug')) Object.assign(window, { __pv: { timeline, seek, toggle, playing: () => playback.read().playing, clock: () => playback.read().timeS ?? 0, track: (time: number) => (timeline ? sliderOf(timeline, time) : 0), moves: (time: number) => { if (!timeline || !preview) return 0; const q = positionAt(timeline, preview, time); return { layerHi: q.layerHi, value: 1000 * movesOf(timeline, preview, q.layerHi, q.moveCut, q.change ?? null) } } } })
    } catch {
      // No storage: no hook.
    }
  })

  // The dock is only there while Slice shows the toolpaths, so Space plays the layers whenever it is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement | null)?.closest('input,textarea,select,button,[contenteditable],[role=dialog]')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const dockRef = useRef<HTMLDivElement>(null)
  const [startOpen] = useState(drawerStartsOpen)
  const [dockSize, setDockSize] = usePaneSize('preview-bottom', startOpen ? DOCK.full : DOCK.min, DOCK)
  // On a phone the bar sits under the view as one row of transport and readout; the rest opens below that row.
  const compact = useCompactLayout()
  const [opened, setOpened] = useState(false)
  const bodyId = useId()
  const choice = useLookChoice()
  const chord = keymapFor(choice.id, choice.overrides?.keys ?? {})['panel.bottom']
  const shut = !compact && dockSize <= DOCK.min
  // The ^ tab on the bar's top edge, and the bottom panel key, open the sliders and shut the bar to its transport row.
  const toggleDrawer = () => setDockSize(shut ? DOCK.full : DOCK.min)
  const toggleRef = useRef(toggleDrawer)
  toggleRef.current = toggleDrawer
  const shown = !!preview && !!timeline
  useEffect(() => (shown && !compact ? registerEdge('bottom', () => toggleRef.current()) : undefined), [shown, compact])
  // A narrow bar (the right pane open on a laptop) keeps one control row: the speed as a menu, the checks as icon toggles.
  const narrow = useNarrower(dockRef, NARROW, !compact && shown)
  if (!preview || !timeline) return null
  // Tall shows every slider, medium the time and layer ones, and the slim bar only the transport.
  const mode = compact ? 'full' : shut ? 'slim' : dockSize < 150 ? 'compact' : 'full'
  const z = preview.layerZ[top - 1] ?? 0
  const layerT = preview.layerTimeS[top - 1] ?? 0
  const segs = (preview.layerStart[top] ?? 0) - (preview.layerStart[top - 1] ?? 0)
  const moves = Math.round(segs * moveCut)
  const changeIndex = toolChange ? timeline.changes.findIndex((c) => c.segment === toolChange.segment) : -1
  const changeTo = changeIndex >= 0 ? (timeline.changes[changeIndex]?.to ?? 0) : 0
  const purge = purgeReadout(purges, toolChange)

  // Speed beside the transport; the toolhead, gantry and nozzle checks and the G-code lines on the row under it with
  // the readout. On a phone both open together in the opened bar.
  const speedOpts = narrow ? (
    <SpeedMenu speed={Number(speed)} />
  ) : (
    <>
      <span className="dock-cap">Speed</span>
      <Seg
        label="Playback speed"
        size="sm"
        mono
        value={String(speed)}
        onChange={(v) => set({ playbackSpeed: Number(v) })}
        options={PLAYBACK_SPEEDS.map((v) => ({ value: String(v), label: speedLabel(v), title: v === 1 ? 'Real time: as fast as the printer moves' : v < 1 ? `${v === 0.25 ? 'Quarter' : 'Half'} of real time` : `${v} times real time` }))}
      />
    </>
  )
  const gcodeBtn = (
    <button
      type="button"
      className="play step ghost"
      aria-label="G-code"
      aria-pressed={gcodeOn}
      {...tipAttrs({ title: gcodeOn ? 'Hide the G-code' : 'Show the G-code', body: 'The G-code around the move at the nozzle. Click a line to move there.' })}
      onClick={() => setGcodePanel(!gcodeOn)}
    >
      <Icon name="list" />
    </button>
  )
  // On a folded bar the checks are icon toggles, still checkboxes (the same test ids and names) inside a button's frame.
  const iconCheck = (testId: string | undefined, label: string, tip: { title: string; body: string }, icon: IconName, on: boolean, change: (on: boolean) => void) => (
    <label className="play step ghost dock-toggle" data-on={on || undefined} {...tipAttrs(tip)}>
      <input type="checkbox" {...(testId ? { 'data-testid': testId } : {})} aria-label={label} checked={on} onChange={(e) => change(e.target.checked)} />
      <Icon name={icon} />
    </label>
  )
  const viewOpts = narrow ? (
    <>
      {iconCheck('pv-show-toolhead', 'Show toolhead', TOOLHEAD_TIP, 'hotend', showToolhead, (on) => set({ showToolhead: on }))}
      {iconCheck('pv-show-gantry', 'Show gantry', GANTRY_TIP, 'printer-cartesian-gantry', showGantry, (on) => set({ showGantry: on }))}
      {iconCheck(undefined, 'Follow nozzle', FOLLOW_TIP, 'camera', followNozzle, (on) => set({ followNozzle: on }))}
      {gcodeBtn}
    </>
  ) : (
    <>
      <label className="dock-check" {...tipAttrs({ title: 'Show toolhead', body: 'Draw the moving toolhead at the current move. The tool rack or dock, the purge chute and the wiper stay in view either way.', demo: 'heimdall' })}>
        <input type="checkbox" data-testid="pv-show-toolhead" aria-label="Show toolhead" checked={showToolhead} onChange={(e) => set({ showToolhead: e.target.checked })} />
        <span className="dock-pre">Show </span>
        toolhead
      </label>
      <label className="dock-check" {...tipAttrs({ title: 'Show gantry', body: 'Draw the gantry over the toolhead at the clearance height your printer profile gives, and the carriage a docked toolhead hangs on. A layer where the gantry would hit the print shows it either way.' })}>
        <input type="checkbox" data-testid="pv-show-gantry" aria-label="Show gantry" checked={showGantry} onChange={(e) => set({ showGantry: e.target.checked })} />
        <span className="dock-pre">Show </span>
        gantry
      </label>
      <label className="dock-check" {...tipAttrs({ title: 'Follow the nozzle', body: 'Keep the camera on the nozzle while the print plays. Your angle and zoom stay as they are.' })}>
        <input type="checkbox" checked={followNozzle} onChange={(e) => set({ followNozzle: e.target.checked })} />
        Follow nozzle
      </label>
      {gcodeBtn}
    </>
  )
  const opts = (
    <>
      {speedOpts}
      {viewOpts}
    </>
  )

  // A typed layer, a pin and a right-click on the Layer track all go to a layer the same way: playback stops there.
  const jump = (k: number) => (setPlaying(false), stepLayer(0, k))

  // Layer, Z and layer time, or the change and purge in their place.
  const readout = (
    <span className="dock-read sx-mono sx-dim">
      {/* During a purge its grams take the layer's place (the layer slider shows both), so the line keeps its length. */}
      {purge && !layerJump ? null : (
        <>
          <LayerJump top={top} n={n} layerZ={preview.layerZ} short={narrow} onJump={jump} />
          <span className="hide-sm dock-z" {...(narrow ? tipAttrs({ title: 'Height of this layer' }) : {})}>
            {narrow ? null : 'Z '}
            <b>{z.toFixed(2)}</b> mm
          </span>
        </>
      )}
      {/* A change takes the layer time's place, so the readout keeps its line and the transport does not move. */}
      {toolChange ? null : (
        <span className="hide-sm dock-lt" {...(narrow ? tipAttrs({ title: 'Layer time' }) : {})}>
          {narrow ? null : 'Layer time '}
          <b>{layerT < 60 ? `${layerT.toFixed(0)} s` : `${Math.floor(layerT / 60)}m ${Math.round(layerT % 60)}s`}</b>
        </span>
      )}
      {toolChange ? (
        <span data-testid="pv-change">
          {changer?.kind === 'filament-swap' ? 'Filament change' : 'Tool change'} <b>{changeIndex + 1}</b> of {timeline.changes.length}, to slot {changeTo + 1}
        </span>
      ) : null}
      {purge ? (
        <span data-testid="pv-purge" {...tipAttrs({ title: 'Purge', body: 'Plastic flushed into the chute: this change so far, and the whole print up to here. From the change G-code and the filament density.' })}>
          Purge <b>{purge.now.toFixed(2)} g</b>, print total <b>{purge.total.toFixed(2)} g</b>
        </span>
      ) : null}
    </span>
  )

  return (
    <div className="dock sx-overlay" role="group" aria-label="Layers and moves" data-mode={mode} data-phone={compact || undefined} data-narrow={narrow || undefined} data-testid="preview-drawer" ref={dockRef}>
      {compact ? null : (
        <EdgeTab
          side="bottom"
          open={!shut}
          label="Playback sliders"
          panel="preview-drawer"
          controls={bodyId}
          className="dock-tab"
          tip="The time, layer and move sliders. Drag the top edge to size them."
          {...(chord ? { shortcut: chord } : {})}
          onToggle={toggleDrawer}
        />
      )}
      {compact ? null : <ResizeEdge
        pane="bottom"
        size={dockSize}
        min={DOCK.min + 24}
        max={DOCK.max}
        collapsed={mode === 'slim'}
        collapsedSize={DOCK.min}
        label="Resize the playback bar"
        measure={() => dockRef.current?.getBoundingClientRect() ?? null}
        onResize={setDockSize}
        onCollapse={() => setDockSize(DOCK.min)}
        onExpand={(px) => setDockSize(px ?? DOCK.full)}
      />}
      <div className="dock-h">
        <button
          type="button"
          className="play primary"
          aria-label={playing ? 'Pause playback' : 'Play print'}
          aria-pressed={playing}
          {...tipAttrs({ title: playing ? 'Pause' : 'Play the print', body: 'Watch the toolhead lay down each move in print order.', key: 'Space' })}
          onClick={toggle}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button type="button" className="play step ghost" aria-label="Previous layer" aria-disabled={top <= 1} {...tipAttrs({ title: 'Previous layer', ...(top <= 1 ? { reason: 'This is the first layer.' } : {}) })} onClick={() => top > 1 && (setPlaying(false), set({ layerHi: top - 1, moveCut: 1, toolChange: null }))}>
          <Icon name="chevron-left" />
        </button>
        <button type="button" className="play step ghost" aria-label="Next layer" aria-disabled={top >= n} {...tipAttrs({ title: 'Next layer', ...(top >= n ? { reason: 'This is the last layer.' } : {}) })} onClick={() => top < n && (setPlaying(false), set({ layerHi: top + 1, moveCut: 1, toolChange: null }))}>
          <Icon name="chevron-right" />
        </button>
        {compact ? null : speedOpts}
        {narrow ? viewOpts : null}
        {compact || narrow ? readout : null}
        {compact ? (
          <button type="button" className="play step ghost dock-more" aria-expanded={opened} aria-label={opened ? 'Fewer playback controls' : 'More playback controls'} onClick={() => setOpened(!opened)}>
            <Icon name={opened ? 'chevron-down' : 'chevron-up'} />
          </button>
        ) : null}
      </div>
      {compact || narrow ? null : (
        <div className="dock-h dock-h2">
          {viewOpts}
          {readout}
        </div>
      )}
      {/* On a phone the rest opens as a panel over the foot of the view, so the bar's row and Print stay put. */}
      {compact && !opened ? null : (
        <div id={bodyId} className={compact ? 'dock-body sx-overlay' : 'dock-body'}>
          {compact ? <div className="dock-opts">{opts}</div> : null}
          <div className="dock-row">
            <label htmlFor="pv-time">Time</label>
            <div className="strike-rail">
              <Range
              id="pv-time"
              min={0}
              max={Math.max(1, timeline.total)}
              step={0.001}
              value={sliderOf(timeline, now)}
              onChange={(v) => seek(timeOfSlider(timeline, v))}
              onKeyDown={(e) => {
                // The track is in fine steps for dragging; the keys step by print time.
                const by = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 60 : e.key === 'PageDown' ? -60 : 0
                if (e.key === 'Home' || e.key === 'End') {
                  e.preventDefault()
                  seek(e.key === 'Home' ? 0 : timeline.total)
                } else if (by) {
                  e.preventDefault()
                  seek(now + by * (e.shiftKey ? 10 : 1))
                }
              }}
              aria-valuetext={`${clock(now)} of ${clock(timeline.total)}`}
              />
              <TimeStrikes timeline={timeline} />
            </div>
            <output className="sx-mono" htmlFor="pv-time">
              {clock(now)} / {clock(timeline.total)}
            </output>
          </div>
          <div className="dock-row">
            <label htmlFor="pv-layer">Layer</label>
            <LayerTrack id="pv-layer" n={n} top={top} layerZ={preview.layerZ} onKeyDown={(e) => { const by = layerKeyStep(e.key); if (by && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setPlaying(false); stepLayer(by) } }} onChange={(v) => (setPlaying(false), set({ layerHi: v, moveCut: 1, toolChange: null }))} onJump={jump} />
            <output className="sx-mono" htmlFor="pv-layer">
              {z.toFixed(2)} mm
            </output>
          </div>
          {advanced ? (
            <div className="dock-row">
              <label htmlFor="pv-moves">Moves</label>
              <div className="strike-rail">
              <Range
                id="pv-moves"
                className="thin"
                min={0}
                max={1000}
                step={0.01}
                value={1000 * movesOf(timeline, preview, top, moveCut, toolChange)}
                onChange={(v) => {
                  setPlaying(false)
                  // A tool change inside the layer has its own stretch of this track: dragging through it plays it.
                  const at = movesAt(timeline, preview, top, v / 1000)
                  set({ moveCut: at.moveCut, toolChange: at.change ?? null })
                }}
                aria-valuetext={`${moves} of ${segs} moves`}
              />
              <MoveStrikes timeline={timeline} preview={preview} top={top} segs={segs} />
              </div>
              <output className="sx-mono" htmlFor="pv-moves">
                {moves} / {segs}
              </output>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
