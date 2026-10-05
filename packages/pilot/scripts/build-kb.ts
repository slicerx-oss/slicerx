// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Compiles knowledge/**/*.yaml into src/kb/generated/kb.json so the browser,
// the desktop app and the evals share one index without a YAML parser at
// runtime. Run after knowledge/ changes: pnpm --filter @slicerx/pilot kb:build
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { KbDoc, KbIndex, KbKind, KbPrefix, KbSetting, KbSkill, KbSource } from '../src/kb/kb'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', 'knowledge')
const outFile = join(here, '..', 'src', 'kb', 'generated', 'kb.json')

const KIND: Record<string, KbKind> = {
  filament: 'filament',
  printer: 'printer',
  accessory: 'accessory',
  troubleshoot: 'troubleshoot',
  guide: 'workflow',
  workflow: 'workflow',
  intent_goal: 'intent',
  intent_examples: 'intent',
  intent_tradeoffs: 'intent',
  calibration: 'workflow',
  calibration_plan: 'workflow',
  technique: 'workflow',
}

/** Kinds that are not knowledge for the model (eval suites, the skill catalog). */
const SKIP_KINDS = new Set(['eval_suite'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.ya?ml$/.test(name)) out.push(p)
  }
  return out
}

function collectSources(v: unknown, into: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) collectSources(x, into)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'src') {
        const list = Array.isArray(x) ? x : [x]
        for (const s of list) if (typeof s === 'string') into.add(s)
      } else collectSources(x, into)
    }
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const docs: KbDoc[] = []
const sources: KbSource[] = []
const prefixes: KbPrefix[] = []
let settings: KbSetting[] = []
let skills: KbSkill[] = []
const problems: string[] = []

for (const file of walk(root)) {
  const rel = relative(root, file)
  let data: unknown
  try {
    data = parse(readFileSync(file, 'utf8'))
  } catch (e) {
    problems.push(`${rel}: ${(e as Error).message.split('\n')[0]}`)
    continue
  }
  if (!data || typeof data !== 'object') continue
  const rec = data as Record<string, unknown>
  const kind = str(rec['kind'])
  if (kind === 'sources') {
    for (const p of (rec['prefixes'] as Record<string, unknown>[] | undefined) ?? []) {
      const prefix: KbPrefix = { prefix: String(p['prefix']), title: String(p['title']), urlTemplate: String(p['url_template']) }
      const pub = str(p['publisher'])
      if (pub) prefix.publisher = pub
      prefixes.push(prefix)
    }
    for (const s of (rec['sources'] as Record<string, unknown>[] | undefined) ?? []) {
      const src: KbSource = { id: String(s['id']), title: String(s['title'] ?? s['id']) }
      const pub = str(s['publisher'])
      if (pub) src.publisher = pub
      const url = str(s['url'])
      if (url) src.url = url
      const type = str(s['type'])
      if (type) src.type = type
      sources.push(src)
    }
    continue
  }
  if (kind === 'settings_catalog') {
    settings = ((rec['settings'] as Record<string, unknown>[] | undefined) ?? []).map((s) => {
      const out: KbSetting = { key: String(s['key']), label: String(s['label'] ?? s['key']), scope: s['scope'] as KbSetting['scope'], type: String(s['type']), pilot: (s['pilot'] as KbSetting['pilot']) ?? 'read' }
      if (typeof s['group'] === 'string') out.group = s['group']
      if (typeof s['unit'] === 'string') out.unit = s['unit']
      if (s['bounds'] && typeof s['bounds'] === 'object') out.bounds = s['bounds'] as KbSetting['bounds'] & object
      if (Array.isArray(s['values'])) out.values = (s['values'] as unknown[]).map(String)
      if (typeof s['note'] === 'string') out.note = s['note']
      return out
    })
    continue
  }
  if (kind && SKIP_KINDS.has(kind)) continue
  if (kind === 'skill_catalog') {
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
    skills = ((rec['skills'] as Record<string, unknown>[] | undefined) ?? []).map((k) => ({
      id: String(k['id']),
      name: String(k['name'] ?? k['id']),
      priority: Number(k['priority'] ?? 3),
      purpose: String(k['purpose'] ?? ''),
      inputs: list(k['inputs']),
      outputs: list(k['outputs']),
      tools: list(k['tools']),
      approval: String(k['approval'] ?? 'read'),
      example: String(k['example'] ?? ''),
    }))
    continue
  }
  const k = kind ? KIND[kind] : undefined
  if (!k) {
    problems.push(`${rel}: unknown kind ${String(kind)}`)
    continue
  }
  const id = str(rec['id'])
  if (!id) {
    problems.push(`${rel}: no id`)
    continue
  }
  const srcs = new Set<string>()
  collectSources(rec, srcs)
  const aliases = [...(Array.isArray(rec['aliases']) ? (rec['aliases'] as unknown[]) : []), ...(Array.isArray(rec['phrases']) ? (rec['phrases'] as unknown[]) : [])].map(String)
  docs.push({ kind: k, id, name: str(rec['name']) ?? str(rec['label']) ?? id, aliases, file: rel, data: rec, sources: [...srcs].sort() })
}

const known = new Set(sources.map((s) => s.id))
const prefixSet = new Set(prefixes.map((p) => p.prefix))
const missing = new Set<string>()
for (const d of docs) for (const s of d.sources) if (!known.has(s) && !prefixSet.has(s.split(':')[0] ?? '')) missing.add(s)

const index: KbIndex = { schema: 1, docs, sources, prefixes, settings, skills }
writeFileSync(outFile, `${JSON.stringify(index)}\n`)
const counts = docs.reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {})
console.log(`kb: ${docs.length} docs ${JSON.stringify(counts)}, ${sources.length} sources, ${settings.length} settings, ${skills.length} skills -> ${relative(process.cwd(), outFile)}`)
if (missing.size) console.log(`kb: ${missing.size} cited ids have no source entry: ${[...missing].slice(0, 12).join(', ')}${missing.size > 12 ? ' ...' : ''}`)
if (problems.length) console.log(`kb: skipped ${problems.length} files:\n  ${problems.join('\n  ')}`)
