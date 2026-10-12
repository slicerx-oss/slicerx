// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab: the chat on the left and the design's view on the right, loaded as their own chunk when the tab first
// opens. The view is the one Model uses, on the same design and history; this file adds the chat column and the
// caption that names the view.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, ResizeEdge, tipAttrs } from '@slicerx/ui'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { cameraBus } from '../../plate/tools'
import { usePaneSize } from '../../shell/pane'
import { get, setCamera, useApp } from '../../state/store'
import './mimir.css'

/** The chat column's width: 420 px to start, 340 px at least and half the window at most. */
export const CHAT_WIDTH = { start: 420, min: 340 } as const

/** The widest the chat may be in a window this wide: half of it, and never under the minimum. */
export function chatMax(windowWidth: number): number {
  return Math.max(CHAT_WIDTH.min, Math.floor(windowWidth / 2))
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** The design's name for the chat header: the project file without its extension, or Untitled. */
export function designName(file: { name: string } | null): string {
  return file ? file.name.replace(/\.sx3mf$/i, '') : 'Untitled'
}

export function MimirChat() {
  const max = chatMax(useWindowWidth())
  const [width, setWidth] = usePaneSize('mimir-chat', CHAT_WIDTH.start, { min: CHAT_WIDTH.min, max })
  const [resizing, setResizing] = useState(false)
  const name = designName(useApp((s) => s.projectFile))
  const ref = useRef<HTMLElement>(null)
  return (
    <aside ref={ref} className="mimir-chat" data-testid="mimir-chat" data-resizing={resizing || undefined} aria-label={ASSISTANT_NAME} style={{ '--w-chat': `${width}px` } as CSSProperties}>
      <header className="mimir-chat-head">
        <span className="mimir-chat-mark" aria-hidden="true">
          <Icon name="mimir" size={18} />
        </span>
        <h2>{ASSISTANT_NAME}</h2>
        <span className="mimir-chat-design" {...tipAttrs({ title: name })}>
          {name}
        </span>
      </header>
      <div className="mimir-transcript" data-testid="mimir-transcript" role="log" aria-label="Conversation" tabIndex={0}>
        <div className="mimir-empty">
          <Icon name="mimir" size={28} />
          <p>Describe a part, or drop a photo of what it fits. {ASSISTANT_NAME} models it here, and every step lands in the timeline, where you can edit or undo it.</p>
        </div>
      </div>
      <form className="mimir-composer sx-overlay" data-testid="mimir-composer" aria-label={`Ask ${ASSISTANT_NAME}`} onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="mimir-ask" className="sr-only">
          Ask {ASSISTANT_NAME}
        </label>
        <input id="mimir-ask" type="text" placeholder={`Ask ${ASSISTANT_NAME}`} disabled spellCheck={false} />
        <Button size="sm" variant="ghost" icon="send" type="submit" aria-label="Send" disabled />
      </form>
      <div className="mimir-split" data-testid="mimir-split">
        <ResizeEdge
          pane="left"
          size={width}
          min={CHAT_WIDTH.min}
          max={max}
          collapsed={false}
          label="Resize the chat"
          measure={() => ref.current?.getBoundingClientRect() ?? null}
          onDraggingChange={setResizing}
          onResize={setWidth}
          // The chat is the tab: it keeps its minimum rather than shutting.
          onCollapse={() => setWidth(CHAT_WIDTH.min)}
          onExpand={(px) => setWidth(px ?? CHAT_WIDTH.start)}
        />
      </div>
    </aside>
  )
}

type Preset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'fit' | 'bed' | 'plate'

const VIEW_WORDS: Partial<Record<Preset, string>> = {
  top: 'Top, XY',
  bottom: 'Bottom, XY',
  front: 'Front, XZ',
  back: 'Back, XZ',
  left: 'Left, YZ',
  right: 'Right, YZ',
  iso: 'Isometric',
}

/** The caption for a camera preset: the view and its plane, or "3D view" once the person orbits off a preset. */
export function captionFor(preset: Preset | null): string {
  return (preset && VIEW_WORDS[preset]) ?? '3D view'
}

/** The pill at the view's top left that names the view. With nothing on the plate the tab opens on the top view. */
export function MimirCaption() {
  const [preset, setPreset] = useState<Preset | null>(() => (get().plate.length === 0 ? 'top' : get().camera))
  useEffect(() => {
    if (get().plate.length === 0) setCamera('top')
    const off = cameraBus()?.cad?.on('camera', (e: { preset: Preset | null }) => setPreset(e.preset))
    return () => off?.()
  }, [])
  return (
    <div className="mimir-caption sx-overlay sx-mono" data-testid="mimir-caption" aria-live="polite">
      {captionFor(preset)}
    </div>
  )
}
