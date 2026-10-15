// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BodyRevisionObserver } from '../src/body-revision-observer.ts'

const body = id => ({ id, parts: [], history: {}, transform: [1, 0, 0, 1] })

test('an edit and Undo between reads cannot restore the old revision', () => {
  const observer = new BodyRevisionObserver(), original = body('part')
  observer.observe([original])
  const revision = observer.revisions.current('part')
  observer.observe([{ ...original, parts: [] }])
  observer.observe([original])
  assert.throws(() => observer.revisions.assert('part', revision), { code: 'stale_body' })
})

test('selection, color and sibling changes preserve the unaffected body revision', () => {
  const observer = new BodyRevisionObserver(), original = body('part'), other = body('other')
  observer.observe([original, other])
  const revision = observer.revisions.current('part')
  observer.observe([{ ...original, colors: ['red'] }, { ...other, parts: [] }])
  observer.revisions.assert('part', revision)
})

test('placement snapshots detect edits even when the original matrix is reused', () => {
  const observer = new BodyRevisionObserver(), original = body('part')
  observer.observe([original])
  const revision = observer.revisions.current('part')
  original.transform[3] = 2
  observer.observe([original])
  assert.throws(() => observer.revisions.assert('part', revision))
})

test('removal and restore of the same object invalidate its references', () => {
  const observer = new BodyRevisionObserver(), original = body('part')
  observer.observe([original])
  const revision = observer.revisions.current('part')
  observer.observe([])
  assert.throws(() => observer.revisions.assert('part', revision), { currentRevision: null })
  observer.observe([original])
  assert.throws(() => observer.revisions.assert('part', revision))
})
