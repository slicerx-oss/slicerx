// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Seeds the hosted library from model files kept outside git.
//
//   SLICERX_SUPABASE_URL=... SLICERX_SERVICE_ROLE_KEY=... \
//     pnpm --filter @slicerx/store library:seed --models <folder> [--manifest <file>] [--dry-run] [--update]
//
// The folder holds the model files and a manifest.json (see seed-manifest.example.json
// for the shape). It must not be inside a git work tree. Creators are created as
// sign-in accounts without a password, their pages, links and listings are written as
// approved, and each file goes to the listing-files bucket. Files get the structural
// checks in library-seed.ts here; they do not go through the hosted scan service, so
// only seed files you trust. Running it again skips listings that already exist.
// The service role key comes from the environment and is never written anywhere.
//
// --update publishes changed files as new versions of the listings that already exist: for each
// manifest entry whose file differs (by sha256) from the listing's latest approved version, it adds
// the manifest's version with its changelog, file and cover, approved and scan-marked as the seed
// does. The listing keeps its id, stats and likes. With --dry-run it reads the library and lists what
// would change, writing nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { latestVersion } from '../src/map'
import {
  checkModelBytes, fileFormat, manifestProblems, manifestSchema, newId, objectName, resolveModelPath, sha256Hex,
  type SeedManifest,
} from './library-seed'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const update = args.includes('--update')
const modelsDir = flag('--models')
if (!modelsDir) fail('usage: library:seed --models <folder> [--manifest <file>] [--dry-run]')
const root = resolve(modelsDir)
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} is not a folder`)

// The models must live outside git, so they can never be committed by accident.
const inGit = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
if (inGit.status === 0 && inGit.stdout.trim() === 'true') fail(`${root} is inside a git work tree; keep seed models outside the repository`)

const manifestFile = resolve(flag('--manifest') ?? join(root, 'manifest.json'))
const manifest: SeedManifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile, 'utf8')))
const problems = manifestProblems(manifest)

const MAX_BYTES = 100 * 1024 * 1024
interface Prepared { listing: SeedManifest['listings'][number]; bytes: Uint8Array; format: ReturnType<typeof fileFormat>; sha256: string; name: string }
const prepared: Prepared[] = []
for (const l of manifest.listings) {
  try {
    const path = resolveModelPath(root, l.file)
    const bytes = new Uint8Array(readFileSync(path))
    const format = fileFormat(l.file)
    if (bytes.length > MAX_BYTES) problems.push(`${l.slug}: ${(bytes.length / 1048576).toFixed(1)} MB is over the 100 MB limit`)
    const entries = format === 'stl' ? null : execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
    for (const p of checkModelBytes(format, bytes, entries)) problems.push(`${l.slug}: ${p}`)
    prepared.push({ listing: l, bytes, format, sha256: sha256Hex(bytes), name: l.file })
  } catch (e) {
    problems.push(`${l.slug}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
