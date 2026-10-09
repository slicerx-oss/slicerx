// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The wait over the plate while a model opens: nothing for a short wait, the ravens past about 1.2 s until the model's
// first frame, then the wisp until the open is done; the status line names the step.
import { describe, expect, it } from 'vitest'
import type { OpenStage } from '../src/lib/open-timing'
import { markOpenEnded, markOpenStage, markOpenStarted, openStagesPassed } from '../src/lib/open-mark'
import { loadingPhase, loadingWords } from '../src/ravens/loading-phase'

const st = (...s: OpenStage[]) => new Set<OpenStage>(s)

describe('the loading phases', () => {
  it('waits quietly, then the ravens, then the wisp once the model is drawn, then nothing', () => {
    expect(loadingPhase({ loading: true, long: false, stages: st('read') })).toBe('quiet')
    expect(loadingPhase({ loading: true, long: true, stages: st('read', 'parse') })).toBe('ravens')
    expect(loadingPhase({ loading: true, long: true, stages: st('read', 'objects', 'drawn') })).toBe('wisp')
    // a fast import is drawn before the ravens would come: straight to the wisp
    expect(loadingPhase({ loading: true, long: false, stages: st('read', 'drawn') })).toBe('wisp')
    expect(loadingPhase({ loading: false, long: true, stages: st('drawn') })).toBe('off')
  })

  it('names the step', () => {
    expect(loadingWords(st())).toBe('Reading the file')
    expect(loadingWords(st('read', 'parse'))).toBe('Loading the model')
    expect(loadingWords(st('read', 'objects', 'drawn'))).toBe('Checking the model')
    expect(loadingWords(st('read', 'drawn', 'repair'))).toBe('Placing the model')
    expect(loadingWords(st('read', 'drawn', 'settings'))).toBe('Finishing the project')
  })

  it('counts only the stages of an open in progress', () => {
    markOpenStarted('tangela.3mf')
    markOpenStage('read')
    markOpenStage('drawn')
    expect([...openStagesPassed()]).toEqual(['read', 'drawn'])
    markOpenEnded()
    expect(openStagesPassed().size).toBe(0)
    // a frame drawn after the open ended, or a load that is not an open (the example plate), adds nothing
    markOpenStage('drawn')
    expect(openStagesPassed().size).toBe(0)
    expect(loadingPhase({ loading: true, long: true, stages: openStagesPassed() })).toBe('ravens')
  })
})
