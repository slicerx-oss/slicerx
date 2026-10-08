// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The G-code line view: the text around the move at the nozzle, following the layer and move sliders. A click
// on a line moves the sliders to it. Only the rows in view exist in the page, so a 50 MB file scrolls like a
// small one. Loaded with the first open (lazy in studio.tsx).
import type { PreviewBuffers } from '@slicerx/contracts'
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useHost } from '../../host'
import { set, shownSlice, useApp } from '../../state/store'
import { setGcodePanel, useGcodeView } from './gcode-file'
import { currentSegment, lineOfSegment, lineText, scroller, segmentOfLine, slidersFor, type LineIndex } from './gcode-lines'
import { currentText, NoTextError } from './gcode-source'
import './gcode-panel.css'

const ROW = 18
const OVERSCAN = 6

/** The G-code line at the nozzle for the sliders, or 0 when the preview has no line numbers. */
export function lineAtNozzle(p: PreviewBuffers, layerHi: number, moveCut: number): number {
  return lineOfSegment(p, currentSegment(p, layerHi, moveCut))
}

/** Moves the layer and move sliders to the move a G-code line belongs to. False before the first move. */
export function jumpToLine(p: PreviewBuffers, line: number): boolean {
  const seg = segmentOfLine(p, line)
  if (seg < 0) return false
  set(slidersFor(p, seg))
  return true
}

function Row({ ix, n, on, top, onPick }: { ix: LineIndex; n: number; on: boolean; top: number; onPick: (n: number) => void }) {
  const text = lineText(ix, n)
  const semi = text.indexOf(';')
  const code = semi < 0 ? text : text.slice(0, semi)
  const word = /^\s*\S+/.exec(code)?.[0] ?? ''
  return (
    <div role="option" aria-selected={on} className={on ? 'gc-row on' : 'gc-row'} style={{ top }} onClick={() => onPick(n)}>
      <span className="gc-no">{n}</span>
      <span className="gc-text">
        <b>{word}</b>
        {code.slice(word.length)}
        {semi >= 0 ? <i>{text.slice(semi)}</i> : null}
      </span>
    </div>
  )
}