for (const [owner, f] of [...manifest.creators.flatMap((c) => [c.logo, c.banner].filter(Boolean).map((f) => [c.handle, f] as const)), ...manifest.listings.flatMap((l) => (l.cover ? [[l.slug, l.cover] as const] : []))]) {
  try {
    const path = resolveModelPath(root, f as string)
    if (!existsSync(path)) problems.push(`${owner}: ${f} is missing`)
    else if (statSync(path).size > 5 * 1024 * 1024) problems.push(`${owner}: ${f} is over 5 MB`)
  } catch (e) {
    problems.push(`${owner}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (problems.length > 0) fail(`the manifest has problems:\n  ${problems.join('\n  ')}`)

console.log(`${manifest.creators.length} creators, ${prepared.length} models (${(prepared.reduce((n, p) => n + p.bytes.length, 0) / 1048576).toFixed(1)} MB)`)
if (dryRun && !update) {
  for (const p of prepared) console.log(`  ${p.listing.creator}/${p.listing.slug}  ${p.format}  ${p.sha256.slice(0, 12)}`)
  console.log('dry run: nothing written')
  process.exit(0)
}

const url = process.env['SLICERX_SUPABASE_URL']
const key = process.env['SLICERX_SERVICE_ROLE_KEY']
if (!url || !key) fail('set SLICERX_SUPABASE_URL and SLICERX_SERVICE_ROLE_KEY in the environment')
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

interface Res { data: unknown; error: { message: string } | null }
/** Awaits one query and stops the run on an error. */
async function must<T = { id: string }>(what: string, q: PromiseLike<Res>): Promise<T> {
  const r = await q
  if (r.error) fail(`${what}: ${r.error.message}`)
  return r.data as T
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
/** Uploads an image from the models folder to the owner's creator-media folder and returns its public URL. */
async function uploadImage(ownerId: string, file: string): Promise<string> {
  const path = resolveModelPath(root, file)
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const object = `${ownerId}/${file}`
  const up = await sb.storage.from('creator-media').upload(object, readFileSync(path), { contentType: IMAGE_TYPES[ext] ?? 'image/png', upsert: true })
  if (up.error) fail(`upload ${object}: ${up.error.message}`)
  return sb.storage.from('creator-media').getPublicUrl(object).data.publicUrl
}

if (update) {
  let changed = 0
  for (const p of prepared) {
    const l = p.listing
    const listing = await must<{ id: string; creator_id: string } | null>('find listing', sb.from('listings').select('id, creator_id').eq('slug', l.slug).maybeSingle())
    if (!listing) {
      console.log(`listing ${l.slug}: not in the library; seed it without --update`)
      continue
    }
    const versions = await must<{ version: string; sha256: string; review_status: string; scan_status: string }[]>('find versions', sb.from('listing_versions').select('version, sha256, review_status, scan_status').eq('listing_id', listing.id))
    const live = latestVersion(versions.filter((v) => v.review_status === 'approved' && v.scan_status === 'clean'))
    if (live?.sha256 === p.sha256) {
      console.log(`listing ${l.slug}: unchanged (${live.version})`)
      continue
    }
    if (versions.some((v) => v.version === l.version) || (live && latestVersion([live, { ...live, version: l.version }])?.version !== l.version)) {
      fail(`listing ${l.slug}: the file changed but version ${l.version} is not newer than ${live?.version ?? 'the ones there'}; raise it in the manifest`)
    }
    changed += 1
    console.log(`listing ${l.slug}: ${live?.version ?? 'none'} -> ${l.version} (${p.sha256.slice(0, 12)}, ${(p.bytes.length / 1024).toFixed(0)} KB)${l.changelog ? `: ${l.changelog}` : ''}`)
    if (dryRun) continue
    const versionId = newId()
    const path = objectName(listing.id, versionId, p.name)
    const now = new Date().toISOString()
    const up = await sb.storage.from('listing-files').upload(path, p.bytes, { contentType: 'application/octet-stream', upsert: false })
    if (up.error) fail(`upload ${path}: ${up.error.message}`)
    await must('create version', sb.from('listing_versions').insert({
      id: versionId, listing_id: listing.id, version: l.version, changelog: l.changelog ?? null, storage_path: path,
      sha256: p.sha256, format: p.format, size_bytes: p.bytes.length, scan_status: 'clean', review_status: 'approved',
      scan_report: { verdict: 'clean', checks: [], scannerVersion: 'seed-import', scannedAt: now, source: 'library seed' }, scanned_at: now,
    }).select('id'))
    await must('create file row', sb.from('listing_files').insert({
      version_id: versionId, name: path.split('/').pop() as string, role: 'model', format: p.format, size_bytes: p.bytes.length, sha256: p.sha256,
    }).select('id'))
    const owner = await must<{ owner_id: string }>('find owner', sb.from('creators').select('owner_id').eq('id', listing.creator_id).single())
    const coverUrl = l.cover ? await uploadImage(owner.owner_id, l.cover) : undefined
    await must('update listing', sb.from('listings').update({ title: l.title, description: l.description ?? null, tags: l.tags, ...(coverUrl ? { cover_url: coverUrl } : {}) }).eq('id', listing.id).select('id'))
    await must('audit', sb.from('audit_log').insert({ action: 'seed_update', target_kind: 'listing', target_id: listing.id, detail: { slug: l.slug, version: l.version, sha256: p.sha256 } }).select('id'))
  }
  console.log(dryRun ? `dry run: ${changed} listings would get a new version, nothing written` : `done: ${changed} listings got a new version`)
  process.exit(0)
}

const creatorIds = new Map<string, string>()
const ownerIds = new Map<string, string>()
for (const c of manifest.creators) {
  const existing = await must<{ id: string; owner_id: string } | null>('find creator', sb.from('creators').select('id, owner_id').eq('handle', c.handle).maybeSingle())
  if (existing) {
    creatorIds.set(c.handle, existing.id)
    ownerIds.set(c.handle, existing.owner_id)
    continue
  }
  const created = await sb.auth.admin.createUser({
    email: c.email, email_confirm: true, user_metadata: { handle: c.handle.replaceAll('-', '_'), display_name: c.displayName },
  })
  let userId = created.data.user?.id
  if (!userId) {
    // Already registered: find the profile by the handle we would have used.
    const list = await sb.auth.admin.listUsers({ perPage: 1000 })
    userId = list.data.users.find((u) => u.email?.toLowerCase() === c.email.toLowerCase())?.id
  }
  if (!userId) fail(`could not create or find the account for ${c.email}: ${created.error?.message ?? 'unknown error'}`)
  const row = await must('create creator', sb.from('creators').insert({
    owner_id: userId, handle: c.handle, display_name: c.displayName, tagline: c.tagline ?? null, bio: c.bio ?? null,
    location: c.location ?? null, logo_url: c.logoUrl ?? null, trusted: c.trusted,
  }).select('id').single())
  creatorIds.set(c.handle, row.id)
  ownerIds.set(c.handle, userId)
  if (c.logo || c.banner) {
    await must('creator images', sb.from('creators').update({
      ...(c.logo ? { logo_url: await uploadImage(userId, c.logo) } : {}),
      ...(c.banner ? { banner_url: await uploadImage(userId, c.banner) } : {}),
    }).eq('id', row.id).select('id'))
  }
  if (c.links.length > 0) {
    await must('create links', sb.from('creator_links').insert(c.links.map((l, i) => ({ creator_id: row.id, kind: l.kind, label: l.label ?? null, url: l.url, position: i + 1 }))).select('id'))
  }
  console.log(`creator ${c.handle}: created`)
}

const listingIds = new Map<string, string>()
let added = 0
for (const p of prepared) {
  const l = p.listing
  const creatorId = creatorIds.get(l.creator) as string
  const existing = await must<{ id: string } | null>('find listing', sb.from('listings').select('id').eq('slug', l.slug).maybeSingle())
  if (existing) {
    listingIds.set(l.slug, existing.id)
    console.log(`listing ${l.slug}: already there, skipped`)
    continue
  }
  const listingId = newId()
  const versionId = newId()
  const path = objectName(listingId, versionId, p.name)
  const now = new Date().toISOString()
  const coverUrl = l.cover ? await uploadImage(ownerIds.get(l.creator) as string, l.cover) : (l.coverUrl ?? null)
  await must('create listing', sb.from('listings').insert({
    id: listingId, creator_id: creatorId, slug: l.slug, title: l.title, description: l.description ?? null, license: l.license,
    tags: l.tags, cover_url: coverUrl, status: 'approved', published_at: now, reviewed_at: now,
  }).select('id'))
  const up = await sb.storage.from('listing-files').upload(path, p.bytes, { contentType: 'application/octet-stream', upsert: false })
  if (up.error) fail(`upload ${path}: ${up.error.message}`)
  await must('create version', sb.from('listing_versions').insert({
    id: versionId, listing_id: listingId, version: l.version, changelog: l.changelog ?? null, storage_path: path,
    sha256: p.sha256, format: p.format, size_bytes: p.bytes.length, scan_status: 'clean', review_status: 'approved',
    scan_report: { verdict: 'clean', checks: [], scannerVersion: 'seed-import', scannedAt: now, source: 'library seed' }, scanned_at: now,
  }).select('id'))
  await must('create file row', sb.from('listing_files').insert({
    version_id: versionId, name: path.split('/').pop() as string, role: 'model', format: p.format, size_bytes: p.bytes.length, sha256: p.sha256,
  }).select('id'))
  if (l.printProfiles.length > 0) {
    await must('create print profiles', sb.from('print_profiles').insert(l.printProfiles.map((pp) => ({
      version_id: versionId, printer_model: pp.printerModel, process: pp.process, filament: pp.filament,
      layer_height_mm: pp.layerHeightMm ?? null, nozzle_mm: pp.nozzleMm ?? null, time_s: pp.timeS ?? null,
      grams: pp.grams ?? null, plates: pp.plates ?? null, notes: pp.notes ?? null,
    }))).select('id'))
  }
  await must('audit', sb.from('audit_log').insert({ action: 'seed_import', target_kind: 'listing', target_id: listingId, detail: { slug: l.slug, sha256: p.sha256 } }).select('id'))
  listingIds.set(l.slug, listingId)
  added += 1
  console.log(`listing ${l.slug}: added (${p.format}, ${(p.bytes.length / 1024).toFixed(0)} KB)`)
}

for (const c of manifest.creators) {
  const creatorId = creatorIds.get(c.handle) as string
  for (const [i, s] of c.featured.entries()) {
    const listingId = listingIds.get(s)
    if (!listingId) continue
    await must('feature', sb.from('creator_featured').upsert({ creator_id: creatorId, listing_id: listingId, position: i + 1 }, { onConflict: 'creator_id,listing_id' }).select('listing_id'))
  }
}
console.log(`done: ${added} listings added`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

