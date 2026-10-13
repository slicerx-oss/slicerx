// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A used-up free allowance links to the usage page when the host has one; other refusals and other hosts stay plain.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorLine, UsageLinkContext } from '../ui/index'

afterEach(cleanup)

const line = (code: string | undefined, open: (() => void) | null) =>
  render(
    <UsageLinkContext.Provider value={open}>
      <ErrorLine message="Refused." code={code} />
    </UsageLinkContext.Provider>,
  )

describe('See usage on a limit refusal', () => {
  it.each(['day_used', 'edition_day_used', 'slow_down'])('links %s to the usage page', (code) => {
    const open = vi.fn()
    line(code, open)
    fireEvent.click(screen.getByRole('button', { name: 'See usage' }))
    expect(open).toHaveBeenCalledOnce()
    expect(screen.getByTestId('mimir-see-usage').closest('[data-testid="mimir-limit"]')?.getAttribute('data-code')).toBe(code)
  })

  it.each(['still_answering', 'busy', 'paused', 'provider_error'])('leaves %s without a link', (code) => {
    line(code, vi.fn())
    expect(screen.queryByRole('button', { name: 'See usage' })).toBeNull()
  })

  it('leaves a plain failure and a host with no usage page without a link', () => {
    line(undefined, vi.fn())
    expect(screen.queryByRole('button', { name: 'See usage' })).toBeNull()
    cleanup()
    line('day_used', null)
    expect(screen.queryByRole('button', { name: 'See usage' })).toBeNull()
  })
})
