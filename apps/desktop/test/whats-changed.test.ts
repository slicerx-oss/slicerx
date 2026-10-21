// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release notes' "What changed" list: commit trailers in since..to, and user-facing pull requests whose merge
// commit is in that range, so notes cut at an older commit leave out what merged after it. git and gh are stubbed.
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error a plain .mjs release script, no types
import { inRange, whatsChanged } from '../release/whats-changed.mjs'

const hash = (n: number) => String(n).repeat(40).slice(0, 40)
type Commit = { n: number; note?: string; urgent?: string }
const record = (c: Commit) => [hash(c.n), hash(c.n).slice(0, 9), c.note ?? '', '', c.urgent ?? '', ''].join('\u001f') + '\u001e'

// commits 2 and 3 are in desktop-v0.2.9..to; 4 merged after `to`
const dates: Record<string, string> = { 'desktop-v0.2.9': '2026-10-20T00:00:00Z', [hash(3)]: '2026-10-21T00:00:00Z', HEAD: '2026-10-22T00:00:00Z' }
const git = (log: Commit[]) => (...args: string[]) => {
  if (args[0] === 'tag') return 'desktop-v0.2.9\ndesktop-v0.2.8'
  if (args[0] === 'log' && args[1] === '-1') return dates[args[3]!]!
  if (args[0] === 'log') return log.map(record).join('\n')
  throw new Error(`unexpected git ${args.join(' ')}`)
}
const pr = (number: number, merged: number | null, mergedAt: string, labels = ['user-facing']) => ({
  number,
  title: `PR ${number}`,
  body: `## For users\n- Change ${number}\n`,
  url: `https://example.test/pull/${number}`,
  labels: labels.map((name) => ({ name })),
  mergeCommit: merged === null ? null : { oid: hash(merged) },
  mergedAt,
})

describe('whats-changed', () => {
  it('keeps a pull request only when its merge commit is in the range', () => {
    const prs = [pr(10, 2, '2026-10-20T06:00:00Z'), pr(11, 4, '2026-10-21T06:00:00Z')]
    expect(inRange(prs, [hash(2), hash(3)], dates[hash(3)]).map((p: { number: number }) => p.number)).toEqual([10])
  })

  it('falls back to the merge date for a pull request without a merge commit', () => {
    const prs = [pr(12, null, '2026-10-20T12:00:00Z'), pr(13, null, '2026-10-21T12:00:00Z'), { ...pr(14, null, ''), mergedAt: undefined }]
    expect(inRange(prs, [], '2026-10-21T00:00:00Z').map((p: { number: number }) => p.number)).toEqual([12])
  })

  it('leaves out what merged after --to and reads the pull requests merged since the tag', () => {
    const gh = vi.fn((..._args: string[]) => JSON.stringify([pr(10, 2, '2026-10-20T06:00:00Z'), pr(11, 4, '2026-10-21T06:00:00Z'), pr(15, 3, '2026-10-20T09:00:00Z', ['urgent'])]))
    const r = whatsChanged({ to: hash(3), git: git([{ n: 3, note: 'Trailer note' }, { n: 2 }]), gh })
    expect(r.since).toBe('desktop-v0.2.9')
    expect(r.notes.map((n: { note: string; ref: string }) => [n.note, n.ref])).toEqual([['Trailer note', hash(3).slice(0, 9)], ['Change 10', '#10']])
    expect(r.urgent).toEqual([{ why: 'PR 15', ref: '#15' }])
    expect(gh).toHaveBeenCalledTimes(1)
    expect(gh.mock.calls[0]).toContain('merged:>2026-10-20T00:00:00Z')
  })

  it('takes commit trailers only when gh cannot be read', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gh = () => {
      throw new Error('gh: not found')
    }
    const r = whatsChanged({ git: git([{ n: 4, note: 'Later note', urgent: 'Crash on open' }]), gh })
    expect(r.notes.map((n: { note: string }) => n.note)).toEqual(['Later note'])
    expect(r.urgent).toEqual([{ why: 'Crash on open', ref: hash(4).slice(0, 9) }])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('commit trailers only'))
    err.mockRestore()
  })
})
