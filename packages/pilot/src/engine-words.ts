// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Engine refusals in plain words. A failed step's row shows the person what happened in a sentence they can read; the
// model still gets the engine's own text, with how to try again, so it can retry without quoting the engine.

interface Refusal {
  test: RegExp
  /** The step's row, for the person. */
  shown: string
  /** Added to the model's tool result: how to go on. */
  hint: string
}

const REFUSALS: readonly Refusal[] = [
  {
    // boolean.rs storage_mesh: a cut or join whose result only holds at full precision, from faces that line up
    test: /unsafe at mesh storage precision/i,
    shown: 'That cut left slivers too thin to keep, so it was not made; trying it a slightly different way',
    hint: 'The cut or join left faces that line up or slivers. Move or extend the cutting shape about 0.05 mm past the faces it meets and try again. Tell the person in plain words if it still fails; never quote the engine text.',
  },
]

/** The plain line and retry hint for a failed step's text, or undefined when it is not a refusal this knows. */
export function plainRefusal(summary: string): { shown: string; hint: string } | undefined {
  const r = REFUSALS.find((x) => x.test.test(summary))
  return r ? { shown: r.shown, hint: r.hint } : undefined
}
