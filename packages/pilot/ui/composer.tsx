// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chat's message box: the files on the message above it, then attach, the text and send. The files live in
// useAttachments, so the column around it can take a dropped file too. The text grows a line at a time as it wraps, up
// to COMPOSER_MAX_LINES, then scrolls inside, so a long message reads from its start. Enter sends; Shift+Enter starts a
// new line.
import type { PilotAttachment } from '@slicerx/contracts'
import { Button } from '@slicerx/ui'
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AttachButton, AttachedFiles, type Attachments } from './attachments'
import { ASSISTANT_NAME } from '../src/name'

/** The most lines the message box grows to before it scrolls inside (pilot.css caps its height to match). */
export const COMPOSER_MAX_LINES = 6

/**
 * Whether a key press in the message box sends: Enter alone does. Shift+Enter types a new line, and Enter that ends an
 * input method's composition (a Japanese or Chinese keyboard picking its characters) does neither.
 */
export function enterSends(e: { key: string; shiftKey: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229
}

export interface ComposerProps {
  attachments: Attachments
  onSend: (text: string, attachments: PilotAttachment[]) => void
  /** A reply is streaming: send turns into stop. */
  running?: boolean
  onStop?: () => void
  /** Sending is off, for example while nothing can answer yet; typing and attaching still work. */
  sendOff?: boolean
  placeholder?: string
}

export function Composer({ attachments, onSend, running = false, onStop, sendOff = false, placeholder = `Ask ${ASSISTANT_NAME}` }: ComposerProps) {
  const ids = useId()
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const ready = (text.trim() !== '' || attachments.list.length > 0) && !sendOff
  // The box is as tall as its text; the stylesheet's max-height stops it at COMPOSER_MAX_LINES and it scrolls from there.
  // It measures again when its width changes, since the same text wraps to more or fewer lines.
  const fit = (): void => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }
  useLayoutEffect(fit, [text])
  useLayoutEffect(() => {
    const el = field.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (!ready || running) return
    onSend(text.trim(), attachments.list)
    setText('')
    attachments.clear()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!enterSends({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return
    e.preventDefault()
    e.currentTarget.form?.requestSubmit()
  }
  return (
    <form className="composer sx-overlay" data-testid="mimir-composer" aria-label={`Ask ${ASSISTANT_NAME}`} autoComplete="off" onSubmit={submit}>
      <AttachedFiles attachments={attachments} />
      <div className="composer-row">
        <AttachButton attachments={attachments} />
        <label htmlFor={`${ids}-text`} className="vh">
          Ask {ASSISTANT_NAME}
        </label>
        <textarea
          ref={field}
          id={`${ids}-text`}
          className="composer-text"
          rows={1}
          enterKeyHint="send"
          placeholder={placeholder}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <Button size="sm" variant="ghost" icon="pause" type="button" aria-label="Stop" onClick={onStop} />
        ) : (
          <Button size="sm" variant={ready ? 'primary' : 'ghost'} icon="send" type="submit" aria-label="Send" disabled={!ready} />
        )}
      </div>
    </form>
  )
}
