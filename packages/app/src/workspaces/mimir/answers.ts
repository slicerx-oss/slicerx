// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab makes its runtime again when its setup changes, and the app's commands change with it: switching to the
// phone layout and back takes the built-in commands away and brings them back, so one switch can make it twice. A run
// that was going keeps going on the runtime that started it, waiting there on its send card, a question or a sheet. The
// chat answers through the newest runtime, so each runtime passes an answer it has no wait for on to every runtime the
// tab replaced that still holds a wait, however many rebuilds back. The wait is found by its own id, and the first
// runtime that takes the answer ends the search, so an answer resolves once. A replaced runtime with nothing going and
// nothing waiting is let go. Nothing here answers on its own: every call still comes from the person's click.
import type { Pilot } from '@slicerx/contracts'

type Answers = Pick<Pilot, 'resolveApproval'> & Partial<Pick<Pilot, 'answer' | 'answerSheet' | 'hold'>> & {
  /** True while the runtime has a run going or a wait open; a runtime that cannot say is kept. */
  waiting?: () => boolean
}

/** Each runtime's own answer calls, before they were made to pass answers on. */
const own = new WeakMap<Pilot, Answers>()
/** The runtimes the tab replaced that still hold a run or a wait, newest last. */
let replaced: Answers[] = []

/** At most this many replaced runtimes are kept, so one stuck on a question nobody answers cannot pile up. */
const KEEP = 8

/** Lets go of replaced runtimes with nothing going and nothing waiting, and of the oldest past `KEEP`. */
function release(): void {
  replaced = replaced.filter((a) => a.waiting?.() !== false).slice(-KEEP)
}

/** Answers `pilot` has no wait for go to the runtimes it replaced, newest first. Returns `pilot`. */
export function answersReachTheirRun(pilot: Pilot): Pilot {
  if (own.has(pilot)) return pilot
  const waiting = (pilot as Pilot & { waiting?: () => boolean }).waiting
  const mine: Answers = {
    resolveApproval: pilot.resolveApproval.bind(pilot),
    ...(pilot.answer ? { answer: pilot.answer.bind(pilot) } : {}),
    ...(pilot.answerSheet ? { answerSheet: pilot.answerSheet.bind(pilot) } : {}),
    ...(pilot.hold ? { hold: pilot.hold.bind(pilot) } : {}),
    ...(typeof waiting === 'function' ? { waiting: waiting.bind(pilot) } : {}),
  }
  own.set(pilot, mine)
  // this runtime first; a runtime that does not know the wait refuses, and the next one back is tried
  const first = async (call: (a: Answers) => Promise<void>): Promise<void> => {
    try {
      await call(mine)
    } catch (e) {
      let taken = false
      for (const old of [...replaced].reverse()) {
        try {
          await call(old)
          taken = true
          break
        } catch {
          // not this runtime's wait
        }
      }
      release()
      if (!taken) throw e
    }
  }
  const missing = (what: string) => Promise.reject(new Error(`No ${what} here`))
  pilot.resolveApproval = (requestId, decision) => first((a) => a.resolveApproval(requestId, decision))
  if (mine.answer) pilot.answer = (askId, choiceId) => first((a) => a.answer?.(askId, choiceId) ?? missing('question'))
  if (mine.answerSheet) pilot.answerSheet = (sheetId, values) => first((a) => a.answerSheet?.(sheetId, values) ?? missing('sheet'))
  // a hold applies where the chat's run is going; a runtime with no run going for the chat ignores it
  if (mine.hold)
    pilot.hold = (sessionId, on) => {
      mine.hold?.(sessionId, on)
      for (const old of replaced) old.hold?.(sessionId, on)
    }
  return pilot
}

/**
 * The tab replaced `pilot`: while a run of its own is going or waits on an answer, the answer reaches it through the
 * newer runtime. One with nothing going and nothing waiting is let go at once.
 */
export function retire(pilot: Pilot): void {
  const answers = own.get(pilot)
  if (answers && !replaced.includes(answers)) replaced = [...replaced, answers]
  release()
}

/** For tests: how many replaced runtimes are still kept. */
export function replacedCount(): number {
  return replaced.length
}

/** For tests: forget the replaced runtimes. */
export function forgetReplaced(): void {
  replaced = []
}
