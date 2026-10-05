// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pure parts of the hosted library seed: the manifest schema, file checks and the
// object layout. The runner (seed-library.ts) does the network work.
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, normalize, sep } from 'node:path'
import { z } from 'zod'
import { validateCreatorLink } from '../src/validate'

const FORMATS = ['3mf', 'sx3mf', 'stl'] as const
export type SeedFormat = (typeof FORMATS)[number]

const LICENSES = ['cc0', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'custom'] as const
const LINK_KINDS = [
  'website', 'patreon', 'makerworld', 'printables', 'thingiverse', 'cults3d', 'youtube',
  'instagram', 'tiktok', 'x', 'discord', 'github', 'kofi', 'buymeacoffee', 'other',
] as const

const handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/)
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/)

export const manifestSchema = z.object({
  creators: z.array(z.object({
    handle,
    /** Sign-in account that owns the page. Created without a password if it does not exist. */
    email: z.email(),
    displayName: z.string().min(1).max(80),
    tagline: z.string().max(140).optional(),
    bio: z.string().max(4000).optional(),
    location: z.string().max(80).optional(),
    logoUrl: z.url({ protocol: /^https$/ }).max(500).optional(),
    trusted: z.boolean().default(false),
    links: z.array(z.object({
      kind: z.enum(LINK_KINDS),
      label: z.string().min(1).max(60).optional(),
      url: z.string(),
    })).max(12).default([]),
    featured: z.array(slug).max(6).default([]),
  })).min(1),
  listings: z.array(z.object({
    creator: handle,
    slug,
    title: z.string().min(1).max(120),
    description: z.string().max(8000).optional(),
    license: z.enum(LICENSES).default('cc-by'),
    tags: z.array(z.string().min(1).max(40)).max(20).default([]),
    coverUrl: z.url({ protocol: /^https$/ }).max(500).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    changelog: z.string().max(4000).optional(),
    /** Path of the model file relative to the manifest, inside the models folder. */
    file: z.string().min(1),
    printProfiles: z.array(z.object({
      printerModel: z.string().min(1),
      process: z.string().min(1),
      filament: z.string().min(1),
      layerHeightMm: z.number().positive().max(1).optional(),
      nozzleMm: z.number().positive().optional(),
      timeS: z.int().min(0).optional(),
      grams: z.number().min(0).optional(),
      plates: z.int().min(1).optional(),
      notes: z.string().max(2000).optional(),
    })).default([]),
  })).min(1),
})
export type SeedManifest = z.infer<typeof manifestSchema>

/** Entry names an archive must not contain, by extension. */
const BLOCKED_EXT = /\.(exe|dll|so|dylib|bat|cmd|com|scr|msi|app|sh|bash|zsh|ps1|psm1|vbs|js|mjs|py|rb|pl|php|jar|class|lnk|reg|docm|xlsm|apk|dmg|pkg|deb|rpm)$/i

/** Problems with one archive entry name, or null when it is fine. */
export function badEntryName(name: string): string | null {
  if (name.includes('\0')) return 'NUL in a path'
  const n = name.replaceAll('\\', '/')
  if (isAbsolute(n) || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return 'absolute path'
  if (n.split('/').includes('..')) return 'path traversal'
  if (BLOCKED_EXT.test(n)) return 'executable or script'
  return null
}

/** Cheap structural checks on a model file. The hosted scan service does the full set. */
export function checkModelBytes(format: SeedFormat, bytes: Uint8Array, entries: string[] | null): string[] {
  const problems: string[] = []
  if (bytes.length === 0) problems.push('empty file')
  if (format === '3mf' || format === 'sx3mf') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) problems.push('not a zip container')
    for (const e of entries ?? []) {
      const bad = badEntryName(e)
      if (bad) problems.push(`entry ${JSON.stringify(e)}: ${bad}`)
    }
    if (entries && !entries.some((e) => /\.model$/i.test(e))) problems.push('no 3D model part')
  } else {
    const head = new TextDecoder().decode(bytes.subarray(0, 5)).toLowerCase()
    if (head === 'solid') {
      if (!new TextDecoder().decode(bytes.subarray(0, 4096)).includes('facet')) problems.push('ASCII STL without facets')
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (bytes.length < 84 || 84 + view.getUint32(80, true) * 50 !== bytes.length) problems.push('binary STL size does not match its triangle count')
    }
  }
  return problems
}

export function fileFormat(file: string): SeedFormat {
  const ext = file.toLowerCase().split('.').pop() ?? ''
  if (!(FORMATS as readonly string[]).includes(ext)) throw new Error(`${file}: only 3mf, sx3mf and stl files are accepted`)
  return ext as SeedFormat
}

/** Resolves a manifest file entry under the models folder, refusing anything that leaves it. */
export function resolveModelPath(root: string, file: string): string {
  const n = normalize(file)
  if (isAbsolute(n) || n.split(sep).includes('..')) throw new Error(`${file}: model files must be inside the models folder`)
  return `${root}${sep}${n}`
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Object name in the buckets: <listing id>/<version id>/<file name>, file name lowercased and safe. */
export function objectName(listingId: string, versionId: string, file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? 'model').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${listingId}/${versionId}/${base}`
}

export const newId = (): string => randomUUID()

/** Manifest problems that the schema cannot express: references and link rules. */
export function manifestProblems(m: SeedManifest): string[] {
  const out: string[] = []
  const handles = new Set(m.creators.map((c) => c.handle))
  const slugs = new Set<string>()
  for (const c of m.creators) {
    for (const l of c.links) {
      const r = validateCreatorLink({ kind: l.kind, url: l.url, ...(l.label ? { label: l.label } : {}) })
      if (!r.ok) out.push(`creator ${c.handle}: ${r.message}`)
    }
  }
  for (const l of m.listings) {
    if (!handles.has(l.creator)) out.push(`listing ${l.slug}: unknown creator ${l.creator}`)
    if (slugs.has(l.slug)) out.push(`listing ${l.slug}: duplicate slug`)
    slugs.add(l.slug)
  }
  for (const c of m.creators) {
    for (const f of c.featured) if (!m.listings.some((l) => l.slug === f && l.creator === c.handle)) out.push(`creator ${c.handle}: featured ${f} is not one of their listings`)
  }
  return out
}
