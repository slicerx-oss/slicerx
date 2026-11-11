// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Enter in mimir's message box never looks dead: while a message cannot go, the box says why in one short line, for
// every reason the send button is off.
import { describe, expect, it } from 'vitest'
import { composerOffNote } from '../src/workspaces/mimir/composer-note'

const go = { connecting: false, notice: false, ready: true, turns: 0 }

describe('the line under the message box', () => {
  it('says nothing while a message can go', () => {
    expect(composerOffNote(go)).toBeUndefined()
    expect(composerOffNote({ ...go, turns: 4 })).toBeUndefined()
  })

  it('points at the connect card with no model connected, and at Settings once the chat has turns', () => {
    expect(composerOffNote({ ...go, connecting: true, ready: false })).toBe('Connect a model above to send this.')
    expect(composerOffNote({ ...go, connecting: true, ready: false, turns: 2 })).toBe('Connect a model in Settings to send this.')
  })

  it('points at Start while the notice before the first mimir cloud chat waits', () => {
    expect(composerOffNote({ ...go, notice: true })).toBe('Press Start above to send this.')
    // the notice is the card on screen even where no model is connected behind it
    expect(composerOffNote({ ...go, notice: true, connecting: true, ready: false })).toBe('Press Start above to send this.')
  })

  it('says mimir is getting ready while the tab sets up its model', () => {
    expect(composerOffNote({ ...go, ready: false })).toBe('mimir is still getting ready. Try again in a moment.')
  })

  it('keeps every line to one short sentence pair, with no dashes and no setting keys', () => {
    for (const s of [{ ...go, connecting: true, ready: false }, { ...go, notice: true }, { ...go, ready: false }]) {
      const line = composerOffNote(s)!
      expect(line.length).toBeLessThan(60)
      expect(line).not.toMatch(/[\u2013\u2014_]/)
    }
  })
})
