// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chat's message box: the files on the message above it, then attach, the text and send. The files live in
// useAttachments, so the column around it can take a dropped file too.
import type { PilotAttachment } from '@slicerx/contracts'
import { Button } from '@slicerx/ui'
import { useCallback, useId, useRef, useState, type FormEvent } from 'react'
import { ATTACH_ACCEPT, AttachmentChip, readAttachments } from './attachments'
import { ASSISTANT_NAME } from '../src/name'

export interface Attachments {
  list: PilotAttachment[]
  /** What the last add left out, and why. */
  problems: string[]
  add: (files: readonly File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
}

export function useAttachments(): Attachments {
  const [list, setList] = useState<PilotAttachment[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const count = useRef(0)
  count.current = list.length
  const add = useCallback(async (files: readonly File[]) => {
    const { added, problems: p } = await readAttachments(files, count.current)
    count.current += added.length
    setList((l) => [...l, ...added])
    setProblems(p)
  }, [])
  const remove = useCallback((id: string) => {
    setList((l) => l.filter((a) => a.id !== id))
    setProblems([])
  }, [])
  const clear = useCallback(() => {
    setList([])
    setProblems([])
  }, [])
  return { list, problems, add, remove, clear }
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
  const file = useRef<HTMLInputElement>(null)
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
      {attachments.list.length ? (
        <div className="att-row" aria-label="Attached">
          {attachments.list.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={() => attachments.remove(a.id)} />
          ))}
        </div>
      ) : null}
      {attachments.problems.length ? (
        <div className="composer-note" role="status">
          {attachments.problems.join(' ')}
        </div>
      ) : null}
      <div className="composer-row">
        <Button size="sm" variant="ghost" icon="plus" type="button" aria-label="Attach a file" tip="pilot.attach" data-testid="mimir-attach" onClick={() => file.current?.click()} />
        <input
          ref={file}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            void attachments.add(files)
          }}
        />
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
