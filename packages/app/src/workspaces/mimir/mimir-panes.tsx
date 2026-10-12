// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab: the chat on the left and the design's view on the right, loaded as their own chunk when the tab first
// opens. The view is the one Model uses, on the same design and history; this file adds the chat column and the
// caption that names the view.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Composer, TranscriptView, useAttachments, usePilotRun, type ApprovalHandlers, type Transcript } from '@slicerx/pilot/ui'
import type { PilotLookup } from '@slicerx/contracts'
import '@slicerx/pilot/ui/pilot.css'
import { Button, Icon, RavenMark, ResizeEdge, tipAttrs } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { setLookups } from './lookups'
import { stepWords } from './step-words'
import { followSteps, useStepCaption, viewStep } from './view-step'
import { newSessionId, noteMessage, tabMimir, tabTools } from './session'
import { editRow } from './sheet-drive'
import { openSheet, setSheetActions, setShownSheet, sheetMode, useSheetUi, type ShownSheet } from './sheet-ui'
import { useHost } from '../../host'
import { cameraBus } from '../../plate/tools'
import { usePaneSize } from '../../shell/pane'
import { get, setCamera, useApp } from '../../state/store'
import { useMimirLink } from './connection'
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

/** The conversation's latest sheet, for the view. */
export function lastSheet(t: Transcript): ShownSheet | null {
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const b = t.turns[i]!.blocks.findLast((x) => x.kind === 'sheet')
    if (b && b.kind === 'sheet') return { sheet: b.sheet, answer: b.answer, bound: b.bound ?? null, replay: b.replay }
  }
  return null
}

/** Every lookup in the conversation, oldest first. */
export function lookupsIn(t: Transcript): PilotLookup[] {
  return t.turns.flatMap((turn) => turn.blocks.flatMap((b) => (b.kind === 'lookup' ? [b.lookup] : [])))
}

// Approvals never come up in the tab: its tools change nothing outside the design.
const NO_APPROVAL = async (): Promise<void> => undefined

export function MimirChat({ hidden = false }: { hidden?: boolean }) {
  const max = chatMax(useWindowWidth())
  const [width, setWidth] = usePaneSize('mimir-chat', CHAT_WIDTH.start, { min: CHAT_WIDTH.min, max })
  const [resizing, setResizing] = useState(false)
  const name = designName(useApp((s) => s.projectFile))
  const ref = useRef<HTMLElement>(null)
  const attachments = useAttachments()
  // The battle ravens stand behind the conversation until a model answers here.
  const link = useMimirLink()
  // They fade out once the conversation starts, so no piece of the ring shows between its cards.
  const ravensOn = link !== 'model'
  const host = useHost()
  const pilot = useMemo(() => tabMimir(host.slicer), [host])
  const [sessionId, setSessionId] = useState(newSessionId)
  const run = usePilotRun(pilot, sessionId)
  const { reset, transcript } = run
  const ravens = ravensOn && transcript.turns.length === 0
  useEffect(() => reset(), [sessionId, reset])
  useEffect(() => setLookups(lookupsIn(transcript)), [transcript])
  useEffect(() => setShownSheet(lastSheet(transcript)), [transcript])
  useEffect(() => {
    setSheetActions({
      confirm: (sheetId, values) => pilot.answerSheet?.(sheetId, values) ?? Promise.resolve(),
      cancel: (sheetId) => pilot.answerSheet?.(sheetId, null) ?? Promise.resolve(),
      drive: (bound, key, value) => editRow(tabTools(), bound, key, value),
    })
    return () => setSheetActions(null)
  }, [pilot])
  useEffect(() => () => setShownSheet(null), [])
  useEffect(() => followSteps(transcript), [transcript])
  useEffect(() => () => viewStep.setState({ caption: null }), [])
  const handlers = useMemo<ApprovalHandlers>(() => ({ onApprove: NO_APPROVAL, onCancel: NO_APPROVAL, onChoose: (askId, choiceId) => pilot.answer?.(askId, choiceId) ?? Promise.resolve(), onOpenSheet: openSheet }), [pilot])
  // Follows the stream while the reader is at the bottom; leaves them be once they scroll up.
  const body = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = body.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [transcript])
  // A file dragged anywhere over the chat can be dropped onto the message.
  const [dropping, setDropping] = useState(false)
  const files = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  return (
    <aside
      ref={ref}
      hidden={hidden}
      className="mimir-chat sx-pilot"
      data-testid="mimir-chat"
      data-resizing={resizing || undefined}
      data-drop={dropping || undefined}
      aria-label={ASSISTANT_NAME}
      style={{ '--w-chat': `${width}px` } as CSSProperties}
      onDragOver={(e) => {
        if (!files(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!files(e)) return
        e.preventDefault()
        setDropping(false)
        void attachments.add(Array.from(e.dataTransfer.files))
      }}
    >
      <header className="mimir-chat-head">
        <span className="mimir-chat-mark" aria-hidden="true">
          <Icon name="mimir" size={18} />
        </span>
        <h2>{ASSISTANT_NAME}</h2>
        <span className="mimir-chat-design" {...tipAttrs({ title: name })}>
          {name}
        </span>
        {/* Shown while the stub answers, so nobody mistakes it for a model. */}
        {link === 'scripted' ? (
        <span className="mimir-chat-scripted sx-mono" {...tipAttrs({ title: 'Scripted replies', body: `${ASSISTANT_NAME} plays scripted turns here until a model is connected to this tab. The tools it calls are real.` })}>
          Scripted replies
        </span>
        ) : null}
        <Button size="sm" variant="ghost" icon="plus" aria-label="New conversation" tip="pilot.newChat" onClick={() => setSessionId(newSessionId())} />
      </header>
      <div className="mimir-stage">
        <div className="mimir-ravens" data-testid="mimir-ravens" data-shown={ravens || undefined} aria-hidden="true">
          <RavenMark />
        </div>
        <div
          ref={body}
          className="mimir-transcript"
          data-testid="mimir-transcript"
          role="log"
          aria-label="Conversation"
          aria-busy={run.running || undefined}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {transcript.turns.length === 0 ? (
            <div className="mimir-empty">
              <p>Describe a part, or drop a photo of what it fits. {ASSISTANT_NAME} models it here, and every step lands in the timeline, where you can edit or undo it.</p>
            </div>
          ) : (
            <div className="mimir-turns">
              <TranscriptView transcript={transcript} showThinking={false} approvals={handlers} words={stepWords} />
            </div>
          )}
        </div>
      </div>
      <div className="mimir-chat-foot">
        <Composer
          attachments={attachments}
          running={run.running}
          onStop={run.cancel}
          onSend={(text, files) => {
            stick.current = true
            noteMessage(sessionId, text, files)
            run.run(text, { attachments: files })
          }}
        />
      </div>
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
  const step = useStepCaption()
  const drawing = useSheetUi((s) => sheetMode(s) === 'confirm' && (s.shown?.sheet.part?.length ?? 0) > 0)
  if (drawing) {
    return (
      <div className="mimir-caption sx-overlay sx-mono" data-testid="mimir-caption" aria-live="polite">
        Drawing, four views
      </div>
    )
  }
  return (
    <div className="mimir-caption sx-overlay sx-mono" data-testid="mimir-caption" aria-live="polite">
      {step ?? captionFor(preset)}
    </div>
  )
}
