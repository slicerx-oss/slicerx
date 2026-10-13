// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A mimir cloud refusal keeps its code on the error line, so the app can offer what fits (wait, sign in, a key).
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorLine } from '../ui/index'
import { emptyTranscript, reduceTranscript, startTurn } from '../ui/reduce'

afterEach(cleanup)

describe('the error line', () => {
  it('carries the refusal code from the event to the line', () => {
    const t = reduceTranscript(startTurn(emptyTranscript(), { user: 'Hi' }, 0), { type: 'error', message: 'Used up.', retryable: true, code: 'day_used' }, 0)
    const block = t.turns.at(-1)?.blocks.at(-1)
    expect(block).toMatchObject({ kind: 'error', code: 'day_used' })
    render(<ErrorLine message="Used up." code="day_used" />)
    expect(screen.getByTestId('mimir-limit').dataset['code']).toBe('day_used')
  })

  it('stays plain for any other failure', () => {
    render(<ErrorLine message="Provider timed out" />)
    expect(screen.getByRole('alert').hasAttribute('data-code')).toBe(false)
    expect(screen.queryByTestId('mimir-limit')).toBeNull()
  })
})
