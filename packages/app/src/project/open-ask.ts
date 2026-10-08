// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project file added to a plate that already has objects asks what to take, as Bambu Studio's ProjectDropDialog
// does: the whole project in place of the plate, or its geometry alone onto it.
import { get, set } from '../state/store'

export type OpenChoice = 'project' | 'geometry'

let pending: ((choice: OpenChoice | null) => void) | null = null

/** Shows the question and waits; null when the person closed it without a choice. */
export function askOpenProject(source: string): Promise<OpenChoice | null> {
  pending?.(null)
  return new Promise((resolve) => {
    pending = resolve
    set({ projectOpenAsk: { source } })
  })
}

/** The dialog's answer. */
export function answerOpenProject(choice: OpenChoice | null): void {
  const r = pending
  pending = null
  if (get().projectOpenAsk) set({ projectOpenAsk: null })
  r?.(choice)
}
