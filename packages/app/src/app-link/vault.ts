// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault over the app link: vault.list reads designs as the Vault lists them, through the edition's store client and
// the session the app already has, so a client sees what the person would and nothing more. `list` is all (the approved
// catalog, which works signed out), saved (the person's Saved list) or mine (the person's own uploads, in every
// status); saved and mine answer signed_out while nobody is signed in. Each design carries what the Vault shows: the
// title, creator, license and tags, the current version's format, colors, size and print facts, and the stats. Never a
// file, a download link, a hash or a token.
import type { EditionHost, FileFormat, Host, ListingCard, ListingLicense, ListingStatus, ListingVersion, StoreClient } from '@slicerx/contracts'
import { appName } from '../edition'
import { matchesFilter, type LibraryFilter } from '../features/store/filter'
import { LinkError } from './methods-error'

export const VAULT_LISTS = ['all', 'saved', 'mine'] as const
export type VaultList = (typeof VAULT_LISTS)[number]
/** A page of the Vault grid, and the most one call returns. */
export const VAULT_PAGE = 24
export const VAULT_MAX = 50
const QUERY_MAX = 100
const TAG_MAX = 40

/** One design as it leaves the app. */
export interface VaultDesign {
  id: string
  slug: string
  title: string
  creator: { handle: string; displayName: string }
  license: ListingLicense
  tags: string[]
  status: ListingStatus
  publishedAt: string | null
  /** The newest version the person may see; null when there is none yet. */
  version: {
    version: string
    format: FileFormat
    colors: { hex: string; name: string | null }[]
    /** x, y and z in mm as the upload scan measured it; null when the scan could not vouch for a size. */
    sizeMm: [number, number, number] | null
    /** The creator's first tested print profile: its printer, time and filament, as the Vault's print facts show. */
    print: { printer: string; timeS: number | null; grams: number | null } | null
  } | null
  stats: { downloads: number; makes: number; likes: number } | null
  /** Signed in only; null signed out. */
  liked: boolean | null
  saved: boolean | null
}

export interface VaultPage {
  list: VaultList
  signedIn: boolean
  items: VaultDesign[]
  /** The cursor for the next page; null on the last one. */
  next: string | null
}

let source: (() => StoreClient | undefined) | null = null

/** The edition's store (the one the Vault tab uses) registers here with the host; the release takes it away. */
export function bindVaultStore(host: Host | undefined): () => void {
  const mine = host ? () => (host as EditionHost).store : null
  source = mine
  return () => {
    if (source === mine) source = null
  }
}

const KEYS = ['list', 'query', 'tag', 'sort', 'cursor', 'limit']

function text(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.trim().length > max) throw new LinkError('invalid_input', `${name} is text of at most ${max} characters`)
  return v.trim() || undefined
}

function args(a: Record<string, unknown>) {
  const extra = Object.keys(a).filter((k) => !KEYS.includes(k))
  if (extra.length) throw new LinkError('invalid_input', `vault.list takes ${KEYS.join(', ')} only, not ${extra.join(', ')}`)
  const list = a['list'] ?? 'all'
  if (typeof list !== 'string' || !(VAULT_LISTS as readonly string[]).includes(list)) throw new LinkError('invalid_input', `list is one of ${VAULT_LISTS.join(', ')}`)
  const sort = a['sort']
  if (sort !== undefined && sort !== 'new' && sort !== 'popular') throw new LinkError('invalid_input', 'sort is new or popular')
  if (sort !== undefined && list !== 'all') throw new LinkError('invalid_input', `sort goes with list all; the ${list} list keeps its own order`)
  const cursor = a['cursor']
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,6}$/.test(cursor))) throw new LinkError('invalid_input', 'cursor is the next value of an earlier page')
  const limit = a['limit'] ?? VAULT_PAGE
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > VAULT_MAX) throw new LinkError('invalid_input', `limit is a whole number from 1 to ${VAULT_MAX}`)
  return { list: list as VaultList, query: text(a['query'], 'query', QUERY_MAX), tag: text(a['tag'], 'tag', TAG_MAX), sort: sort as 'new' | 'popular' | undefined, cursor: cursor as string | undefined, limit }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

