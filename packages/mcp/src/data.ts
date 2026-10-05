// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finds and loads the data files the server reads: the knowledge base, the
// guides, and the simulated printers.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { SettingDef } from '@slicerx/contracts'
import { SETTINGS, settingDef } from '@slicerx/settings'

export interface DataPaths {
  root: string
  layout: 'repo' | 'packaged'
  knowledgeDir: string
  demoFleetFile: string
  /** Folder holding built-in sample models such as x-mark.stl. */
  samplesDir: string
}

/** Layout of the published package: `data/` next to `dist/`, filled by scripts/build.mjs. */
function packagedPaths(root: string): DataPaths {
  return {
    root,
    layout: 'packaged',
    knowledgeDir: join(root, 'knowledge'),
    demoFleetFile: join(root, 'connect', 'demo-fleet.json'),
    samplesDir: join(root, 'samples'),
  }
}

/** Layout of the monorepo checkout. */
function repoPaths(root: string): DataPaths {
  return {
    root,
    layout: 'repo',
    knowledgeDir: join(root, 'knowledge'),
    demoFleetFile: join(root, 'packages', 'connect', 'fixtures', 'demo-fleet.json'),
    samplesDir: join(root, 'packages', 'core', 'bench', 'models'),
  }
}

const usable = (p: DataPaths): boolean => existsSync(join(p.knowledgeDir, 'settings.yaml')) && existsSync(p.demoFleetFile)

/**
 * Resolves data paths in this order: an explicit directory (flag or
 * SLICERX_DATA_DIR) in either layout, the monorepo root found by walking up
 * from this file, then the package's own `data/`.
 */
export function resolveDataPaths(explicit?: string): DataPaths {
  return findDataPaths(explicit)
}

function findDataPaths(explicit?: string): DataPaths {
  if (explicit !== undefined) {
    const root = resolve(explicit)
    for (const p of [packagedPaths(root), repoPaths(root)]) if (usable(p)) return p
    throw new Error(`No SlicerX data in ${root}: expected knowledge/settings.yaml and the simulated printer fixture`)
  }
  // A clone wins over the package's copied data/, so running from source sees the live files.
  const start = dirname(fileURLToPath(import.meta.url))
  for (const layout of [repoPaths, (d: string) => packagedPaths(join(d, 'data'))]) {
    let dir = start
    for (let i = 0; i < 6; i++) {
      const p = layout(dir)
      if (usable(p)) return p
      dir = dirname(dir)
    }
  }
  throw new Error('Could not find the SlicerX data files. Pass --data-dir or set SLICERX_DATA_DIR.')
}

export type KnowledgeKind = 'filament' | 'printer' | 'accessory' | 'troubleshoot' | 'guide' | 'settings_catalog' | 'skill_catalog' | 'sources'

export interface KnowledgeEntry {
  kind: KnowledgeKind
  id: string
  name: string
  aliases: string[]
  /** Path relative to the knowledge directory, with forward slashes. */
  path: string
  data: Record<string, unknown>
  text: string
}

export interface SourceRef {
  id: string
  title?: string
  url?: string
}

export interface CatalogEntry {
  key: string
  label?: string
  group?: string
  scope?: string
  type?: string
  unit?: string
  pilot?: string
  bounds?: { min?: number; max?: number }
  values?: string[]
  note?: string
}

function listYaml(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listYaml(full))
    else if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(full)
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export const normalizeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Everything the tools read, loaded once and kept in memory (a few MB at most). */
export class DataStore {
  readonly paths: DataPaths
  private entries: KnowledgeEntry[] | undefined
  private catalog: Map<string, CatalogEntry> | undefined
  private sources: Map<string, SourceRef> | undefined
  private prefixes: Map<string, string> | undefined

  constructor(paths: DataPaths) {
    this.paths = paths
  }

  knowledge(): KnowledgeEntry[] {
    if (this.entries) return this.entries
    const entries: KnowledgeEntry[] = []
    for (const file of listYaml(this.paths.knowledgeDir)) {
      const text = readFileSync(file, 'utf8')
      const data: unknown = parseYaml(text)
      if (!isRecord(data)) continue
      const kind = typeof data['kind'] === 'string' ? (data['kind'] as KnowledgeKind) : undefined
      if (kind === undefined) continue
      const rel = relative(this.paths.knowledgeDir, file).split(sep).join('/')
      const fallbackId = rel.replace(/\.ya?ml$/, '').replace(/\//g, '_')
      const id = typeof data['id'] === 'string' ? data['id'] : fallbackId
      const name = typeof data['name'] === 'string' ? data['name'] : id
      const aliases = Array.isArray(data['aliases']) ? data['aliases'].filter((a): a is string => typeof a === 'string') : []
      entries.push({ kind, id, name, aliases, path: rel, data, text })
    }
    this.entries = entries
    return entries
  }

  /** Finds a knowledge entry by id, name or alias, ignoring case and punctuation. */
  findKnowledge(kinds: KnowledgeKind[], query: string): KnowledgeEntry | undefined {
    const q = normalizeId(query)
    const pool = this.knowledge().filter((e) => kinds.includes(e.kind))
    return (
      pool.find((e) => normalizeId(e.id) === q) ??
      pool.find((e) => normalizeId(e.name) === q) ??
      pool.find((e) => e.aliases.some((a) => normalizeId(a) === q)) ??
      pool.find((e) => normalizeId(e.name).includes(q) || q.includes(normalizeId(e.id)))
    )
  }

  /** The settings schema comes from @slicerx/settings so every surface reads one copy. */
  settingsSchema(): readonly SettingDef[] {
    return SETTINGS
  }

  setting(key: string): SettingDef | undefined {
    return settingDef(key)
  }

  /** knowledge/settings.yaml: Pilot edit rules and hard bounds per key. */
  catalogEntry(key: string): CatalogEntry | undefined {
    if (!this.catalog) {
      const cat = this.knowledge().find((e) => e.kind === 'settings_catalog')
      const list = cat && Array.isArray(cat.data['settings']) ? cat.data['settings'] : []
      this.catalog = new Map()
      for (const item of list) if (isRecord(item) && typeof item['key'] === 'string') this.catalog.set(item['key'], item as unknown as CatalogEntry)
    }
    return this.catalog.get(key)
  }

  /** Expands a citation (a source id or a `prefix:path` reference) to a title and URL. */
  source(ref: string): SourceRef {
    if (!this.sources || !this.prefixes) {
      this.sources = new Map()
      this.prefixes = new Map()
      for (const e of this.knowledge().filter((k) => k.kind === 'sources')) {
        for (const s of Array.isArray(e.data['sources']) ? e.data['sources'] : []) {
          if (isRecord(s) && typeof s['id'] === 'string') {
            this.sources.set(s['id'], {
              id: s['id'],
              ...(typeof s['title'] === 'string' ? { title: s['title'] } : {}),
              ...(typeof s['url'] === 'string' ? { url: s['url'] } : {}),
            })
          }
        }
        for (const p of Array.isArray(e.data['prefixes']) ? e.data['prefixes'] : []) {
          if (isRecord(p) && typeof p['prefix'] === 'string' && typeof p['url_template'] === 'string') this.prefixes.set(p['prefix'], p['url_template'])
        }
      }
    }
    const known = this.sources.get(ref)
    if (known) return known
    const colon = ref.indexOf(':')
    if (colon > 0) {
      const template = this.prefixes.get(ref.slice(0, colon))
      if (template) return { id: ref, url: template.replace('{path}', encodeURI(ref.slice(colon + 1))) }
    }
    return { id: ref }
  }
}
