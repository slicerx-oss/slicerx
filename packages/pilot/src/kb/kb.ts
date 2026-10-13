// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In-memory knowledge base over the index compiled from knowledge/ by
// scripts/build-kb.ts. Lookups are exact on ids and aliases; search is a small
// BM25 over names, aliases and flattened text.
import type { Citation } from '@slicerx/contracts'

export type KbKind = 'filament' | 'printer' | 'accessory' | 'troubleshoot' | 'workflow' | 'intent' | 'other'

export interface KbDoc {
  kind: KbKind
  id: string
  name: string
  aliases: string[]
  /** Path under knowledge/, for diagnostics. */
  file: string
  /** The parsed YAML record. */
  data: Record<string, unknown>
  /** Every source id cited anywhere in the record. */
  sources: string[]
}

export interface KbSource {
  id: string
  title: string
  publisher?: string
  url?: string
  type?: string
}

export interface KbPrefix {
  prefix: string
  title: string
  publisher?: string
  urlTemplate: string
}

export interface KbSetting {
  key: string
  label: string
  group?: string
  scope: 'process' | 'filament' | 'machine'
  type: string
  unit?: string
  pilot: 'edit' | 'guarded' | 'read'
  bounds?: { min?: number; max?: number }
  values?: string[]
  note?: string
}

/** One entry of knowledge/skills.yaml: a multi-step job mimir can run. */
export interface KbSkill {
  id: string
  name: string
  priority: number
  purpose: string
  inputs: string[]
  outputs: string[]
  tools: string[]
  approval: string
  example: string
}

export interface KbIndex {
  schema: 1
  docs: KbDoc[]
  sources: KbSource[]
  prefixes: KbPrefix[]
  settings: KbSetting[]
  skills?: KbSkill[]
}

export interface KbHit {
  doc: KbDoc
  score: number
}

export interface KnowledgeBase {
  readonly size: number
  get(kind: KbKind, idOrAlias: string): KbDoc | undefined
  all(kind: KbKind): KbDoc[]
  search(query: string, opts?: { kinds?: KbKind[]; limit?: number }): KbHit[]
  setting(key: string): KbSetting | undefined
  settings(): KbSetting[]
  /** The skill catalog, in catalog order. */
  skills(): KbSkill[]
  /** Expands source ids and prefixed paths into citations. Unknown ids are dropped. */
  cite(ids: Iterable<string>): Citation[]
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9. +]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'is', 'my', 'it', 'how', 'what', 'why', 'do', 'i', 'at', 'be', 'by', 'from', 'this', 'that', 'should', 'can', 'use'])

// words whose ending is not a suffix
const KEEP = new Set(['string', 'spring', 'ring', 'bring', 'thing', 'during', 'ceiling', 'speed', 'feed', 'need', 'bleed', 'gas', 'pass', 'less', 'glass', 'press', 'stress', 'gloss', 'loss', 'abs', 'pls', 'yes', 'ptfe', 'series', 'always', 'its', 'has', 'was', 'this', 'thus', 'plus', 'bus', 'axis', 'chassis', 'bias'])