function size(v: ListingVersion): [number, number, number] | null {
  const s = v.sizeMm
  return Array.isArray(s) && s.length === 3 && s.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) ? [s[0], s[1], s[2]] : null
}

function version(v: ListingVersion | undefined): VaultDesign['version'] {
  if (!v) return null
  const first = v.printProfiles ? Object.entries(v.printProfiles)[0] : undefined
  return {
    version: v.version,
    format: v.format,
    colors: (v.colors?.colors ?? []).map((c) => ({ hex: c.hex, name: c.name ?? null })),
    sizeMm: size(v),
    print: first ? { printer: first[0], timeS: num(first[1].timeS), grams: num(first[1].grams) } : null,
  }
}

/** A card as the Vault shows it, without the file, its hash, the cover's storage or anything else the app keeps. */
export function design({ listing: l, creator }: ListingCard, signedIn: boolean): VaultDesign {
  return {
    id: l.id,
    slug: l.slug,
    title: l.title,
    creator: { handle: creator.handle, displayName: creator.displayName },
    license: l.license,
    tags: [...l.tags],
    status: l.status,
    publishedAt: l.publishedAt ?? null,
    version: version(l.currentVersion),
    stats: l.stats ? { downloads: l.stats.downloads, makes: l.stats.makes, likes: l.stats.likes } : null,
    liked: signedIn ? (l.likedByMe ?? false) : null,
    saved: signedIn ? (l.savedByMe ?? false) : null,
  }
}

/** The person's own list, paged here: the store answers it whole. */
function pageOf(cards: ListingCard[], cursor: string | undefined, limit: number): { items: ListingCard[]; next: string | null } {
  const start = Number(cursor ?? 0)
  const end = start + limit
  return { items: cards.slice(start, end), next: end < cards.length ? String(end) : null }
}

/** vault.list: one page of the catalog, the Saved list or the person's uploads, as the store lets this session see. */
export async function listVault(a: Record<string, unknown>): Promise<VaultPage> {
  const o = args(a)
  const store = source?.()
  if (!store) throw new LinkError('not_ready', `this ${appName()} build has no Vault`)
  try {
    const signedIn = (await store.session().catch(() => null)) !== null
    if (o.list !== 'all' && !signedIn) {
      throw new LinkError('signed_out', `nobody is signed in to the Vault in ${appName()}, so there is no ${o.list === 'saved' ? 'Saved list' : 'list of uploads'} to read; the person signs in from the Vault`)
    }
    // The same rules the Vault grid runs again on what comes back, so a store that ignores an option still answers right.
    const f: LibraryFilter = { category: o.tag?.toLowerCase() ?? 'all', query: o.query ?? '', sort: 'new', saved: false, view: 'grid' }
    let page: { items: ListingCard[]; next: string | null }
    if (o.list === 'all') {
      const r = await store.listListings({ limit: o.limit, sort: o.sort ?? 'new', ...(o.tag ? { tag: o.tag } : {}), ...(o.query ? { query: o.query } : {}), ...(o.cursor ? { cursor: o.cursor } : {}) })
      page = { items: r.items.filter((c) => matchesFilter(c, f)), next: r.next ?? null }
    } else if (o.list === 'saved') {
      page = pageOf((await store.savedListings()).filter((c) => matchesFilter(c, f)), o.cursor, o.limit)
    } else {
      const [mine, creator] = await Promise.all([store.myListings(), store.getMyCreator()])
      const cards = creator ? mine.map((listing) => ({ listing, creator })) : []
      page = pageOf(cards.filter((c) => matchesFilter(c, f)), o.cursor, o.limit)
    }
    return { list: o.list, signedIn, items: page.items.map((c) => design(c, signedIn)), next: page.next }
  } catch (e) {
    if (e instanceof LinkError) throw e
    throw new LinkError('refused', `the Vault could not be read: ${e instanceof Error ? e.message : String(e)}`)
  }
}
