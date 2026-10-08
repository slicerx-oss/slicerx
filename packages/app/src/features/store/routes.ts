// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Links out to the website. Paths come from the edition's routes, never from
// string literals, and the origin from the edition or the page.
import type { EditionHost, Host } from '@slicerx/contracts'
import { privacyPage, type EditionConfig } from '@slicerx/edition-config'
import { openSafely } from '../../lib/links'

type Routes = EditionConfig['routes']

function origin(edition: EditionConfig): string {
  return edition.apps.web.origin ?? (typeof location === 'undefined' ? '' : location.origin)
}

function join(edition: EditionConfig, path: string, query?: Record<string, string>): string {
  const url = new URL(path, origin(edition) || 'https://localhost')
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  return origin(edition) ? url.toString() : `${url.pathname}${url.search}`
}

/** The sign-in page, returning to the studio afterwards. */
export function signInUrl(edition: EditionConfig): string {
  return join(edition, edition.routes.login, { next: edition.routes.studio })
}

export function dashboardUrl(edition: EditionConfig): string {
  return join(edition, edition.routes.dashboard)
}

/** A creator's page, with the handle filled into the route's :handle segment. */
export function creatorUrl(edition: EditionConfig, handle: string): string {
  return join(edition, edition.routes.creator.replace(':handle', encodeURIComponent(handle)))
}

export type RouteName = keyof Routes

/** A new tab on the web; the system browser through the host on desktop. */
export async function openExternal(host: Host, url: string): Promise<void> {
  const auth = (host as EditionHost).auth
  if (auth) await openSafely(url, (u) => auth.openExternal(u))
  else window.open(url, '_blank', 'noopener')
}

/**
 * The store README's Privacy section: the edition's own privacy page when it
 * has one, otherwise the README in the source the build came from.
 */
export function privacyUrl(edition: EditionConfig, sourceUrl: string): string {
  return privacyPage(edition, sourceUrl)
}
