// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The knowledge base never says one thing in one place and the opposite in another. Each rule names a subject and
// two opposite claims about it; a sentence that makes both (a correction, "matte, not glossy") counts as neither.
import { describe, expect, it } from 'vitest'
import kbIndex from '../src/kb/generated/kb.json' with { type: 'json' }

interface Rule {
  name: string
  about: RegExp
  yes: RegExp
  no: RegExp
  // 'doc': only within one entry, for claims that hold per filament or per printer
  scope: 'kb' | 'doc'
}

const RULES: Rule[] = [
  { name: 'smooth PEI bottom finish', about: /smooth PEI/i, yes: /\bglossy\b/i, no: /\bmatte\b/i, scope: 'kb' },
  { name: 'layer height and strength', about: /layer/i, yes: /\bthick(?:er)? layers?\b[^;]*\b(?:bond|strong)/i, no: /\bthinner\b[^;]*\bstronger\b|\bstronger\b[^;]*\bthinner\b/i, scope: 'doc' },
  // a filament or accessory entry's sentences are about it even when they do not name it
  ...['PLA', 'PETG', 'ABS', 'ASA', 'PC', 'TPU'].map((m): Rule => ({
    name: `layer height and strength for ${m}`,
    about: new RegExp(`^${m}\\b(?![-+ ](?:CF|GF|Silk|Matte|Plus|\\+))`, 'i'),
    yes: /\bthick(?:er)? layers?\b[^;]*\b(?:bond|strong|keep more heat)/i,
    no: /\bthinner\b[^;]*\bstronger\b|\bstronger\b[^;]*\bthinner\b|\blost\b[^;]*\bstrength\b[^;]*\b0\.1 to 0\.3\b/i,
    scope: 'kb',
  })),
  { name: 'TPU in the AMS lite', about: /\bAMS lite\b/i, yes: /^(?!.*\b(?:not|cannot|can't|never)\b).*\bTPU\b[^;]*\b(?:works|feeds|is compatible)\b/i, no: /\bTPU\b[^;]*\b(?:not compatible|incompatible|cannot|can't|never)\b|\b(?:not compatible|incompatible)\b[^;]*\bTPU\b/i, scope: 'kb' },
  { name: 'the AMS lite TPU hardness floor', about: /\bAMS lite\b/i, yes: /\bsofter than 77D\b/i, no: /\b55D\b/i, scope: 'kb' },
  { name: 'PETG on the Cool Plate', about: /\bcool plate\b(?! supertack)/i, yes: /\bPETG\b[^;]*\bcool plate\b[^;]*\b(?:works|good|fine)\b/i, no: /\bPETG\b[^;]*\b(?:not recommended|refuse|never)\b|\b(?:not recommended)\b[^;]*\bPETG\b/i, scope: 'kb' },
  { name: 'PLA on smooth PEI without glue', about: /smooth PEI/i, yes: /\bPLA\b[^;]*\b(?:without glue|no glue)\b|\bexcept PLA\b|\bother than PLA\b/i, no: /\bPLA\b[^;]*\b(?:needs|requires) glue\b/i, scope: 'kb' },
]

interface Said {
  doc: string
  path: string
  text: string
  // what the sentence is about: the filament's name for a filament entry, else the sentence itself
  subject: string
}

function sentences(): Said[] {
  const out: Said[] = []
  const walk = (doc: string, name: string, path: string, v: unknown): void => {
    if (typeof v === 'string') for (const text of v.split(/(?<=[.!?])\s+/)) out.push({ doc, path, text, subject: name ? `${name}: ${text}` : text })
    else if (Array.isArray(v)) v.forEach((x, i) => walk(doc, name, `${path}[${i}]`, x))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(doc, name, path ? `${path}.${k}` : k, x)
  }
  for (const d of kbIndex.docs as { kind: string; id: string; name: string; data: unknown }[]) walk(`${d.kind}/${d.id}`, d.kind === 'filament' || d.kind === 'accessory' ? d.name : '', '', d.data)
  return out
}

describe('the knowledge base does not contradict itself', () => {
  const all = sentences()
  it.each(RULES.map((r) => [r.name, r] as const))('%s', (_, r) => {
    const said = all.filter((s) => r.about.test(s.subject) || r.about.test(s.text))
    const yes = said.filter((s) => r.yes.test(s.text) && !r.no.test(s.text))
    const no = said.filter((s) => r.no.test(s.text) && !r.yes.test(s.text))
    const at = (s: Said) => `${s.doc} ${s.path}: ${s.text}`
    const clash = yes.flatMap((a) => no.filter((b) => r.scope === 'kb' || a.doc === b.doc).map((b) => `${at(a)}\n  vs ${at(b)}`))
    expect(clash).toEqual([])
  })

  it('every rule still finds its subject', () => {
    for (const r of RULES) expect(all.some((s) => r.about.test(s.subject) || r.about.test(s.text)), r.name).toBe(true)
  })
})
