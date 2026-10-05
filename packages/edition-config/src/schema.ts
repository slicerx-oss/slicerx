// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition configuration: one typed file every edition surface reads.
// Only public values belong here; validation rejects anything that looks like a secret.
import { z } from 'zod'

import { isFork, POWERED_BY } from './links.ts'
import { EDITION_SCHEMA_VERSION } from './version.ts'
export { EDITION_SCHEMA_VERSION }

/** Edition features, the ones an integrator can switch on or off. Base features (`pilot`, printers) are here too. */
export const EDITION_FEATURES = ['store', 'feed', 'creators', 'cloudSlicing', 'phonePairing', 'pilot'] as const
export type EditionFeature = (typeof EDITION_FEATURES)[number]

export const PRINTER_FAMILIES = ['bambu', 'moonraker', 'prusalink', 'octoprint', 'duet', 'creality', 'elegoo', 'snapmaker', 'spoolman', 'homeassistant'] as const
export type PrinterFamily = (typeof PRINTER_FAMILIES)[number]

const httpUrl = z.url({ protocol: /^https?$/ })
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits and dashes, 2 to 32 characters')
const reverseDns = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/, 'reverse DNS, such as com.example.slicer')
const domain = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'a domain name without scheme or path')
const scheme = z.string().regex(/^[a-z][a-z0-9+.-]*$/, 'a URL scheme such as myslicer')
/** A file path relative to the config file, an https URL, or `builtin:<name>` for artwork the base ships. */
const asset = z.string().min(1)

/** A font file the build bundles: woff2, woff, ttf or otf next to the config. One entry per face (weight and style). */
const fontFile = z.object({
  /** The family name `fonts` uses, such as `Sora`. */
  family: z.string().min(1).max(64).regex(/^[^"';{}\\]+$/, 'a plain family name, no quotes or braces'),
  src: asset.regex(/\.(woff2|woff|ttf|otf)$/i, 'a .woff2, .woff, .ttf or .otf file next to the config'),
  /** One weight (`400`) or a range for a variable font (`100 900`). */
  weight: z.string().regex(/^\d{3}( \d{3})?$/, 'a weight such as 400, or a range such as 100 900').optional(),
  style: z.enum(['normal', 'italic']).optional(),
})

const themeTokens = z.object({
  colors: z.record(z.string(), z.string()).optional(),
  /** Family names. The app adds a sans-serif (or monospace) fallback stack after each. */
  fonts: z.object({ display: z.string(), body: z.string(), mono: z.string() }).partial().optional(),
  /** Font files the build bundles, for families the base does not ship. */
  fontFiles: z.array(fontFile).max(24).optional(),
  radius: z.object({ sm: z.string(), md: z.string(), lg: z.string() }).partial().optional(),
})

export const brandSchema = z.object({
  /** Product name shown in title bars, the About screen, emails and store listings. */
  name: z.string().min(1).max(40),
  shortName: z.string().min(1).max(16).optional(),
  tagline: z.string().max(120).optional(),
  /** One line for installers and package listings. Defaults to the tagline. */
  description: z.string().max(200).optional(),
  logo: z.object({
    mark: asset,
    wordmark: asset.optional(),
    /** Square source image for app icons (1024 px PNG or SVG). The desktop build makes its icons from it; forks must set it. */
    appIcon: asset.optional(),
  }),
  /** A theme id the base ships, or token overrides on top of one. */
  theme: z.union([
    z.literal('nocturne'),
    z.object({ base: z.literal('nocturne').default('nocturne'), tokens: themeTokens }),
  ]).default('nocturne'),
  supportEmail: z.email().optional(),
})

export const appsSchema = z.object({
  web: z.object({ origin: httpUrl.optional() }).prefault({}),
  desktop: z.object({ identifier: reverseDns, productName: z.string().min(1).max(40) }),
  ios: z.object({ bundleId: reverseDns, teamId: z.string().regex(/^[A-Z0-9]{10}$/).optional(), appStoreId: z.string().optional() }).optional(),
  android: z.object({ applicationId: reverseDns, sha256CertFingerprints: z.array(z.string()).default([]) }).optional(),
  /** Custom URL scheme for deep links and auth callbacks, such as `myslicer://auth/callback`. */
  deepLinkScheme: scheme,
  /** Domains that open the apps (universal links and Android app links). */
  universalLinkDomains: z.array(domain).default([]),
})

export const backendSchema = z.object({
  /** Store, feed, accounts. The anon key is public by design; never put the service role key here. */
  supabase: z.object({ url: httpUrl, anonKey: z.string().min(20) }).nullable().default(null),
  /** Cloud slicing, Vault slicing, API tokens. */
  cloudApi: httpUrl.nullable().default(null),
  /** Relay for phone pairing and remote printer access. */
  relay: httpUrl.nullable().default(null),
  /** Local port of sx-link, the bridge the browser build uses for printers. */
  linkPort: z.number().int().min(1024).max(65535).default(47615),
})

export const featuresSchema = z.object({
  /** The free model library (browse, upload, moderation). The id predates the open source pivot. */
  store: z.boolean().default(false),
  feed: z.boolean().default(false),
  /** Creator pages, the creator directory and the creator dashboard. */
  creators: z.boolean().default(false),
  cloudSlicing: z.boolean().default(false),
  phonePairing: z.boolean().default(false),
  pilot: z.boolean().default(true),
  /** Set up local AI in mimir's settings and first run: picks, downloads and checks a model that runs on the user's computer. */
  localAi: z.boolean().default(true),
  /** Store and feed serve the bundled demo catalog instead of a backend (demos, screenshots, offline development). */
  demoData: z.boolean().default(false),
  printers: z.object(Object.fromEntries(PRINTER_FAMILIES.map((f) => [f, z.boolean().default(true)])) as Record<PrinterFamily, z.ZodDefault<z.ZodBoolean>>).prefault({}),
})

export const AUTH_KINDS = ['email', 'github', 'google', 'apple', 'discord'] as const
export type AuthKind = (typeof AUTH_KINDS)[number]
const oauth = (kind: Exclude<AuthKind, 'email'>) => z.object({ kind: z.literal(kind), clientId: z.string().min(1) })
export const authSchema = z.object({
  providers: z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('email') }), oauth('github'), oauth('google'), oauth('apple'), oauth('discord')])).default([{ kind: 'email' }]),
})

