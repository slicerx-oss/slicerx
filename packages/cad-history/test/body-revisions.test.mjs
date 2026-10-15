// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BodyRevisions } from '../src/body-revisions.ts'

test('reads do not advance a revision, but every commit does', () => {
  const ledger = new BodyRevisions()
  const first = ledger.register('body')
  assert.equal(ledger.current('body'), first)
  ledger.assert('body', first)
  const second = ledger.committed('body')
  assert.notEqual(first, second)
  assert.throws(() => ledger.assert('body', first), { code: 'stale_body', currentRevision: second })
  assert.equal(ledger.current('body'), second)
})

test('Undo and Redo cannot revive an earlier reference', () => {
  const ledger = new BodyRevisions()
  const first = ledger.register('body')
  const edit = ledger.committed('body')
  const undo = ledger.committed('body')
  const redo = ledger.committed('body')
  assert.equal(new Set([first, edit, undo, redo]).size, 4)
  for (const stale of [first, edit, undo]) assert.throws(() => ledger.assert('body', stale))
})

test('removal, replacement, another body and another host reject old references', () => {
  const ledger = new BodyRevisions()
  const first = ledger.register('body')
  ledger.register('other')
  assert.throws(() => ledger.assert('other', first))
  ledger.remove('body')
  assert.throws(() => ledger.assert('body', first), { currentRevision: null })
  ledger.register('body')
  assert.throws(() => ledger.assert('body', first))
  const reopened = new BodyRevisions()
  reopened.register('body')
  assert.throws(() => reopened.assert('body', first))
})

test('a commit during asynchronous preparation invalidates its original guard', async () => {
  const ledger = new BodyRevisions()
  const revision = ledger.register('body')
  ledger.assert('body', revision)
  await Promise.resolve().then(() => ledger.committed('body'))
  assert.throws(() => ledger.assert('body', revision), { code: 'stale_body' })
})
