// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for first-run.mjs.
export function finishFirstRun(opts: {
  testids: () => Promise<Record<string, number>>
  click: (testid: string) => Promise<unknown>
  sleep: (ms: number) => Promise<unknown>
  tries?: number
}): Promise<{ done: boolean; ids: Record<string, number> }>
