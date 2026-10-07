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

/** The text a link shows: the creator's label, else the service name, else the bare host for a website or other link. */
export function linkText(link: Pick<CreatorLink, 'kind' | 'label' | 'url'>): string {
  if (link.label?.trim()) return link.label.trim()
  if (link.kind === 'website' || link.kind === 'other') {
    const host = /^https:\/\/([^/:?#]+)/i.exec(link.url)?.[1]?.replace(/^www\./i, '')
    if (host) return host
  }
  return LINK_KIND_INFO[link.kind].label
}
