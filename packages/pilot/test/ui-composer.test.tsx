// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The message box grows with its text: Enter sends, Shift+Enter starts a new line, and an input method's Enter only
// ends its composition. The text goes as typed, new lines and all, and the box empties after sending. While a question
// card waits, text in the box answers the card in place of a new message.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PilotAttachment } from '@slicerx/contracts'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer, COMPOSER_MAX_LINES, enterSends, useAttachments } from '../ui/index'

afterEach(cleanup)

function Harness({ onSend, running = false, answering, onAnswer, onStop }: { onSend: (t: string, a: PilotAttachment[]) => void; running?: boolean; answering?: boolean; onAnswer?: (t: string) => void; onStop?: () => void }) {
  const attachments = useAttachments()
  return <Composer attachments={attachments} onSend={onSend} running={running} {...(answering === undefined ? {} : { answering })} {...(onAnswer ? { onAnswer } : {})} {...(onStop ? { onStop } : {})} />
}

describe('enterSends', () => {
  it('sends on Enter alone', () => {
    expect(enterSends({ key: 'Enter', shiftKey: false })).toBe(true)
  })

  it('types a new line on Shift+Enter or Alt+Enter, and leaves other keys alone', () => {
    expect(enterSends({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(enterSends({ key: 'Enter', shiftKey: false, altKey: true })).toBe(false)
    expect(enterSends({ key: 'a', shiftKey: false })).toBe(false)
  })

  it('never sends on the Enter that ends an input method composition', () => {
    expect(enterSends({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(enterSends({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false)
  })
})

describe('the message box', () => {
  it('is a text area that starts one line tall and grows to six lines at most', () => {
    render(<Harness onSend={vi.fn()} />)
    const box = screen.getByRole('textbox')
    expect(box.tagName).toBe('TEXTAREA')
    expect(box.getAttribute('rows')).toBe('1')
    expect(COMPOSER_MAX_LINES).toBe(6)
  })

  it('sends on Enter and empties, with a new line from Shift+Enter kept in the text', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'A wall plate 120 by 80 mm' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: 'A wall plate 120 by 80 mm\nwith two screw holes' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe('A wall plate 120 by 80 mm\nwith two screw holes')
    expect(box.value).toBe('')
  })

  it('does not send an empty message or while a reply is streaming', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Harness onSend={onSend} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    rerender(<Harness onSend={onSend} running />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Make it taller' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('the message box while a question card waits', () => {
  const button = () => screen.getAllByRole('button').at(-1) as HTMLButtonElement

  it('shows Stop while empty, and Send once there is text; Enter answers the card and not a new message', () => {
    const onSend = vi.fn()
    const onAnswer = vi.fn()
    const onStop = vi.fn()
    render(<Harness onSend={onSend} running answering onAnswer={onAnswer} onStop={onStop} />)
    expect(button().getAttribute('aria-label')).toBe('Stop')
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '  it is a different model  ' } })
    expect(button().getAttribute('aria-label')).toBe('Send')
    expect(button().disabled).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith('it is a different model')
    expect(onSend).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(box.value).toBe('')
    expect(button().getAttribute('aria-label')).toBe('Stop')
    fireEvent.click(button())
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('keeps Send off with files attached: an answer is words only', () => {
    const onAnswer = vi.fn()
    const file: PilotAttachment = { id: 'f1', name: 'photo.jpg', type: 'image/jpeg', bytes: 10, url: 'data:image/jpeg;base64,AA==' }
    const attachments = { list: [file], problems: [], add: async () => undefined, remove: () => undefined, clear: () => undefined }
    render(<Composer attachments={attachments} onSend={vi.fn()} running answering onAnswer={onAnswer} />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'this one' } })
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('still drops a message while a reply runs with no card waiting', () => {
    const onSend = vi.fn()
    const onAnswer = vi.fn()
    render(<Harness onSend={onSend} running answering={false} onAnswer={onAnswer} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Make it taller' } })
    expect(button().getAttribute('aria-label')).toBe('Stop')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe('the message box while a dimension sheet waits', () => {
  it('says the words go to mimir, and Enter hands them over in place of a new message', () => {
    const onSend = vi.fn()
    const onAnswer = vi.fn()
    const attachments = { list: [], problems: [], add: async () => undefined, remove: () => undefined, clear: () => undefined }
    render(<Composer attachments={attachments} onSend={onSend} running answering answers="sheet" onAnswer={onAnswer} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(box.placeholder).toBe('Or tell mimir what to change')
    expect(box.closest('form')!.getAttribute('data-answers')).toBe('sheet')
    fireEvent.change(box, { target: { value: 'make it 10 mm taller' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith('make it 10 mm taller')
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('')
  })

  it('says why Enter does nothing while a file is attached, instead of doing nothing silently', () => {
    const onAnswer = vi.fn()
    const file: PilotAttachment = { id: 'f1', name: 'photo.png', type: 'image/png', bytes: 10, url: 'data:image/png;base64,AA==' }
    const attachments = { list: [file], problems: [], add: async () => undefined, remove: () => undefined, clear: () => undefined }
    render(<Composer attachments={attachments} onSend={vi.fn()} running answering answers="sheet" onAnswer={onAnswer} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(screen.queryByTestId('mimir-composer-files-note')).toBeNull()
    fireEvent.change(box, { target: { value: 'make it taller' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()
    expect(screen.getByTestId('mimir-composer-files-note').textContent).toBe('Files cannot go with an answer. Remove them to send.')
  })
})

describe('the message box under fast typing', () => {
  /** Re-renders the box every millisecond, flipping it between running and not, as a streaming reply does. */
  function Busy({ onSend }: { onSend: (t: string, a: PilotAttachment[]) => void }) {
    const attachments = useAttachments()
    const [tick, setTick] = useState(0)
    useEffect(() => {
      const t = setInterval(() => setTick((n) => n + 1), 1)
      return () => clearInterval(t)
    }, [])
    return <Composer attachments={attachments} onSend={onSend} running={tick % 2 === 0} />
  }

  it('keeps every character typed in bursts between renders, in order', async () => {
    render(<Busy onSend={vi.fn()} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const text = 'Design a Raspberry Pi 5 case: a base with four standoffs, port cutouts and a snap-fit lid.'
    // keys land as the browser lands them: each one in the box with its input event, several between two renders
    for (const [i, ch] of [...text].entries()) {
      setValue.call(box, box.value + ch)
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }))
      if (i % 7 === 6) await new Promise((r) => setTimeout(r, 0))
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(box.value).toBe(text)
  })
})

describe('sending while it is off', () => {
  function Off({ onSend, offNote, sendOff = true }: { onSend: (t: string, a: PilotAttachment[]) => void; offNote?: string; sendOff?: boolean }) {
    const attachments = useAttachments()
    return <Composer attachments={attachments} onSend={onSend} sendOff={sendOff} {...(offNote ? { offNote } : {})} />
  }

  it('says why on Enter, keeps the text and sends nothing', () => {
    const onSend = vi.fn()
    render(<Off onSend={onSend} offNote="Connect a model above to send this." />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
    fireEvent.change(box, { target: { value: 'A hook for my bike' } })
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('A hook for my bike')
    const note = screen.getByTestId('mimir-composer-off-note')
    expect(note.textContent).toBe('Connect a model above to send this.')
    expect(note.getAttribute('role')).toBe('status')
  })

  it('stays quiet with no note given, on an empty box, and once sending is on again', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Off onSend={onSend} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'A hook' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
    rerender(<Off onSend={onSend} offNote="Connect a model above to send this." />)
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
    fireEvent.change(box, { target: { value: 'A hook' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('mimir-composer-off-note')).toBeTruthy()
    rerender(<Off onSend={onSend} offNote="Connect a model above to send this." sendOff={false} />)
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
  })

  it('does not bring the line back by itself after the box empties or sending was on', () => {
    const onSend = vi.fn()
    const note = 'Connect a model above to send this.'
    const { rerender } = render(<Off onSend={onSend} offNote={note} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'A hook' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('mimir-composer-off-note')).toBeTruthy()
    // emptied, then typed again: quiet until Enter is pressed again
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.change(box, { target: { value: 'A hook for a bike' } })
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('mimir-composer-off-note').textContent).toBe(note)
    // sending on, then off again with the same text: quiet again
    rerender(<Off onSend={onSend} offNote={note} sendOff={false} />)
    rerender(<Off onSend={onSend} offNote={note} />)
    expect(screen.queryByTestId('mimir-composer-off-note')).toBeNull()
  })
})

