// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a white-label edition shows in place of SlicerX's: its pages, the credit, its MCP server name, its logo.
import type { EditionConfig } from './schema.ts'

/** Any edition but SlicerX's own and the unbranded reference build. A fork never sends people to SlicerX's channels. */
export function isFork(config: EditionConfig): boolean {
  return config.id !== 'slicerx' && config.id !== 'reference'
}

/** Whether bug and crash reports can be uploaded: only ever to the edition's own backend. */
export function reportsUpload(config: EditionConfig): boolean {
  return config.backend.supabase !== null && !config.features.demoData
}

/** Whether crash reports leave the computer at all: to the edition's own backend, or to SlicerX when `bugs.upstream` is on. */
export function crashReportsSent(config: EditionConfig): boolean {
  return reportsUpload(config) || config.bugs.upstream
}

/**
 * SlicerX's public report endpoint (the project URL and its publishable key, which are public by design), for editions
 * that turn on `bugs.upstream`. Null until SlicerX publishes one; editions then send nothing upstream.
 */
export const UPSTREAM_REPORTS: { url: string; anonKey: string } | null = {
  url: 'https://rsirfakkcogdwyfvehhk.supabase.co',
  // the project's publishable key: public by design; submit_bug_report is rate limited and nothing can be read
  anonKey: 'sb_publishable_g6YxMyX9lGssxMwECPgz-g_5n7aDdPf',
}

/** SlicerX's own pages, for the links an edition leaves unset. */
export const SLICERX_LINKS = { docs: 'https://slicerx.app/docs', support: 'https://slicerx.app/support', download: 'https://slicerx.app/#download' } as const

/** SlicerX's #bug-reports channel, where SlicerX and the reference build send people with a bug. */
export const SLICERX_BUG_REPORTS = 'https://discord.com/channels/1555048815881355324/1556010155802628228'

/** SlicerX's source, linked when an edition names none of its own. */
export const SLICERX_SOURCE = 'https://github.com/slicerx-oss/slicerx'

/** The credit every edition shows on About (TRADEMARK.md). The check refuses any other text or link. */
export const POWERED_BY = { text: 'Made possible by SlicerX', url: 'https://slicerx.app/support' } as const

/** The edition's docs, support and download pages, falling back to SlicerX's. */
export function editionLinks(config: EditionConfig): { docs: string; support: string; download: string } {
  const own = config.links ?? {}
  return { docs: own.docs ?? SLICERX_LINKS.docs, support: own.support ?? SLICERX_LINKS.support, download: own.download ?? SLICERX_LINKS.download }
}

/** Where people post bugs: the edition's link, else SlicerX's channel for SlicerX and the reference build only. */
export function bugReportsLink(config: EditionConfig): string | null {
  return config.release.bugReportsUrl ?? (isFork(config) ? null : SLICERX_BUG_REPORTS)
}

/**
 * The privacy notice the account settings link: the edition's own page when it has one, otherwise the store README's
 * Privacy section in the source the build came from.
 */
export function privacyPage(config: EditionConfig, source: string): string {
  if (config.legal.privacy) return config.legal.privacy
  const repo = /^(https:\/\/[^/]+\/[^/]+\/[^/#?]+)/.exec(source)?.[1]
  return `${repo ?? source}/blob/main/packages/store/README.md#privacy`
}

/** The credit an edition shows. Always the standard one: the check refuses any other `legal.attribution`. */
export function attribution(_config: EditionConfig): { text: string; url: string } {
  return POWERED_BY
}

/** The name AI clients list this app's MCP server under: the edition's link scheme, which is its own. */
export function mcpServerId(config: EditionConfig): string {
  return config.apps.deepLinkScheme.replace(/[^a-z0-9-]/g, '-')
}

/**
 * The edition's mark or wordmark as an image address: an https or data URL, or a file the build copied to
 * static/brand (editionLogoAssets). Null for `builtin:` artwork, which the app draws itself.
 */
export function logoImage(config: EditionConfig, which: 'mark' | 'wordmark'): string | null {
  const v = config.brand.logo[which]
  return v && /^(https:|data:image\/|(\.?\/|\/.*\/)static\/brand\/)/.test(v) ? v : null
}
