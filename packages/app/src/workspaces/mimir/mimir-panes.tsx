// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab: the chat on the left and the design's view on the right, loaded as their own chunk when the tab first
// opens. The view is the one Model uses, on the same design and history; this file adds the chat column and the
// caption that names the view. The chat is mimir's one conversation in the app: the top bar's button, the phone's tab
// and Ask mimir in the command bar all open it, and clients reach it over the app link (mimir.ask, mimir.session).
import { SKILL_INFO } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Composer, Inspector, transcriptTurns, TranscriptView, UsageLinkContext, useAttachments, usePilotRun, type ApprovalHandlers, type PartHandlers, type PolicyClass, type Transcript } from '@slicerx/pilot/ui'
import { DEFAULT_POLICY, PERMISSION_LABELS, type ApprovalRequest, type PermissionMode, type PermissionPolicy, type Pilot, type PilotAttachment, type PilotLookup } from '@slicerx/contracts'
import '@slicerx/pilot/ui/pilot.css'
import { Button, Icon, LinkButton, Menu, MenuAnchor, MenuItem, ResizeEdge, tipAttrs } from '@slicerx/ui'
import { RavenMark } from '@slicerx/ui/raven'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { composerOffNote } from './composer-note'
import { setLookups } from './lookups'
import { stepWords } from './step-words'
import { followSteps, useStepCaption, viewStep } from './view-step'
import { newSessionId, noteMessage, startNewChat, tabTools, useTabMimir } from './session'
import { editRow } from './sheet-drive'
import { openSheet, setDraft, setSheetActions, setSheetAside, setShownSheet, sheetMode, useSheetUi, type ShownSheet } from './sheet-ui'
import { hasPicture } from './sheet-shape'
import { CloudNotice, useCloudNoticeDue } from '../../pilot-connect/cloud-notice'
import { cameraBus } from '../../plate/tools'
import { usePaneSize } from '../../shell/pane'
import { setMimirAsker } from '../../app-link/mimir-ask'
import { setMimirCards } from '../../app-link/mimir-dismiss'
import { setTabChat } from '../../app-link/sessions'
import { useHost } from '../../host'
import { usePhoneLayout } from '../../lib/phone-layout'
import { hostSlices } from '../../state/model-mode'
import { get, openSettings, pilotState, set, setCamera, useApp } from '../../state/store'
import { MimirSetup } from '../../pilot-connect/mimir-setup'
import { openUsage } from '../../pilot-connect/usage-open'
import { useMimirLink } from './connection'
import { MimirFilamentPick } from './filament-pick'
import { planChoiceCard } from './plan-card'
import { partHandlers } from './part-actions'
import { MEMORY_CARDS } from './remember-chip'
import { RUN_APPROVAL_CARDS, runCard, runChoiceCard } from './run-cards'
import { cardWaits, openChoice, openSheetCard, waitingCards } from './card-waits'
import { PHONE_REFUSALS, setPhoneCards, syncPhoneQuestion } from './phone-answers'
import { paneApprovalCards, setPhoneApprovals, syncPhoneApprovals } from './phone-approvals'
import './mimir.css'
import './mimir-phone.css'

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

/**
 * Pause and Resume in the chat's header: holds the run before its next step. It never pauses a printer and never
 * answers a waiting card. Off with no run going and none held.
 */
export function HoldButton({ running, held, onHold }: { running: boolean; held: boolean; onHold: (on: boolean) => void }) {
  const label = `${held ? 'Resume' : 'Pause'} ${ASSISTANT_NAME}`
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={held ? 'play' : 'pause'}
      aria-label={label}
      pressed={held}
      data-testid="mimir-pause"
      tip={{ title: label, body: `Holds ${ASSISTANT_NAME} before its next step. A print keeps going.` }}
      disabled={!running && !held}
      onClick={() => onHold(!held)}
    />
  )
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

/** What the empty chat says: parts first, then slicing and printers where the host slices. */
export function emptyNote(slices: boolean): string {
  const parts = `Describe a part, or drop a photo of what it fits. ${ASSISTANT_NAME} models it here, and every step lands in the timeline, where you can edit or undo it.`
  return slices ? `${parts} Ask it to slice, tune settings or check a printer too.` : parts
}

/**
 * Whether a press in the conversation stops the chat following the reply. A button pressed while a reply is still
 * going (a question card's answer or its Cancel, a sheet's Confirm, an approval) answers what is on screen, and the reply
 * it starts appears under it: following that reply would scroll the button out from under the pointer. The chat follows
 * again when the reply puts up a new card for the person (the next question, a size sheet, an approval), once the person
 * scrolls back to the end, or when they send a message. A press with no reply going changes nothing.
 */
