// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The command bar's key waits while a modal dialog is open: the dialog is in the top layer over the bar and keeps the page
// behind it inert, so a bar opened under it would be unseen and could not take the focus.
import { afterEach, describe, expect, it } from 'vitest'
import { commandBarMayOpen } from '../src/shell/command-draft'
import { set } from '../src/state/store'

afterEach(() => {
  document.body.innerHTML = ''
  set({ projectsDialog: null })
})

describe('commandBarMayOpen', () => {
  it('is true with no dialog open', () => {
    expect(commandBarMayOpen()).toBe(true)
    document.body.innerHTML = '<dialog></dialog>'
    expect(commandBarMayOpen()).toBe(true)
  })

  it('is false while a dialog is open, and true again once it closes', () => {
    document.body.innerHTML = '<dialog open><h2>Restore unsaved work?</h2></dialog>'
    expect(commandBarMayOpen()).toBe(false)
    document.querySelector('dialog')!.removeAttribute('open')
    expect(commandBarMayOpen()).toBe(true)
  })

  // Right after a reload the restore offer is asked for and its code downloads before the dialog opens. Ctrl+K in that
  // moment opened the bar, and the dialog that showed a moment later took the focus from it.
  it('is false while the restore offer is asked for but its dialog has not opened yet', () => {
    set({ projectsDialog: 'recover' })
    expect(commandBarMayOpen()).toBe(false)
    set({ projectsDialog: null })
    expect(commandBarMayOpen()).toBe(true)
  })
})
