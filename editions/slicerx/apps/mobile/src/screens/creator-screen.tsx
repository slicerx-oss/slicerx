// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A creator page: who they are, where else to find them (their own links), and their free models.
import { StyleSheet, View } from 'react-native'
import { Button, IconButton } from '../components/button'
import { EmptyState, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { SkeletonRows } from '../components/status'
import { Txt } from '../components/text'
import { t } from '../components/theme'
import { Thumb } from '../components/thumb'
import type { LibraryEntry } from './library-screen'

export interface CreatorLink {
  label: string
  /** An https address, already checked by safeLinkUrl. */
  url: string
}

export interface CreatorDetail {
  name: string
  tagline?: string | undefined
  bio?: string | undefined
  avatarUri?: string | undefined
  followers: number
}

export interface CreatorScreenProps {
  creator: CreatorDetail | null
  links: CreatorLink[]
  models: LibraryEntry[]
  loading: boolean
  failed?: boolean | undefined
  onBack: () => void
  onRetry: () => void
  onOpenLink: (url: string) => void
  onOpenModel: (entry: LibraryEntry) => void
}

const KNOWN: [RegExp, string][] = [
  [/(^|\.)patreon\.com$/, 'Patreon'],
  [/(^|\.)makerworld\.com$/, 'MakerWorld'],
  [/(^|\.)printables\.com$/, 'Printables'],
  [/(^|\.)thingiverse\.com$/, 'Thingiverse'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)ko-fi\.com$/, 'Ko-fi'],
  [/(^|\.)buymeacoffee\.com$/, 'Buy Me a Coffee'],
]

/** Only https links open, and never ones that carry credentials. Anything else is dropped. */
export function safeLinkUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null
  return u.toString()
}

/** Cleans a creator's links: keeps safe ones, names them by site when the creator gave no label. */
export function cleanLinks(raw: { label?: string | undefined; url: string }[]): CreatorLink[] {
  const out: CreatorLink[] = []
  for (const l of raw) {
    const url = safeLinkUrl(l.url)
    if (!url) continue
    const host = new URL(url).hostname.replace(/^www\./, '')
    const label = l.label?.trim() || KNOWN.find(([re]) => re.test(host))?.[1] || host
    out.push({ label, url })
  }
  return out
}

export function CreatorScreen(p: CreatorScreenProps) {
  const back = <IconButton icon="arrow-left" label="Back" onPress={p.onBack} testID="creator-back" />
  const c = p.creator
  if (!c) {
    return (
      <Screen header={<ScreenHeader title="Creator" leading={back} />} testID="creator-screen">
        {p.loading ? (
          <SkeletonRows count={4} thumb />
        ) : (
          <EmptyState
            icon={p.failed ? 'cloud-off' : 'search'}
            title={p.failed ? 'This page did not load' : 'Creator not found'}
            detail={p.failed ? 'Check your connection and try again.' : undefined}
            action={p.failed ? <Button label="Try again" kind="primary" onPress={p.onRetry} testID="creator-retry" /> : undefined}
          />
        )}
      </Screen>
    )
  }
  return (
    <Screen header={<ScreenHeader title={c.name} subtitle={c.tagline} leading={back} />} testID="creator-screen">
      <View style={styles.top}>
        <Thumb uri={c.avatarUri} size={72} icon="creator" />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="caption" tone="muted">{`${c.followers} ${c.followers === 1 ? 'follower' : 'followers'}`}</Txt>
        </View>
      </View>
      {c.bio ? (
        <Txt variant="body" tone="muted" style={styles.pad} testID="creator-bio">
          {c.bio}
        </Txt>
      ) : null}

      {p.links.length > 0 ? (
        <>
          <SectionLabel label="Find them elsewhere" />
          {p.links.map((l) => (
            <Row key={l.url} title={l.label} detail={new URL(l.url).hostname.replace(/^www\./, '')} icon="external" chevron onPress={() => p.onOpenLink(l.url)} accessibilityHint="Opens in your browser" testID={`link-${l.label}`} />
          ))}
        </>
      ) : null}

      <SectionLabel label="Models" />
      {p.models.length === 0 ? (
        <Txt variant="caption" tone="dim" style={styles.pad}>
          No models yet.
        </Txt>
      ) : (
        p.models.map((e) => <Row key={e.id} title={e.name} detail={e.format.toUpperCase()} mono leading={<Thumb uri={e.thumbUri} />} chevron onPress={() => p.onOpenModel(e)} testID={`entry-${e.id}`} />)
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: t.space(2), paddingHorizontal: t.gutter, paddingBottom: t.space(1.5) },
  pad: { paddingHorizontal: t.gutter },
})
