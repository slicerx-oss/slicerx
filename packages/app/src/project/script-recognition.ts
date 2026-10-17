// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The synchronous recognized-script check for code on the startup path (trustOptions). The rules live in
// script-review.ts, which needs the printer profile data and so loads on demand. That module is the only source of
// review records and registers its check when it loads, so a check that has records always finds it.
import type { ProjectScriptReview } from './script-review'

type Recognize = (key: string, value: unknown, model: string | undefined, overrides: Record<string, unknown>, records: readonly ProjectScriptReview[]) => boolean

let recognize: Recognize | null = null

export function provideScriptRecognition(check: Recognize): void {
  recognize = check
}

/** recognizedScript from script-review.ts, without loading it. No records, or no check loaded, is never recognized. */
export const isRecognizedScript: Recognize = (key, value, model, overrides, records) =>
  records.length > 0 && recognize !== null && recognize(key, value, model, overrides, records)