export function pressHoldsChat(target: EventTarget | null, running: boolean): boolean {
  return running && target instanceof Element && target.closest('button:not(:disabled)') !== null
}

/**
 * The pill at the foot of the chat: Sizes while a size sheet waits scrolled out of view, else New reply below while a
 * press holds the chat with the reply going on under the fold, else none.
 */
export function chatPill(sheetAway: boolean, replyBelow: boolean): 'sizes' | 'reply' | null {
  return sheetAway ? 'sizes' : replyBelow ? 'reply' : null
}

/** Stands in while the tab sets up its model: nothing to run, and the composer does not send. */
const SETTING_UP: Pilot = {
  tools: () => [],
  run: async function* () {},
  switchMachine: async function* () {},
  resolveApproval: async () => undefined,
  setPolicy: () => undefined,
  policy: () => DEFAULT_POLICY,
}

const MODE_WORD: Record<PermissionMode, string> = { allow: 'Allow', ask: 'Ask first', off: 'Off' }

export function MimirChat({ hidden = false }: { hidden?: boolean }) {
  const max = chatMax(useWindowWidth())
  const [width, setWidth] = usePaneSize('mimir-chat', CHAT_WIDTH.start, { min: CHAT_WIDTH.min, max })
  const [resizing, setResizing] = useState(false)
  const name = designName(useApp((s) => s.projectFile))
  const ref = useRef<HTMLElement>(null)
  const attachments = useAttachments()
  const link = useMimirLink()
  // null for the moment the tab sets up its model; sending waits until it is there. Before a model is connected (and
  // with no mimir cloud to fall back on) the chat is the setup, and nothing is sent.
  const connecting = useApp((s) => pilotState(s) === 'connect') && link === 'scripted'
  const tab = useTabMimir()
  const ready = connecting ? null : tab
  const pilot = ready ?? SETTING_UP
  const [sessionId, setSessionId] = useState(newSessionId)
  const run = usePilotRun(pilot, sessionId)
  const { reset, transcript } = run
  useEffect(() => reset(), [sessionId, reset])
  // mimir.run with no sessionId reads the chat on screen
  useEffect(() => setTabChat(sessionId), [sessionId])
  // a runtime made again (Settings, signing in, the app's commands arriving) picks up the conversation on screen
  const madeFor = useRef(pilot)
  const shown = useRef(transcript)
  shown.current = transcript
  useEffect(() => {
    if (madeFor.current === pilot) return
    madeFor.current = pilot
    const turns = transcriptTurns(shown.current)
    if (turns.length) pilot.resume?.(sessionId, turns)
  }, [pilot, sessionId])
  // On mimir cloud, the first chat waits for the person to read what is sent and kept.
  const notice = useCloudNoticeDue() && transcript.turns.length === 0
  const offNote = composerOffNote({ connecting, notice, ready: ready !== null, turns: transcript.turns.length })
  // every message goes through here, so the read-back lines the person's words up with mimir's runs
  const stick = useRef(true)
  // the cards waiting when a press stopped the chat following the reply, or null while nothing holds it
  const held = useRef<ReadonlySet<string> | null>(null)
  const hold = (target: EventTarget | null): void => {
    if (!pressHoldsChat(target, running.current)) return
    stick.current = false
    held.current = new Set(waitingCards(shown.current))
  }
  // While a press holds the chat and the reply goes on under the fold, a pill says so; it takes the reader to the end.
  const [below, setBelow] = useState(false)
  const readBelow = (): void => {
    const el = body.current
    setBelow(held.current !== null && !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1)
  }
  const toEnd = (): void => {
    const el = body.current
    held.current = null
    stick.current = true
    setBelow(false)
    if (el) el.scrollTop = el.scrollHeight
  }
  const send = (text: string, files: readonly PilotAttachment[] = []): void => {
    if (ready === null || notice) return
    stick.current = true
    held.current = null
    noteMessage(sessionId, text, files)
    run.run(text, files.length ? { attachments: [...files] } : {})
  }
  const sendRef = useRef(send)
  sendRef.current = send
  const running = useRef(run.running)
  running.current = run.running
  // clients' messages arrive over the app link (mimir.ask) as if the person had sent them; a run going is never interrupted
  const live = ready !== null && !notice
  useEffect(() => {
    if (!live) return
    setMimirAsker({
      busy: () => running.current,
      send: (text, files) => {
        sendRef.current(text, files)
        return sessionId
      },
    })
    return () => setMimirAsker(null)
  }, [sessionId, live])
  // a client may turn down the question card waiting here (mimir.dismiss), never pick its answer; a size sheet waiting
  // it sets aside as Return in the message box does, with the sizes typed on it, never confirms
  useEffect(() => {
    if (!live) return
    setMimirCards({
      sessionId: () => sessionId,
      open: () => openChoice(shown.current),
      dismiss: (askId, said) => pilot.answer?.(askId, null, said) ?? Promise.reject(new Error('No question here')),
      sheet: () => openSheetCard(shown.current),
      setAside: (sheetId, said) => setSheetAside(pilot, sheetId, said),
    })
    return () => setMimirCards(null)
  }, [sessionId, live, pilot])
  // a paired phone with the approve right answers the question card the way a click on it does (phone-answers.ts)
  useEffect(() => {
    if (!live) return
    setPhoneCards({
      sessionId: () => sessionId,
      open: () => openChoice(shown.current),
      picked: (askId) => {
        for (const turn of shown.current.turns) for (const b of turn.blocks) if (b.kind === 'choice' && b.askId === askId) return b.picked
        return undefined
      },
      answer: (askId, choiceId) => pilot.answer?.(askId, choiceId) ?? Promise.reject(new Error(PHONE_REFUSALS.gone)),
    })
    return () => setPhoneCards(null)
  }, [sessionId, live, pilot])
  useEffect(() => syncPhoneQuestion(), [transcript])
  // a phone paired on the LAN with the approve right decides the approval cards waiting here, as a click does
  useEffect(() => {
    if (!live) return
    setPhoneApprovals(paneApprovalCards(() => shown.current, pilot))
    return () => setPhoneApprovals(null)
  }, [sessionId, live, pilot])
  useEffect(() => syncPhoneApprovals(), [transcript])
  // Ask mimir in the command bar hands its words over as a message once mimir can take it; each distinct one runs once
  const prompt = useApp((s) => s.pilotPrompt)
  const consumed = useRef<string | null>(null)
  // the chat stays mounted, so the same words asked again later run again
  useEffect(() => {
    if (!prompt) consumed.current = null
  }, [prompt])
  useEffect(() => {
    if (!prompt || !live || notice || consumed.current === prompt || run.running) return
    consumed.current = prompt
    sendRef.current(prompt)
    set({ pilotPrompt: null })
  }, [prompt, live, notice, run.running])
  // the permissions for this conversation's runs, as Skills and permissions sets them
  const [policy, setPolicyState] = useState<PermissionPolicy | null>(null)
  const [more, setMore] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const onPolicy = (cls: PolicyClass, mode: PermissionMode): void => {
    const next: PermissionPolicy = { ...(policy ?? pilot.policy()), classes: { ...(policy ?? pilot.policy()).classes, [cls]: mode } }
    setPolicyState(next)
    pilot.setPolicy(next)
    setAnnouncement(`${PERMISSION_LABELS[cls].title}: ${MODE_WORD[mode]}. Applies from the next step ${ASSISTANT_NAME} takes.`)
  }
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
  const draft = useSheetUi((s) => s.draft)
  const handlers = useMemo<ApprovalHandlers>(
    () => ({
      // a print or a profile change waits for the person here; mimir can neither approve nor skip it
      onApprove: (r: ApprovalRequest, o: { bedClear: boolean }) => pilot.resolveApproval(r.id, o.bedClear ? { kind: 'approve', bedClear: true } : { kind: 'approve' }),
      onCancel: (r: ApprovalRequest) => pilot.resolveApproval(r.id, { kind: 'deny', reason: 'canceled' }),
      onChoose: (askId, choiceId) => pilot.answer?.(askId, choiceId) ?? Promise.resolve(),
      // turning a question down answers it with no pick: the run carries on, unlike Stop
      onDismiss: (askId) => pilot.answer?.(askId, null) ?? Promise.resolve(),
      choiceCard: (p) => planChoiceCard(p) ?? runChoiceCard(p),
      onConfirmSheet: (sheetId, values) => pilot.answerSheet?.(sheetId, values) ?? Promise.resolve(),
      onEditSheet: (_sheetId, key, value) => setDraft(key, value),
      onCancelSheet: (sheetId) => pilot.answerSheet?.(sheetId, null) ?? Promise.resolve(),
      onOpenSheet: openSheet,
      sheetValues: draft,
      // a note mimir wants to keep asks with a small chip, not the full card; the print run has its own cards
      cards: { ...MEMORY_CARDS, ...RUN_APPROVAL_CARDS },
      runCard,
    }),
    [pilot, draft],
  )
  // A part card's body selects its part and Edit opens it (a phone has no modeling tools, so no Edit); its next steps
  // send their request as a message, and offer only what this toolset can do.
  const host = useHost()
  const phone = usePhoneLayout()
  const parts = useMemo<PartHandlers>(
    () => ({ ...partHandlers(host.slicer, phone), onRun: (request: string) => sendRef.current(request), can: (tool: string) => pilot.tools().some((t) => t.name === tool) }),
    [host, phone, pilot],
  )
  // On a phone the view folds to a strip while a card waits for an answer and comes back once it is answered, and the
  // chat's top edge moves with it. `fold` is what the attribute shows: it changes a render after `folds` does, so the
  // line last pressed in the chat (a card's chip or Cancel), or else the conversation's top, is measured while the view
  // is still as it was, and the effect below puts it back in the same frame.
  const folds = phone && cardWaits(transcript)
  const body = useRef<HTMLDivElement>(null)
  const [fold, setFold] = useState(folds)
  const pressed = useRef<Element | null>(null)
  const anchor = useRef<{ el: Element; top: number } | null>(null)
  useLayoutEffect(() => {
    if (folds === fold) return
    const el = body.current
    const at = pressed.current?.isConnected && el?.contains(pressed.current) ? pressed.current : el?.firstElementChild
    anchor.current = at ? { el: at, top: at.getBoundingClientRect().top } : null
    setFold(folds)
  }, [folds, fold])
  // To the end of the chat, except that a size sheet waiting for the person shows from its top when it is taller than
  // the chat: its title and first size in view, never cut off under the header with only its buttons showing.
  const followEnd = (el: HTMLElement): void => {
    el.scrollTop = el.scrollHeight
    const recs = el.querySelectorAll<HTMLElement>('[data-testid="mimir-sheet-record"]')
    const rec = recs[recs.length - 1]
    if (!rec?.querySelector('[data-testid="mimir-sheet-confirm"]')) return
    const over = el.getBoundingClientRect().top - rec.getBoundingClientRect().top
    if (over > 0) el.scrollTop -= over
  }
  // Follows the stream while the reader is at the bottom; leaves them be once they scroll up or press a button in it.
  useLayoutEffect(() => {
    const el = body.current
    // a new card for the person ends a press's hold: the chat goes on to it, as it would have without the press
    if (held.current && waitingCards(transcript).some((id) => !held.current!.has(id))) {
      held.current = null
      stick.current = true
    }
    if (el && stick.current) followEnd(el)
    readBelow()
  }, [transcript])
  // and when the chat itself gets shorter, as it does under a phone's drawing
  useEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current) followEnd(el)
      readBelow()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // A phone's keyboard makes the chat shorter, and the view folding or coming back for it changes it again: the field
  // being typed in, in the conversation or the sizes panel, scrolls back into view with its whole row. This observer is
  // made after the one above, so it runs after it, and following the stream never takes the field out of view.
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stage.current
    if (!el || !phone) return
    const ro = new ResizeObserver(() => {
      const f = document.activeElement
      if (!(f instanceof HTMLElement) || !el.contains(f) || !f.matches('input, textarea')) return
      const row = f.closest<HTMLElement>('li') ?? f
      row.scrollIntoView({ block: 'nearest' })
      // on a record, its Confirm too when it fits in the chat with the row
      const foot = row.closest('[data-testid="mimir-sheet-record"]')?.querySelector<HTMLElement>('.sheet-rec-foot')
      const log = body.current
      if (foot && log && foot.getBoundingClientRect().bottom - row.getBoundingClientRect().top <= log.clientHeight) foot.scrollIntoView({ block: 'nearest' })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [phone])
  // The view coming back makes the chat shorter from the top. The chat scrolls by as much, so the card just answered
  // stays where it was on screen and the button just pressed stays under the finger, at the bottom of the chat or
  // scrolled up. A short conversation cannot scroll that far, so the turns get the room they lack as blank space under
  // the end, which the reply then fills before the chat follows it again. When the view folds for the next card that
  // room goes, and a reader scrolled up keeps the same lines where they were; at the bottom the end stays in view.
  const turns = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    const a = anchor.current
    anchor.current = null
    if (fold && turns.current) turns.current.style.minHeight = ''
    if (!el || !a || !a.el.isConnected) return
    if (fold && stick.current) return
    const to = el.scrollTop + a.el.getBoundingClientRect().top - a.top
    const short = to - (el.scrollHeight - el.clientHeight)
    if (!fold && short > 0 && turns.current) turns.current.style.minHeight = `${turns.current.offsetHeight + short}px`
    el.scrollTop = to
    // still following the end only if the chat is at it, so the observer above does not scroll the card away again
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 1
    pressed.current = null
  }, [fold])
  // a question card waiting in the reply: words in the message box answer it, in the same run
  const open = openChoice(transcript)
  // While a sheet waits and its record is scrolled out of the chat, a pill brings it back.
  const waiting = useSheetUi((s) => (sheetMode(s) === 'confirm' ? s.shown!.sheet.id : null))
  const [away, setAway] = useState(false)
  const recordOf = (id: string | null) => (id ? (body.current?.querySelector<HTMLElement>(`[data-testid="mimir-sheet-record"][data-sheet-id="${CSS.escape(id)}"]`) ?? null) : null)
  useEffect(() => {
    const root = body.current
    const rec = recordOf(waiting)
    if (!root || !rec) {
      setAway(false)
      return
    }
    const io = new IntersectionObserver(([e]) => setAway(!!e && e.intersectionRatio < 0.6), { root, threshold: [0, 0.6, 1] })
    io.observe(rec)
    return () => io.disconnect()
  }, [waiting, transcript])
  const toSizes = () => {
    const rec = recordOf(waiting)
    if (!rec) return
    rec.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    // to the first assumed size, else the first size
    ;(rec.querySelector<HTMLElement>('[data-guess] input') ?? rec.querySelector<HTMLElement>('input'))?.focus({ preventScroll: true })
  }
  const pill = chatPill(waiting !== null && away, below)
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
      data-card-waits={fold || undefined}
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
        {link === 'scripted' && !connecting ? (
        <span className="mimir-chat-scripted" {...tipAttrs({ title: 'Sample replies, no model set up', body: `${ASSISTANT_NAME} plays sample replies here until a model is set up in Settings > mimir. The tools it calls are real.` })}>
          Sample replies
        </span>
        ) : null}
        <HoldButton running={run.running} held={transcript.held} onHold={(on) => pilot.hold?.(sessionId, on)} />
        <Button size="sm" variant="ghost" icon="plus" aria-label="New conversation" tip="pilot.newChat" onClick={() => setSessionId(startNewChat(sessionId))} />
        <ChatMenu more={more} setMore={setMore} thinking={thinking} setThinking={setThinking} />
      </header>
      {more ? (
        <div id="mimir-more" className="mimir-more" data-testid="mimir-more">
          <Inspector transcript={transcript} paused={run.paused} skills={SKILL_INFO.filter((k) => pilot.tools().some((t) => t.name === k.name))} plugins={transcript.plugins ?? []} policy={policy ?? pilot.policy()} onPolicy={onPolicy} />
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div ref={stage} className="mimir-stage" hidden={more}>
        {/* The battle ravens: a faint, still watermark behind the whole conversation, from the empty chat on. */}
        <div className="mimir-ravens" data-testid="mimir-ravens" aria-hidden="true">
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
            held.current = null
            setBelow(false)
          }}
          onPointerDown={(e) => {
            pressed.current = e.target as Element
            hold(e.target)
          }}
          onKeyDown={(e) => {
            pressed.current = e.target as Element
            if (e.key === 'Enter' || e.key === ' ') hold(e.target)
          }}
        >
          {notice ? (
            <div className="mimir-notice">
              <CloudNotice />
            </div>
          ) : transcript.turns.length === 0 && connecting ? (
            <MimirConnect />
          ) : transcript.turns.length === 0 ? (
            <div className="mimir-empty">
              <p>{emptyNote(hostSlices())}</p>
            </div>
          ) : (
            <div ref={turns} className="mimir-turns">
              <UsageLinkContext.Provider value={openUsage}>
                <TranscriptView transcript={transcript} showThinking={thinking} approvals={handlers} words={stepWords} parts={parts} />
              </UsageLinkContext.Provider>
              <MimirFilamentPick transcript={transcript} running={run.running} />
            </div>
          )}
        </div>
        {pill === 'sizes' ? (
          <button type="button" className="mimir-sizes-pill sx-overlay" data-testid="mimir-sizes-pill" onClick={toSizes}>
            <Icon name="tolerance" size={16} />
            <span>Sizes</span>
            <Icon name="chevron-down" size={14} />
          </button>
        ) : pill === 'reply' ? (
          <button type="button" className="mimir-sizes-pill sx-overlay" data-testid="mimir-reply-pill" onClick={toEnd}>
            <span>New reply below</span>
            <Icon name="chevron-down" size={14} />
          </button>
        ) : null}
        {/* on a phone the sizes panel opens here, in the conversation's place (sheet-view.tsx) */}
        {phone ? <div className="mimir-sheet-slot" /> : null}
      </div>
      <div className="mimir-chat-foot" hidden={more}>
        <Composer
          attachments={attachments}
          running={run.running}
          sendOff={ready === null || notice}
          // while sending is off, Enter says why in one line
          {...(offNote ? { offNote } : {})}
          onStop={run.cancel}
          onSend={(text, files) => send(text, files)}
          // a question card takes the words as its answer; a waiting sheet is set aside for them, and its record says so
          answering={open !== null || waiting !== null}
          answers={open === null && waiting !== null ? 'sheet' : 'choice'}
          onAnswer={(text) => {
            // sizes typed on the waiting sheet go along with the words, so setting it aside never drops them
            const landed = open ? pilot.answer?.(open.askId, null, text) : waiting ? setSheetAside(pilot, waiting, text) : undefined
            landed?.catch((e: unknown) => console.warn('mimir: the written answer did not land', e))
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

/**
 * Before a model is connected the chat is the shared mimir setup, the same as in Settings > mimir and first-run, and
 * nothing is sent. A question handed over from the command bar waits and goes once the connection is made.
 */
function MimirConnect() {
  const waiting = useApp((s) => s.pilotPrompt)
  const lead = waiting
    ? `Connect a model and ${ASSISTANT_NAME} answers "${waiting}".`
    : hostSlices()
      ? `Connect a model and ${ASSISTANT_NAME} designs parts, slices them and answers questions about your prints, with changes you approve.`
      : `Connect a model and ${ASSISTANT_NAME} designs parts from a description and answers printing questions.`
  return (
    <div className="mimir-connect" data-testid="mimir-connect">
      <p className="sx-small sx-muted">{lead} Nothing is sent until you connect.</p>
      <MimirSetup place="panel" idPrefix="mimir-ms" />
      <p className="sx-small sx-muted">
        Do not want {ASSISTANT_NAME}? <LinkButton onClick={() => set({ pilot: { mode: 'off' }, pilotPrompt: null })}>Turn it off</LinkButton>. You can turn it back on in Settings.
      </p>
    </div>
  )
}

/**
 * The header's More menu: Skills and permissions (what mimir may do in this conversation, in place of the chat until
 * closed), Show thinking, and the model setup in Settings.
 */
function ChatMenu(p: { more: boolean; setMore: (v: boolean) => void; thinking: boolean; setThinking: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <MenuAnchor className="mimir-chat-more">
      <Button size="sm" variant="ghost" icon="more" aria-label="More" aria-haspopup="menu" aria-expanded={open} data-testid="mimir-chat-more" onClick={() => setOpen(!open)} />
      <Menu open={open} onClose={() => setOpen(false)} label="More" align="end" testId="mimir-chat-menu">
        <MenuItem icon={p.more ? 'arrow-left' : 'skill'} aria-controls="mimir-more" onClick={() => (setOpen(false), p.setMore(!p.more))}>
          {p.more ? 'Back to the conversation' : 'Skills and permissions'}
        </MenuItem>
        <MenuItem icon="sparkle" checked={p.thinking} data-testid="mimir-chat-thinking" onClick={() => (setOpen(false), p.setThinking(!p.thinking))}>
          Show thinking
        </MenuItem>
        <MenuItem icon="plugin" onClick={() => (setOpen(false), openSettings('pilot'))}>
          Connect a model
        </MenuItem>
      </Menu>
    </MenuAnchor>
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
  const waitingSheet = useSheetUi((s) => (sheetMode(s) === 'confirm' ? (s.shown?.sheet ?? null) : null))
  // only whether a drawing is up: the sheet's own solids, or its design on the plate, without shaping the part here
  const drawing = useApp((s) => hasPicture(waitingSheet, waitingSheet?.design ? s.plate.filter((p) => p.id === waitingSheet.design) : []))
  return (
    <div className="mimir-caption sx-overlay sx-mono" data-testid="mimir-caption" aria-live="polite">
      {drawing ? 'Drawing, four views' : (step ?? captionFor(preset))}
    </div>
  )
}
