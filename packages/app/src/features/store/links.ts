// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How creator links read on a page: a plain icon and a readable label, never the raw URL.
import type { CreatorLink, CreatorLinkKind } from '@slicerx/contracts'
import type { IconName } from '@slicerx/ui'

export const LINK_KIND_INFO: Record<CreatorLinkKind, { label: string; icon: IconName }> = {
  website: { label: 'Website', icon: 'globe' },
  patreon: { label: 'Patreon', icon: 'sponsor' },
  makerworld: { label: 'MakerWorld', icon: 'cube' },
  printables: { label: 'Printables', icon: 'cube' },
  thingiverse: { label: 'Thingiverse', icon: 'cube' },
  cults3d: { label: 'Cults3D', icon: 'cube' },
  youtube: { label: 'YouTube', icon: 'play' },
  instagram: { label: 'Instagram', icon: 'camera' },
  tiktok: { label: 'TikTok', icon: 'record' },
  x: { label: 'X', icon: 'comment' },
  discord: { label: 'Discord', icon: 'comment' },
  github: { label: 'GitHub', icon: 'terminal' },
  kofi: { label: 'Ko-fi', icon: 'donate-coffee' },
  buymeacoffee: { label: 'Buy Me a Coffee', icon: 'donate-coffee' },
  other: { label: 'Link', icon: 'link' },
}

/** Kinds in the order the editor offers them: support first, then other libraries, then social. */
export const LINK_KINDS: CreatorLinkKind[] = ['patreon', 'kofi', 'buymeacoffee', 'makerworld', 'printables', 'thingiverse', 'cults3d', 'website', 'youtube', 'instagram', 'tiktok', 'x', 'discord', 'github', 'other']

function host(url: string): string | undefined {
  return /^https:\/\/([^/:?#]+)/i.exec(url)?.[1]?.replace(/^www\./i, '')
}

/** The bold line of a link row: the service's name, or the bare host for a website or other link. */
export function linkTitle(link: Pick<CreatorLink, 'kind' | 'url'>): string {
  if (link.kind === 'website' || link.kind === 'other') return host(link.url) ?? LINK_KIND_INFO[link.kind].label
  return LINK_KIND_INFO[link.kind].label
}

/** The small line under it: the creator's label, else "Website", else "<name> on <service>". */
export function linkSubtitle(link: Pick<CreatorLink, 'kind' | 'label' | 'url'>, name: string): string {
  const label = link.label?.trim()
  // A label that only repeats the bold line says nothing new.
  if (label && label.toLowerCase() !== linkTitle(link).toLowerCase()) return label
  if (link.kind === 'website' || link.kind === 'other') return LINK_KIND_INFO[link.kind].label
  return `${name} on ${LINK_KIND_INFO[link.kind].label}`
}

/** One line of text for a link: the creator's label, else the service name, else the bare host for a website or other link. */
export function linkText(link: Pick<CreatorLink, 'kind' | 'label' | 'url'>): string {
  if (link.label?.trim()) return link.label.trim()
  return linkTitle(link)
}
