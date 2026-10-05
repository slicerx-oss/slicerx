// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Client side checks that mirror the database, so a mistake is caught before
// any network call. The database stays the authority; these only save a trip.
import type { CreatorLinkInput, CreatorLinkKind, FileFormat } from '@slicerx/contracts'
import { LINK_KINDS } from './rows'

/** Default largest model file, in bytes (100 MB). The library settings can raise it, up to 500 MB. */
export const MAX_UPLOAD_BYTES = 104_857_600
export const DEFAULT_MAX_FILE_MB = 100
export const UPLOAD_EXTENSIONS: readonly FileFormat[] = ['3mf', 'sx3mf', 'stl']
export const MAX_CREATOR_LINKS = 12
export const MAX_FEATURED = 6

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

/** The domains each named service may link to (creator_links check trigger). Other kinds accept any host. */
export const LINK_DOMAINS: Partial<Record<CreatorLinkKind, readonly string[]>> = {
  patreon: ['patreon.com'],
  makerworld: ['makerworld.com'],
  printables: ['printables.com'],
  thingiverse: ['thingiverse.com'],
  cults3d: ['cults3d.com'],
  youtube: ['youtube.com', 'youtu.be'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  x: ['x.com', 'twitter.com'],
  discord: ['discord.gg', 'discord.com'],
  github: ['github.com'],
  kofi: ['ko-fi.com'],
  buymeacoffee: ['buymeacoffee.com'],
}

// The creator_links.url check constraint, case-insensitive.
const URL_SHAPE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(:[0-9]{1,5})?([/?#][^\s<>"'\\]*)?$/i

/**
 * Checks one creator link the way the database does: https only, a plain host
 * with a top level domain, at most 300 characters, a label of 1 to 60
 * characters when given, and for a named service a host on that service's own
 * domain (www. is ignored, subdomains count). Returns the link with the URL
 * and label trimmed.
 */
export function validateCreatorLink(input: CreatorLinkInput): Checked<CreatorLinkInput> {
  if (!(LINK_KINDS as readonly string[]).includes(input.kind)) return { ok: false, message: `Unknown link type: ${String(input.kind)}` }
  const url = input.url.trim()
  if (url.length === 0) return { ok: false, message: 'Enter a web address' }
  if (url.length > 300) return { ok: false, message: 'Links can be at most 300 characters' }
  if (!url.toLowerCase().startsWith('https://')) return { ok: false, message: 'Links must start with https://' }
  if (!URL_SHAPE.test(url)) return { ok: false, message: 'That is not a valid web address' }
  const label = input.label?.trim()
  if (label !== undefined && label.length > 60) return { ok: false, message: 'Labels can be at most 60 characters' }
  const domains = LINK_DOMAINS[input.kind]
  if (domains) {
    const host = /^https:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase().replace(/^www\./, '') ?? ''
    if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      return { ok: false, message: `A ${input.kind} link must point to ${domains.join(' or ')}` }
    }
  }
  return { ok: true, value: { kind: input.kind, url, ...(label ? { label } : {}) } }
}

/** Checks a whole list: each link, at most 12, and no address twice. */
export function validateCreatorLinks(links: readonly CreatorLinkInput[]): Checked<CreatorLinkInput[]> {
  if (links.length > MAX_CREATOR_LINKS) return { ok: false, message: `A creator page has at most ${MAX_CREATOR_LINKS} links` }
  const out: CreatorLinkInput[] = []
  const seen = new Set<string>()
  for (const [i, l] of links.entries()) {
    const r = validateCreatorLink(l)
    if (!r.ok) return { ok: false, message: `Link ${i + 1}: ${r.message}` }
    if (seen.has(r.value.url)) return { ok: false, message: `Link ${i + 1}: this address is already on the page` }
    seen.add(r.value.url)
    out.push(r.value)
  }
  return { ok: true, value: out }
}

/**
 * Checks an upload before it leaves the device: a lowercase file name ending
 * .3mf, .sx3mf or .stl that agrees with the declared format (and is allowed
 * by the library), a size from 1 byte to the library limit (100 MB unless the
 * settings say otherwise), and a semantic version.
 */
export function validateUpload(
  input: { name: string; version: string; format: FileFormat; size: number },
  limits: { maxFileMb?: number; allowedFormats?: readonly FileFormat[] } = {},
): Checked<true> {
  const maxMb = limits.maxFileMb ?? DEFAULT_MAX_FILE_MB
  const allowed = limits.allowedFormats ?? UPLOAD_EXTENSIONS
  const ext = /\.(3mf|sx3mf|stl)$/.exec(input.name)?.[1]
  if (!ext || input.name.length > 200 || /[/\\]/.test(input.name) || input.name !== input.name.toLowerCase() || input.name.length <= ext.length + 1) {
    return { ok: false, message: 'Name the file in lowercase, ending in .3mf, .sx3mf or .stl' }
  }
  if (ext !== input.format) return { ok: false, message: `The file name ends in .${ext} but the format is ${input.format}` }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) return { ok: false, message: 'Use a version like 1.0.0' }
  if (input.size < 1) return { ok: false, message: 'The file is empty' }
  if (!allowed.includes(input.format)) return { ok: false, message: `This library accepts ${allowed.map((f) => `.${f}`).join(', ')} files` }
  if (input.size > maxMb * 1_048_576) return { ok: false, message: `Files can be at most ${maxMb} MB` }
  return { ok: true, value: true }
}

/** A listing slug from a title: lowercase words joined by hyphens, 2 to 81 characters. */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '')
  return base.length >= 2 ? base : `model-${base || 'new'}`.slice(0, 80)
}

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/
export const RESERVED_HANDLES: readonly string[] = ['admin', 'api', 'new', 'me', 'settings', 'login', 'dashboard', 'creators', 'studio', 'moderation', 'support', 'slicerx', 'library']

/** Checks a creator page handle against the database rule. */
export function validateHandle(handle: string): Checked<string> {
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, message: 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit' }
  if (RESERVED_HANDLES.includes(handle)) return { ok: false, message: 'That handle is reserved' }
  return { ok: true, value: handle }
}

/** Checks a device before it is linked: lengths and key shape from the paired_devices constraints. */
export function validateDevice(input: { deviceId: string; name: string; platform: string; signPub: string }): Checked<true> {
  if (input.deviceId.length < 8 || input.deviceId.length > 128) return { ok: false, message: 'Device ids are 8 to 128 characters' }
  if (input.name.length < 1 || input.name.length > 80) return { ok: false, message: 'Device names are 1 to 80 characters' }
  if (!['ios', 'android', 'desktop', 'web'].includes(input.platform)) return { ok: false, message: 'Platform must be ios, android, desktop or web' }
  if (!/^[A-Za-z0-9_+/=-]{32,128}$/.test(input.signPub)) return { ok: false, message: 'The signing key is not a valid public key' }
  return { ok: true, value: true }
}
