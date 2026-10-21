// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The message box grows with its text: Enter sends, Shift+Enter starts a new line, and an input method's Enter only
// ends its composition. The text goes as typed, new lines and all, and the box empties after sending.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PilotAttachment } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer, COMPOSER_MAX_LINES, enterSends, useAttachments } from '../ui/index'

afterEach(cleanup)

function Harness({ onSend, running = false }: { onSend: (t: string, a: PilotAttachment[]) => void; running?: boolean }) {
  const attachments = useAttachments()
  return <Composer attachments={attachments} onSend={onSend} running={running} />
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
