// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The remember chip when its answer cannot be delivered: it says plainly that nothing was saved, with no internal
// reason or id, and its buttons go, since the request is gone and asking again makes a new chip.
import type { ApprovalRequest } from '@slicerx/contracts'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMEMBER_INACTIVE, RememberChip } from '../src/workspaces/mimir/remember-chip'

afterEach(cleanup)

const REQ: ApprovalRequest = {
  id: 'apr_mem_1',
  sessionId: 's',
  tool: 'memory.remember',
  permission: 'profile',
  title: 'Remember this?',
  lines: ['Has a Bambu Lab A1', 'Kept on this computer'],
  paramsHash: 'h',
  actions: [],
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
}

describe('the remember chip', () => {
  for (const which of ['Remember', 'Not now'] as const) {
    it(`${which} that cannot be delivered says nothing was saved, with no internal id, and takes no more answers`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const onApprove = vi.fn(async () => Promise.reject(new Error(`No pending approval ${REQ.id}`)))
      const onCancel = vi.fn(async () => Promise.reject(new Error(`No pending approval ${REQ.id}`)))
      render(createElement(RememberChip, { request: REQ, resolution: null, actionable: true, onApprove, onCancel }))
      const chip = screen.getByTestId('mimir-remember')
      fireEvent.click(within(chip).getByRole('button', { name: which }))
      await waitFor(() => expect(within(chip).getByRole('status').textContent).toBe(REMEMBER_INACTIVE))
      expect(REMEMBER_INACTIVE).toBe('Nothing saved. Ask mimir again.')
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: `No pending approval ${REQ.id}` }))
      const text = chip.textContent ?? ''
      expect(text).not.toContain(REQ.id)
      expect(text).not.toMatch(/No pending approval|Could not send/)
      // the buttons sit in an inert cell, so neither can be pressed again
      expect(within(chip).getByRole('button', { name: 'Remember', hidden: true }).closest('[inert]')).not.toBeNull()
      expect(onApprove.mock.calls.length + onCancel.mock.calls.length).toBe(1)
      warn.mockRestore()
    })
  }
})