/** A light stem, so "strings", "stringing" and "string" meet: drops a plural s, -ing and -ed. */
export function stem(t: string): string {
  if (KEEP.has(t) || /[0-9]/.test(t)) return t
  if (t.endsWith('ing') && t.length > 5) return undouble(t.slice(0, -3))
  if (t.endsWith('ied') && t.length > 4) return `${t.slice(0, -3)}y`
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`
  if (t.endsWith('ed') && t.length > 4 && !t.endsWith('eed')) return undouble(t.slice(0, -2))
  if (t.endsWith('s') && t.length > 3 && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1)
  return t
}

// "shipped" to "ship", "stopping" to "stop"
function undouble(t: string): string {
  return t.length > 3 && t[t.length - 1] === t[t.length - 2] && !/[lsz]/.test(t[t.length - 1]!) ? t.slice(0, -1) : t
}

export function tokenize(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem)
}

function flatten(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'number') out.push(String(v))
  else if (Array.isArray(v)) for (const x of v) flatten(x, out)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'src') continue
      out.push(k)
      flatten(x, out)
    }
  }
}

export function createKnowledgeBase(index: KbIndex): KnowledgeBase {
  const byKey = new Map<string, KbDoc>()
  for (const d of index.docs) {
    byKey.set(`${d.kind}:${norm(d.id)}`, d)
    byKey.set(`${d.kind}:${norm(d.name)}`, d)
    for (const a of d.aliases) {
      const k = `${d.kind}:${norm(a)}`
      if (!byKey.has(k)) byKey.set(k, d)
    }
  }
  const sources = new Map(index.sources.map((s) => [s.id, s]))
  const prefixes = new Map(index.prefixes.map((p) => [p.prefix, p]))
  const settings = new Map(index.settings.map((s) => [s.key, s]))

  // BM25 fields: names and aliases weigh more than body text.
  const docTerms = index.docs.map((d) => {
    const head = tokenize([d.id, d.name, ...d.aliases].join(' '))
    const named = new Set(head)
    const body: string[] = []
    flatten(d.data, body)
    const terms = new Map<string, number>()
    for (const t of head) terms.set(t, (terms.get(t) ?? 0) + 4)
    for (const t of tokenize(body.join(' '))) terms.set(t, (terms.get(t) ?? 0) + 1)
    let len = 0
    for (const n of terms.values()) len += n
    return { d, terms, len, named }
  })
  const avgLen = docTerms.reduce((a, x) => a + x.len, 0) / Math.max(1, docTerms.length)
  const df = new Map<string, number>()
  for (const x of docTerms) for (const t of x.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const N = docTerms.length

  return {
    size: index.docs.length,
    get(kind, idOrAlias) {
      return byKey.get(`${kind}:${norm(idOrAlias)}`)
    },
    all(kind) {
      return index.docs.filter((d) => d.kind === kind)
    },
    search(query, opts = {}) {
      const q = tokenize(query)
      if (q.length === 0) return []
      const kinds = opts.kinds ? new Set(opts.kinds) : null
      const hits: KbHit[] = []
      for (const x of docTerms) {
        if (kinds && !kinds.has(x.d.kind)) continue
        let score = 0
        for (const t of q) {
          const tf = x.terms.get(t)
          if (!tf) continue
          const n = df.get(t) ?? 0
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
          score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (x.len / avgLen)))
          // a word in the entry's own name or aliases says more than any count of it in the body
          if (x.named.has(t)) score += Math.max(idf, 1.5) * 1.5
        }
        if (score > 0) hits.push({ doc: x.d, score })
      }
      hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      return hits.slice(0, opts.limit ?? 5)
    },
    setting(key) {
      return settings.get(key)
    },
    settings() {
      return index.settings
    },
    skills() {
      return index.skills ?? []
    },
    cite(ids) {
      const out: Citation[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const s = sources.get(id)
        if (s) {
          const c: Citation = { id, title: s.title, kind: 'kb' }
          if (s.url) c.url = s.url
          if (s.publisher) c.publisher = s.publisher
          out.push(c)
          continue
        }
        const colon = id.indexOf(':')
        if (colon > 0) {
          const p = prefixes.get(id.slice(0, colon))
          if (p) {
            const path = id.slice(colon + 1)
            const c: Citation = {
              id,
              title: `${p.title}: ${path}`,
              url: p.urlTemplate.replace('{path}', path.split('/').map(encodeURIComponent).join('/')),
              kind: 'kb',
            }
            if (p.publisher) c.publisher = p.publisher
            out.push(c)
          }
        }
      }
      return out
    },
  }
}

export const EMPTY_KB_INDEX: KbIndex = { schema: 1, docs: [], sources: [], prefixes: [], settings: [], skills: [] }
