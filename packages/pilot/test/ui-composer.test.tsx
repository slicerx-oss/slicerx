// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The message box grows with its text: Enter sends, Shift+Enter starts a new line, and an input method's Enter only
// ends its composition. The text goes as typed, new lines and all, and the box empties after sending. While a question
// card waits, text in the box answers the card in place of a new message.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PilotAttachment } from '@slicerx/contracts'
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