export const aiSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'openai-compatible', 'none']).default('openai'),
  /** Default model id; users can change it in mimir settings. */
  model: z.string().min(1).default('gpt-6-sol'),
  baseUrl: httpUrl.optional(),
  /** Where the key comes from: the OS keychain, the environment, or the edition's cloud (which holds it server side). */
  keySource: z.enum(['keychain', 'env', 'cloud']).default('keychain'),
  /** Local model ids (packages/pilot/llm/local-models.json) Set up local AI may offer. Unset: all of them. */
  allowedLocalModels: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'a model id such as qwen-2.5-14b')).min(1).optional(),
})

export const legalSchema = z.object({
  terms: httpUrl.optional(),
  privacy: httpUrl.optional(),
  imprint: httpUrl.optional(),
  /** Link to the exact source of a build; `{commit}` is replaced. AGPL section 13 needs it for builds that ship the stock profiles (packages/profiles), which every edition build does. */
  sourceUrl: z.string().regex(/^https:\/\/\S+$/).optional(),
  /** Short notice shown on About, such as who owns the name and logo. */
  trademarkNotice: z.string().max(300).optional(),
  /** The credit About shows. Optional because it is fixed: the check accepts only the standard credit (POWERED_BY). */
  attribution: z.object({ text: z.string().min(1).max(200), url: httpUrl }).optional(),
  /** The license line About shows, for example "Apache-2.0; stock printer profiles AGPL-3.0-or-later". */
  license: z.string().max(200).optional(),
  /** Who publishes the apps, as installers show it. Defaults to the brand name. */
  publisher: z.string().min(1).max(100).optional(),
  /** The copyright line installers show. Defaults to one naming the publisher. */
  copyright: z.string().min(1).max(200).optional(),
})

/** Pages the apps link to. Unset entries fall back to SlicerX's pages (editionLinks). */
export const linksSchema = z.object({
  docs: httpUrl.optional(),
  support: httpUrl.optional(),
  /** Where people download the desktop app. */
  download: httpUrl.optional(),
})

/** Where people can support the project. Links out only; nothing is sold in the app. Unset entries are hidden. */
export const fundingSchema = z.object({
  payWhatYouWant: httpUrl.optional(),
  buyMeACoffee: httpUrl.optional(),
  githubSponsors: httpUrl.optional(),
})

/** Where downloads come from. `manifestUrl` points at the desktop downloads manifest (platform, version, url, sha256, size). */
export const downloadsSchema = z.object({
  manifestUrl: httpUrl.optional(),
  appStoreUrl: httpUrl.optional(),
  googlePlayUrl: httpUrl.optional(),
})

