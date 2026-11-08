// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Free mimir's per-minute limit in the chat. A run can wait out several streaks of slow_down in one reply, each with its
// own waiting line. A later line about the limit takes the place of the waiting line of the streak it ends only, the
// last block of the reply; any other line is added at the end, under the work done since. The give-up line stays in
// the history a restored chat gives the model, as it is in the live run.
import type { PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { emptyTranscript, foldEvents, restoredTranscript, startTurn, transcriptTurns, type Block, type Transcript } from '../ui/reduce'

const NOTICE = 'Free mimir hit its limit for this minute, so mimir is waiting a moment, then going on.'
const GIVE_UP = 'Free mimir is still at its limit for this minute, so I stopped here. Say keep going in a minute and I will carry on where I left off.'
const waiting: PilotEvent = { type: 'error', message: NOTICE, retryable: false, code: 'slow_down', waiting: true }
const gaveUp: PilotEvent = { type: 'error', message: GIVE_UP, retryable: true, code: 'slow_down' }
const say = (text: string): PilotEvent[] => [{ type: 'text', delta: text }, { type: 'text_done' }]
const step = (callId: string): PilotEvent[] => [
  { type: 'tool_call', callId, tool: 'geom.extrude', source: 'command', input: {}, args: '' },
  { type: 'tool_result', callId, ok: true, summary: 'Built', ms: 10 },
]

function fold(events: PilotEvent[]): Transcript {
  return foldEvents(events, startTurn(emptyTranscript(), { user: 'A Pi case' }, 0))
}
const lines = (s: Transcript): Block[] => s.turns.at(-1)!.blocks
const shape = (s: Transcript): string[] => lines(s).map((b) => (b.kind === 'error' ? `error:${b.waiting ? 'waiting' : b.message === GIVE_UP ? 'gave_up' : b.message}` : b.kind))

describe('slow_down lines in one reply', () => {
  it('gives the waiting line of the streak that gives up its place', () => {
    expect(shape(fold([...say('Building the base.'), ...step('c1'), waiting, gaveUp]))).toEqual(['say', 'tools', 'error:gave_up'])
  })

  it('adds a second streak at the end and keeps the first where it was', () => {
    const s = fold([...say('Building the base.'), waiting, ...step('c1'), ...step('c2'), ...say('Now the lid.'), waiting])
    expect(shape(s)).toEqual(['say', 'error:waiting', 'tools', 'say', 'error:waiting'])
  })

  it('a second streak that gives up takes the place of its own waiting line, under the work done since the first', () => {
    const s = fold([...say('Building the base.'), waiting, ...step('c1'), ...say('Now the lid.'), waiting, gaveUp])
    expect(shape(s)).toEqual(['say', 'error:waiting', 'tools', 'say', 'error:gave_up'])
  })

  it('a give-up after work done since the waiting line is added at the end', () => {
    const s = fold([waiting, ...step('c1'), gaveUp])
    expect(shape(s)).toEqual(['error:waiting', 'tools', 'error:gave_up'])
  })

  it('a slow_down line with no waiting line before it is added at the end', () => {
    expect(shape(fold([...step('c1'), gaveUp]))).toEqual(['tools', 'error:gave_up'])
  })

  it('a waiting line with another code is not replaced', () => {
    const other: PilotEvent = { type: 'error', message: 'Busy, waiting.', retryable: false, code: 'busy', waiting: true }
    expect(shape(fold([other, gaveUp]))).toEqual(['error:waiting', 'error:gave_up'])
  })
})

describe('the give-up line in a restored chat', () => {
  it('stays in the reply the model is given back, after what mimir said', () => {
    const s = restoredTranscript(fold([...say('Built the base.'), waiting, gaveUp]))
    expect(transcriptTurns(s)).toEqual([{ user: 'A Pi case', reply: `Built the base.\n${GIVE_UP}` }])
  })

  it('leaves out a waiting line the run went on from, and other errors', () => {
    const s = restoredTranscript(fold([waiting, ...say('Built the base.'), { type: 'error', message: 'Network down.', retryable: true }]))
    expect(transcriptTurns(s)).toEqual([{ user: 'A Pi case', reply: 'Built the base.' }])
  })
})
