// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chat's message box: the files on the message above it, then attach, the text and send. The files live in
// useAttachments, so the column around it can take a dropped file too.
import type { PilotAttachment } from '@slicerx/contracts'
import { Button } from '@slicerx/ui'
import { useId, useState, type FormEvent } from 'react'
import { AttachButton, AttachedFiles, type Attachments } from './attachments'
import { ASSISTANT_NAME } from '../src/name'

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
  const ready = (text.trim() !== '' || attachments.list.length > 0) && !sendOff
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (!ready || running) return
    onSend(text.trim(), attachments.list)
    setText('')
    attachments.clear()
  }
  return (
    <form className="composer sx-overlay" data-testid="mimir-composer" aria-label={`Ask ${ASSISTANT_NAME}`} autoComplete="off" onSubmit={submit}>
      <AttachedFiles attachments={attachments} />
      <div className="composer-row">
        <AttachButton attachments={attachments} />
        <label htmlFor={`${ids}-text`} className="vh">
          Ask {ASSISTANT_NAME}
        </label>
        <input id={`${ids}-text`} className="composer-text" type="text" placeholder={placeholder} spellCheck={false} value={text} onChange={(e) => setText(e.currentTarget.value)} />
        {running ? (
          <Button size="sm" variant="ghost" icon="pause" type="button" aria-label="Stop" onClick={onStop} />
        ) : (
          <Button size="sm" variant={ready ? 'primary' : 'ghost'} icon="send" type="submit" aria-label="Send" disabled={!ready} />
        )}
      </div>
    </form>
  )
}
