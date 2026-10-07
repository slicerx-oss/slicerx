// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Icon, Range, ResizeEdge, Seg, tipAttrs } from '@slicerx/ui'
import { COLORBLIND_THEME, FEATURE_COLORS, SCENE } from '@slicerx/viewport/palette'
import type { MarkerKind } from '@slicerx/viewport'
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildTimeline, clock, fitOf, movesAt, movesOf, positionAt, sliderOf, timeAt, timeOfSlider } from '../../lib/preview-timeline'
import { toolChangerFor } from '../../lib/toolchanger'
import { lengthLabel, previewStats } from '../../lib/preview-stats'
import { resolveSlots } from '../../filament/slots'
import { Swatch } from '../../parts'
import { ColorBy } from '../view-menus'
import { LayerTrack } from './layer-track'
import { layerKeyStep, stepLayer } from './layer-step'
import { usePaneSize } from '../../shell/pane'
import { colorblindToolpaths, get, set, useApp } from '../../state/store'
import { PLAYBACK_SPEEDS } from '../../state/prefs'
import { setGcodePanel, useGcodeView } from './gcode-file'
import { MARKERS, setMarkerShown, useMarkers } from './markers'
import { purgeReadout, usePurgeView, type PlayPurge } from './purge-view'
import { MoveStrikes, TimeStrikes } from './strike-slots'

/** Heights in px the playback bar snaps between: slim (transport only), medium and full. */
const DOCK = { min: 56, max: 240, full: 190 } as const

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
          <label key={m.kind} {...tipAttrs({ title: m.label, body: m.tip })}>
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
  if (!preview) return null
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
                <b>{lengthLabel(m)}</b>
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

/** Playback speeds as the speed control shows them; the store keeps the number (PLAYBACK_SPEEDS). */
const speedLabel = (v: number) => (v < 1 ? `${v === 0.25 ? '¼' : '½'}x` : `${v}x`)