export const MODERATION_MODES = ['owner-approves-all', 'moderators', 'trusted-creators', 'auto-after-scan'] as const
export type ModerationMode = (typeof MODERATION_MODES)[number]
export const UPLOAD_FORMATS = ['3mf', 'sx3mf', 'stl'] as const
export const ROLES = ['owner', 'moderator', 'creator', 'member'] as const
export type Role = (typeof ROLES)[number]
export const libraryConfigSchema = z.object({
  moderation: z.object({
    /** owner-approves-all: only the owner publishes. moderators: owner and moderators approve. trusted-creators: moderators approve, but a clean upload from a creator the owner marked trusted publishes at once. auto-after-scan: a clean scan publishes, moderators review afterwards. */
    mode: z.enum(MODERATION_MODES).default('owner-approves-all'),
    /** Largest accepted upload in megabytes. */
    maxFileMb: z.number().int().min(1).max(500).default(100),
    allowedFormats: z.array(z.enum(UPLOAD_FORMATS)).min(1).default([...UPLOAD_FORMATS]),
  }).prefault({}),
})

const routePath = z.string().regex(/^\/[a-z0-9/:_-]*$/, 'a path starting with /, lowercase, with :param segments')
/** Public web routes. Paths only; the origin is apps.web.origin. */
export const routesSchema = z.object({
  landing: routePath.default('/'),
  studio: routePath.default('/studio'),
  login: routePath.default('/login'),
  creators: routePath.default('/creators'),
  creator: routePath.default('/creators/:handle'),
  dashboard: routePath.default('/dashboard'),
  moderation: routePath.default('/moderation'),
})

export const LOOK_IDS = ['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer'] as const
export const firstRunSchema = z.object({
  /** Preselected look and feel preset. The presets themselves live in @slicerx/contracts (lookfeel). */
  defaultLook: z.enum(LOOK_IDS).default('slicerx'),
  /** Motion until the person picks: follow the system's reduce motion setting, always on, or reduced. */
  defaultMotion: z.enum(['system', 'full', 'reduced']).default('full'),
})

export const RELEASE_STAGES = ['pre-alpha', 'alpha', 'beta', 'stable'] as const
export type ReleaseStage = (typeof RELEASE_STAGES)[number]
export const releaseSchema = z.object({
  /** How finished the build is. pre-alpha: the first-run agreement must be accepted and crash reports cannot be turned off. */
  stage: z.enum(RELEASE_STAGES).default('stable'),
  /** Where people report bugs, linked from the agreement and Help, Report a bug. */
  bugReportsUrl: httpUrl.optional(),
})

export const bugsSchema = z.object({
  /**
   * Also send this edition's crash reports (kind crash only, scrubbed like any report) to SlicerX, with the edition id
   * in the title, so SlicerX can see crashes in the engine and app that editions share. Off unless an edition turns it on.
   */
  upstream: z.boolean().default(false),
})

const baseSchema = z.object({
  schemaVersion: z.literal(EDITION_SCHEMA_VERSION),
  /** Machine id of the edition, used in file names, user agents and storage keys. */
  id: slug,
  brand: brandSchema,
  apps: appsSchema,
  backend: backendSchema.prefault({}),
  features: featuresSchema.prefault({}),
  auth: authSchema.prefault({}),
  ai: aiSchema.prefault({}),
  legal: legalSchema.prefault({}),
  funding: fundingSchema.prefault({}),
  downloads: downloadsSchema.prefault({}),
  library: libraryConfigSchema.prefault({}),
  routes: routesSchema.prefault({}),
  firstRun: firstRunSchema.prefault({}),
  release: releaseSchema.prefault({}),
  bugs: bugsSchema.prefault({}),
  links: linksSchema.prefault({}),
})

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bsk_(live|test)_[A-Za-z0-9]{10,}/, 'a Stripe secret key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
]

function jwtRole(token: string): string | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown }
    return typeof json.role === 'string' ? json.role : null
  } catch {
    return null
  }
}

function walk(v: unknown, path: (string | number)[], visit: (s: string, path: (string | number)[]) => void): void {
  if (typeof v === 'string') visit(v, path)
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i], visit))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k], visit)
}