export function GcodePanel() {
  const host = useHost()
  const preview = useApp((s) => s.preview)
  const layerHi = useApp((s) => s.layerHi)
  const moveCut = useApp((s) => s.moveCut)
  const slice = useApp((s) => s.slice)
  const file = useGcodeView((s) => s.file)
  const [ix, setIx] = useState<LineIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewPx, setViewPx] = useState(400)
  const [topLine, setTopLine] = useState(1)
  const [bottom, setBottom] = useState(12)
  const [goTo, setGoTo] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const sliceId = shownSlice(slice)?.result.id ?? null

  // The text for what Preview shows: loaded once per slice or file.
  useEffect(() => {
    let live = true
    setError(null)
    const p = currentText(host)
    if (!p) {
      setIx(null)
      return
    }
    p.then((v) => live && setIx(v)).catch((e: unknown) => live && setError(e instanceof NoTextError ? e.message : 'The G-code could not be loaded.'))
    return () => {
      live = false
    }
  }, [host, sliceId, file])

  // Kept above the playback bar, which changes height as it is resized.
  useEffect(() => {
    const root = panelRef.current?.parentElement
    const dock = root?.querySelector<HTMLElement>('.dock')
    if (!dock) return
    const ro = new ResizeObserver(() => setBottom(dock.offsetHeight + 24))
    ro.observe(dock)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewPx(el.clientHeight))
    ro.observe(el)
    setViewPx(el.clientHeight)
    return () => ro.disconnect()
  }, [ix])

  const sc = useMemo(() => scroller(ix?.count ?? 0, ROW), [ix])
  const current = preview ? lineAtNozzle(preview, layerHi, moveCut) : 0

  // Follows the nozzle: the current line sits a third of the way down.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !ix || current < 1) return
    const rows = viewPx / ROW
    const first = topLine
    if (current >= first + 2 && current <= first + rows - 3) return
    el.scrollTop = sc.scrollFor(Math.max(1, current - Math.floor(rows / 3)), viewPx)
    setTopLine(sc.lineAt(el.scrollTop, viewPx))
    // topLine is read, not followed: a scroll by hand must not snap back until the nozzle moves.
  }, [current, ix, sc, viewPx])

  // Without line numbers there is no move to go to, so a click only reads.
  const pick = (n: number) => {
    if (preview && preview.extrasOffset >= 0 && !jumpToLine(preview, n)) set({ layerHi: 1, moveCut: 0 })
  }

  const onKey = (e: KeyboardEvent) => {
    if (!preview || current < 1 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    // Steps one move at a time, the way the move slider does.
    const seg = currentSegment(preview, layerHi, moveCut) + (e.key === 'ArrowDown' ? 1 : -1)
    if (seg >= 0 && seg < preview.segmentCount) jumpToLine(preview, lineOfSegment(preview, seg))
  }

  const submitGoTo = () => {
    const n = Math.round(Number(goTo))
    if (!ix || !Number.isFinite(n) || n < 1) return
    const line = Math.min(ix.count, n)
    const el = scrollRef.current
    if (el) {
      el.scrollTop = sc.scrollFor(Math.max(1, line - 3), viewPx)
      setTopLine(sc.lineAt(el.scrollTop, viewPx))
    }
    pick(line)
  }

  const first = Math.max(1, Math.floor(topLine) - OVERSCAN)
  const last = ix ? Math.min(ix.count, Math.ceil(topLine + viewPx / ROW) + OVERSCAN) : 0
  const shift = (topLine - Math.floor(topLine)) * ROW
  const rows: number[] = []
  for (let n = first; n <= last; n++) rows.push(n)
  const hasLines = !!preview && preview.extrasOffset >= 0

  return (
    <aside className="gc-panel sx-overlay" ref={panelRef} style={{ bottom }} aria-label="G-code">
      <header className="gc-head">
        <div>
          <b>G-code</b>
          <span className="sx-mono">{ix ? `${ix.count.toLocaleString('en-US')} lines` : error ? '' : 'Loading'}</span>
        </div>
        <form
          className="gc-goto"
          onSubmit={(e) => {
            e.preventDefault()
            submitGoTo()
          }}
        >
          <input className="sx-input sx-mono" inputMode="numeric" aria-label="Go to line" placeholder="Line" value={goTo} onChange={(e) => setGoTo(e.target.value.replace(/\D/g, ''))} />
        </form>
        <Button size="sm" variant="ghost" icon="close" aria-label="Close the G-code" onClick={() => setGcodePanel(false)} />
      </header>
      {error ? (
        <p className="gc-note sx-small sx-muted">{error}</p>
      ) : !ix ? (
        <p className="gc-note sx-small sx-muted">
          <Icon name="slice" size={14} /> Loading the G-code
        </p>
      ) : (
        <>
          {!hasLines ? <p className="gc-note sx-small sx-muted">This slice has no line numbers, so the text does not follow the sliders.</p> : null}
          <div
            className="gc-scroll"
            ref={scrollRef}
            tabIndex={0}
            role="listbox"
            aria-label="G-code lines"
            onKeyDown={onKey}
            onScroll={(e) => setTopLine(sc.lineAt(e.currentTarget.scrollTop, viewPx))}
          >
            <div className="gc-rows" style={{ height: viewPx }}>
              {rows.map((n) => (
                <Row key={n} ix={ix} n={n} on={n === current} top={(n - Math.floor(topLine)) * ROW - shift} onPick={pick} />
              ))}
            </div>
            <div style={{ height: Math.max(0, sc.spacerPx - viewPx) }} aria-hidden="true" />
          </div>
        </>
      )}
    </aside>
  )
}