/** Playback bar: play, pause and speed, scrub by print time or by layer, and the readouts for both. */
export function LayerDock() {
  const preview = useApp((s) => s.preview)
  const layerHi = useApp((s) => s.layerHi)
  const moveCut = useApp((s) => s.moveCut)
  const advanced = useApp((s) => s.settingsMode !== 'simple')
  const workspace = useApp((s) => s.workspace)
  const gcodeOn = useGcodeView((s) => s.panel)
  const showToolhead = useApp((s) => s.showToolhead)
  const [playing, setPlayingState] = useState(false)
  // Ticks check this ref, so a pause lands on the next frame instead of after React commits.
  const playingRef = useRef(false)
  const setPlaying = (on: boolean) => {
    playingRef.current = on
    setPlayingState(on)
  }
  // The last speed chosen, kept between sessions; a first view plays at half speed, since a fast printer at real
  // speed is faithful but too quick to follow.
  const speed = useApp((s) => s.playbackSpeed)
  const followNozzle = useApp((s) => s.followNozzle)
  const raf = useRef(0)
  const changer = useApp(toolChangerFor)
  const stats = useApp((s) => (s.slice.status === 'done' ? s.slice.result.stats : null))
  const timeline = useMemo(() => (preview ? buildTimeline(preview, changer, fitOf(stats)) : null), [preview, changer, stats])
  const toolChange = useApp((s) => s.toolChange)
  // heimdall: a jump to a strike plays the seconds before it and stops on it.
  const strikeJump = useApp((s) => s.strikeJump)
  const stopAt = useRef<number | null>(null)
  // The purge at the chute (Bambu printers), read from the G-code once the preview is up.
  const purges = usePurgeView((s) => (s.timeline === timeline ? s.plans : NO_PURGES))
  // Playback and scrubbing keep their own float clock; the store only holds the layer and move share it maps
  // to. `clockT` is the same clock as state, so the Time slider follows it smoothly, inside a change too,
  // instead of jumping to the end of the last drawn move.
  const clockRef = useRef(0)
  const [clockT, setClockT] = useState(0)
  const speedRef = useRef(Number(speed))
  speedRef.current = Number(speed)

  const n = preview?.layerCount ?? 0
  const top = Math.max(1, Math.min(layerHi, n))
  const t = preview && timeline ? timeAt(timeline, preview, top, moveCut) : 0
  /** True when the store shows exactly what print time `time` maps to (so `time` can stand for it). */
  const synced = (time: number) => {
    if (!preview || !timeline) return false
    const p = positionAt(timeline, preview, time)
    return p.layerHi === top && Math.abs(p.moveCut - moveCut) < 1e-9 && (p.change?.segment ?? -1) === (toolChange?.segment ?? -1) && Math.abs((p.change?.seconds ?? 0) - (toolChange?.seconds ?? 0)) < 1e-6
  }
  const now = synced(clockT) ? clockT : t

  const seek = (time: number) => {
    if (!preview || !timeline) return
    const at = Math.min(Math.max(time, 0), timeline.total)
    clockRef.current = at
    setClockT(at)
    const pos = positionAt(timeline, preview, at)
    set({ layerHi: pos.layerHi, moveCut: pos.moveCut, toolChange: pos.change ?? null })
  }

  useEffect(() => {
    if (!playing || !preview || !timeline) return
    let last = performance.now()
    const tick = (now: number) => {
      if (!playingRef.current) return
      clockRef.current = Math.min(timeline.total, clockRef.current + ((now - last) / 1000) * speedRef.current)
      last = now
      if (stopAt.current !== null && clockRef.current >= stopAt.current) {
        clockRef.current = stopAt.current
        stopAt.current = null
        setPlaying(false)
      }
      setClockT(clockRef.current)
      const pos = positionAt(timeline, preview, clockRef.current)
      const s = get()
      if (pos.layerHi !== s.layerHi || pos.moveCut !== s.moveCut || (pos.change ?? null) !== s.toolChange) set({ layerHi: pos.layerHi, moveCut: pos.moveCut, toolChange: pos.change ?? null })
      if (clockRef.current >= timeline.total || !playingRef.current) {
        setPlaying(false)
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, preview, timeline])

  // Something else moved the range (the layer slider, a command, a new slice): playback continues from there.
  // A scrub's own time stays as it is, since it maps to what the store shows. Only the ref moves: the render
  // already shows `t` when the clock is out of step, and a state update here would give every layer key a
  // second render, which a held key on a slow machine stacks into React's nested update limit.
  useEffect(() => {
    if (!playing && !synced(clockRef.current)) clockRef.current = t
  })

  useEffect(() => {
    if (!strikeJump || !timeline || !preview) return
    // Two seconds of playback at the chosen speed lead up to the strike.
    const lead = 2 * Math.max(0.25, speedRef.current)
    stopAt.current = strikeJump.timeS
    seek(Math.max(timeline.lead, strikeJump.timeS - lead))
    setPlaying(true)
    // Taken: a later mount of the bar does not play it again.
    set({ strikeJump: null })
    // Only a new jump starts this; the timeline and preview it reads are the current ones then.
  }, [strikeJump?.seq])

  const toggle = () => {
    stopAt.current = null
    if (!timeline) return
    if (!playing && clockRef.current >= timeline.total - 0.001) seek(0)
    else if (!playing) clockRef.current = now
    setPlaying(!playing)
  }

  // Profiling hook (localStorage 'slicerx.debug', like the viewport's __vp): the timeline and a seek, for scripts.
  useEffect(() => {
    try {
      if (localStorage.getItem('slicerx.debug')) Object.assign(window, { __pv: { timeline, seek, toggle, playing: () => playingRef.current, clock: () => clockRef.current, track: (time: number) => (timeline ? sliderOf(timeline, time) : 0), moves: (time: number) => { if (!timeline || !preview) return 0; const q = positionAt(timeline, preview, time); return { layerHi: q.layerHi, value: 1000 * movesOf(timeline, preview, q.layerHi, q.moveCut, q.change ?? null) } } } })
    } catch {
      // No storage: no hook.
    }
  })

  useEffect(() => {
    if (workspace !== 'preview') return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement | null)?.closest('input,textarea,select,button,[contenteditable],[role=dialog]')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const dockRef = useRef<HTMLDivElement>(null)
  const [dockSize, setDockSize] = usePaneSize('preview-bottom', DOCK.full, DOCK)
  if (!preview || !timeline) return null
  // Tall shows every slider, medium the time and layer ones, and the slim bar only the transport.
  const mode = dockSize <= DOCK.min ? 'slim' : dockSize < 150 ? 'compact' : 'full'
  const z = preview.layerZ[top - 1] ?? 0
  const layerT = preview.layerTimeS[top - 1] ?? 0
  const segs = (preview.layerStart[top] ?? 0) - (preview.layerStart[top - 1] ?? 0)
  const moves = Math.round(segs * moveCut)
  const changeIndex = toolChange ? timeline.changes.findIndex((c) => c.segment === toolChange.segment) : -1
  const changeTo = changeIndex >= 0 ? (timeline.changes[changeIndex]?.to ?? 0) : 0
  const purge = purgeReadout(purges, toolChange)

  return (
    <div className="dock sx-overlay" role="group" aria-label="Layers and moves" data-mode={mode} ref={dockRef}>
      <ResizeEdge
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
      />
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
        <span className="dock-cap">Speed</span>
        <Seg
          label="Playback speed"
          size="sm"
          mono
          value={String(speed)}
          onChange={(v) => set({ playbackSpeed: Number(v) })}
          options={PLAYBACK_SPEEDS.map((v) => ({ value: String(v), label: speedLabel(v), title: v === 1 ? 'Real time: as fast as the printer moves' : v < 1 ? `${v === 0.25 ? 'Quarter' : 'Half'} of real time` : `${v} times real time` }))}
        />
        <label className="dock-check" {...tipAttrs({ title: 'Show toolhead', body: 'Draw the moving toolhead at the current move. The tool rack or dock, the purge chute and the wiper stay in view either way.' })}>
          <input type="checkbox" checked={showToolhead} onChange={(e) => set({ showToolhead: e.target.checked })} />
          Show toolhead
        </label>
        <label className="dock-check" {...tipAttrs({ title: 'Follow the nozzle', body: 'Keep the camera on the nozzle while the print plays. Your angle and zoom stay as they are.' })}>
          <input type="checkbox" checked={followNozzle} onChange={(e) => set({ followNozzle: e.target.checked })} />
          Follow nozzle
        </label>
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
        <span className="dock-read sx-mono sx-dim">
          {/* During a purge its grams take the layer's place (the layer slider shows both), so the line keeps its length. */}
          {purge ? null : (
            <>
              <span>
                Layer <b>{top}</b> of {n}
              </span>
              <span>
                Z <b>{z.toFixed(2)}</b> mm
              </span>
            </>
          )}
          {/* A change takes the layer time's place, so the readout keeps its line and the transport does not move. */}
          {toolChange ? null : (
            <span className="hide-sm">
              Layer time <b>{layerT < 60 ? `${layerT.toFixed(0)} s` : `${Math.floor(layerT / 60)}m ${Math.round(layerT % 60)}s`}</b>
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
      </div>
      <div className="dock-row">
        <label htmlFor="pv-time">Time</label>
        <div className="strike-rail">
          <Range
          id="pv-time"
          min={0}
          max={Math.max(1, timeline.total)}
          step={0.001}
          value={sliderOf(timeline, now)}
          onChange={(v) => ((stopAt.current = null), seek(timeOfSlider(timeline, v)))}
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
        <LayerTrack id="pv-layer" n={n} top={top} layerZ={preview.layerZ} onKeyDown={(e) => { const by = layerKeyStep(e.key); if (by && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setPlaying(false); stepLayer(by) } }} onChange={(v) => (setPlaying(false), set({ layerHi: v, moveCut: 1, toolChange: null }))} />
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
              stopAt.current = null
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
  )
}