export const editionConfigSchema = baseSchema.superRefine((c, ctx) => {
  const f = c.features
  const need = (on: boolean, ok: boolean, path: (string | number)[], message: string) => {
    if (on && !ok) ctx.addIssue({ code: 'custom', path, message })
  }
  need(f.feed, f.store, ['features', 'feed'], 'feed needs store')
  need(f.creators, f.store, ['features', 'creators'], 'creators needs store (uploads come from the library)')
  need(f.store && !f.demoData, c.backend.supabase !== null, ['backend', 'supabase'], 'store needs backend.supabase (or features.demoData for the bundled demo catalog)')
  need(f.cloudSlicing, c.backend.cloudApi !== null, ['backend', 'cloudApi'], 'cloudSlicing needs backend.cloudApi')
  need(f.phonePairing, c.backend.relay !== null, ['backend', 'relay'], 'phonePairing needs backend.relay')
  need(f.pilot && c.ai.keySource === 'cloud', c.backend.cloudApi !== null, ['ai', 'keySource'], "keySource 'cloud' needs backend.cloudApi")
  need(f.pilot, c.ai.provider !== 'none', ['ai', 'provider'], "pilot needs an AI provider other than 'none'")
  need(c.ai.provider === 'openai-compatible', c.ai.baseUrl !== undefined, ['ai', 'baseUrl'], 'openai-compatible needs ai.baseUrl')
  // Every build ships the AGPL-3.0 stock profiles and printer images (REUSE.toml). The SlicerX edition and the
  // unbranded reference build link SlicerX's own source; any other edition must link its own.
  const fork = isFork(c)
  const edition = fork || f.store || f.feed || f.creators || f.cloudSlicing || f.phonePairing
  need(edition, c.legal.sourceUrl !== undefined, ['legal', 'sourceUrl'], 'edition builds ship the AGPL-3.0 stock profiles: set legal.sourceUrl so users can get the source (section 13)')
  // The credit is part of the license terms: an edition may leave `attribution` out or repeat it, never reword or relink it.
  if (c.legal.attribution && (c.legal.attribution.text !== POWERED_BY.text || c.legal.attribution.url !== POWERED_BY.url)) ctx.addIssue({ code: 'custom', path: ['legal', 'attribution'], message: `every edition shows the credit "${POWERED_BY.text}" linking to ${POWERED_BY.url}; leave legal.attribution out or set exactly that` })
  need(c.apps.universalLinkDomains.length > 0, c.apps.ios !== undefined || c.apps.android !== undefined, ['apps', 'universalLinkDomains'], 'universal link domains need apps.ios or apps.android')

  // The name and logo are trademarks: only the SlicerX edition itself may use them.
  if (c.id !== 'slicerx') {
    if ([c.brand.name, c.brand.shortName ?? '', c.apps.desktop.productName].some((n) => /slicer\s*x/i.test(n))) ctx.addIssue({ code: 'custom', path: ['brand', 'name'], message: 'forks must use their own name; "SlicerX" is a trademark (see TRADEMARK.md)' })
    walk(c.brand.logo, ['brand', 'logo'], (s, path) => {
      if (/editions\/slicerx\/|builtin:slicerx/.test(s)) ctx.addIssue({ code: 'custom', path, message: 'forks must replace the SlicerX logo' })
    })
    need(fork, c.brand.logo.appIcon !== undefined, ['brand', 'logo', 'appIcon'], 'forks need their own app icon; without one the desktop build would ship the SlicerX icon')
    if (/^slicer-?x$/.test(c.apps.deepLinkScheme)) ctx.addIssue({ code: 'custom', path: ['apps', 'deepLinkScheme'], message: 'forks need their own link scheme, not slicerx://' })
    if (/^app\.slicerx\./.test(c.apps.desktop.identifier) || /^app\.slicerx\./.test(c.apps.ios?.bundleId ?? '') || /^app\.slicerx\./.test(c.apps.android?.applicationId ?? '')) ctx.addIssue({ code: 'custom', path: ['apps'], message: 'forks need their own app identifiers, not app.slicerx.*' })
  }

  // Only public values: no service role key, no API keys, no private keys.
  // Supabase's newer keys: sb_publishable_ is public, sb_secret_ is the service role's replacement.
  if (c.backend.supabase?.anonKey.startsWith('sb_secret_')) ctx.addIssue({ code: 'custom', path: ['backend', 'supabase', 'anonKey'], message: 'this is a Supabase secret key (sb_secret_); use the publishable or anon key, the secret key never leaves the server' })
  if (c.backend.supabase && jwtRole(c.backend.supabase.anonKey) === 'service_role') ctx.addIssue({ code: 'custom', path: ['backend', 'supabase', 'anonKey'], message: 'this is a service role key; use the anon key, the service role key never leaves the server' })
  walk(c, [], (s, path) => {
    for (const [re, what] of SECRET_PATTERNS) if (re.test(s)) ctx.addIssue({ code: 'custom', path, message: `looks like ${what}; secrets do not belong in the edition config` })
  })
})

/** What a config file contains: everything optional that has a default. */
export type EditionConfigInput = z.input<typeof editionConfigSchema>
/** A validated config with every default filled in. */
export type EditionConfig = z.output<typeof editionConfigSchema>
