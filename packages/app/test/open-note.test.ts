// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an open or import says (the printer it opened on, "Added cube.stl") shows under the printer card in the left
// pane, with its action and a close button, and never as a toast over the view; warnings stay toasts.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { get, openNote, set } from '../src/state/store'
import { OpenNote } from '../src/workspaces/prepare/open-note'

beforeEach(() => set({ openNote: null, toast: null }))
afterEach(cleanup)

describe('the open note', () => {
  it('is a note in the pane, not a toast', () => {
    openNote("Opened on Bay 2, a P1S 0.4 mm like the project's.")
    expect(get().toast).toBeNull()
    render(createElement(OpenNote))
    expect(screen.getByTestId('open-note-text').textContent).toBe("Opened on Bay 2, a P1S 0.4 mm like the project's.")
  })

  it('runs its action once and goes', () => {
    let changed = 0
    openNote('Opened as P1S 0.2 mm from the project.', { label: 'Change printer', run: () => changed++ })
    render(createElement(OpenNote))
    fireEvent.click(screen.getByTestId('open-note-action'))
    expect(changed).toBe(1)
    expect(get().openNote).toBeNull()
    expect(screen.queryByTestId('open-note')).toBeNull()
  })

  it('closes with its close button, and a newer note takes its place', () => {
    openNote('Added cube.stl')
    render(createElement(OpenNote))
    openNote('Added cone.stl')
    expect(get().openNote?.text).toBe('Added cone.stl')
    fireEvent.click(screen.getByTestId('open-note-dismiss'))
    expect(get().openNote).toBeNull()
  })
})
