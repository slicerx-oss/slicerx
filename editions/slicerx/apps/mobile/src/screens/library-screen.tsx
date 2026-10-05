// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The free library: models anyone can share, browsable without an account. Virtualized, searchable,
// filtered by tag, with pull to refresh. Tapping a model opens its page.
import { useMemo, useState } from 'react'
import { FlatList, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Button, Chip, IconButton } from '../components/button'
import { haptic } from '../components/feedback'
import { Icon } from '../components/icon'
import { EmptyState, Row, Screen, ScreenHeader } from '../components/layout'
import { SkeletonRows } from '../components/status'
import { font, t } from '../components/theme'
import { Thumb } from '../components/thumb'

export interface LibraryEntry {
  id: string
  /** The listing slug, for the model page. */
  slug: string
  name: string
  format: '3mf' | 'stl' | 'sx3mf'
  tags: string[]
  thumbUri?: string | undefined
  creator?: string | undefined
}

export interface LibraryScreenProps {
  entries: LibraryEntry[]
  loading: boolean
  /** The catalog could not be reached. */
  failed?: boolean | undefined
  /** This build has no library (the edition ships without the store module). */
  unavailable?: boolean | undefined
  refreshing: boolean
  onRefresh: () => void
  onOpen: (entry: LibraryEntry) => void
  onImport: () => void
}

const MAX_TAGS = 8

/** The most used tags first, for the filter chips. */
export function topTags(entries: LibraryEntry[]): string[] {
  const count = new Map<string, number>()
  for (const e of entries) for (const tag of new Set(e.tags)) count.set(tag, (count.get(tag) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TAGS).map(([tag]) => tag)
}

export function filterEntries(entries: LibraryEntry[], query: string, tag: string | null): LibraryEntry[] {
  const q = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (tag && !e.tags.includes(tag)) return false
    return !q || e.name.toLowerCase().includes(q) || (e.creator ?? '').toLowerCase().includes(q) || e.tags.some((x) => x.toLowerCase().includes(q))
  })
}

export function LibraryScreen(p: LibraryScreenProps) {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const shown = useMemo(() => filterEntries(p.entries, query, tag), [p.entries, query, tag])
  const tags = useMemo(() => topTags(p.entries), [p.entries])

  const header = <ScreenHeader title="Library" subtitle={p.loading ? 'Loading' : `${p.entries.length} free models`} actions={<IconButton icon="import" label="Import a file" onPress={p.onImport} />} />

  if (p.unavailable) {
    return (
      <Screen header={header} scroll={false} testID="library-screen">
        <EmptyState icon="library" title="No library in this build" detail="You can still send a 3MF or STL from your files to a printer." action={<Button label="Import a file" icon="import" kind="primary" onPress={p.onImport} />} />
      </Screen>
    )
  }

  return (
    <Screen header={header} scroll={false} testID="library-screen">
      <View style={styles.search}>
        <Icon name="search" size={18} color={t.color.dim} />
        <TextInput
          nativeID="library-search"
          testID="library-search"
          aria-label="Search the library"
          placeholder="Search models, creators and tags"
          placeholderTextColor={t.color.dim}
          selectionColor={t.color.purple}
          keyboardAppearance="dark"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          style={styles.input}
          autoCorrect={false}
        />
        {query ? <IconButton icon="close" label="Clear search" size={18} onPress={() => setQuery('')} /> : null}
      </View>
      {tags.length > 0 ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: t.gutter, paddingBottom: t.space(1.5) }}>
            <Chip label="All" selected={tag === null} onPress={() => setTag(null)} testID="tag-all" />
            {tags.map((x) => (
              <Chip key={x} label={x} selected={tag === x} onPress={() => setTag(tag === x ? null : x)} testID={`tag-${x}`} />
            ))}
          </ScrollView>
        </View>
      ) : null}
      {p.loading ? (
        <SkeletonRows count={6} thumb />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(e) => e.id}
          testID="library-list"
          keyboardDismissMode="on-drag"
          style={{ borderTopWidth: 1, borderTopColor: t.color.lineSoft }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.color.lineSoft, marginLeft: t.gutter + 52 + t.space(1.5) }} />}
          refreshControl={
            <RefreshControl
              refreshing={p.refreshing}
              onRefresh={() => {
                haptic.snap()
                p.onRefresh()
              }}
              tintColor={t.color.muted}
              colors={[t.color.purple]}
              progressBackgroundColor={t.color.ink2}
            />
          }
          ListEmptyComponent={
            p.failed ? (
              <EmptyState icon="cloud-off" title="The library did not load" detail="Check your connection, then pull down to try again." action={<Button label="Try again" kind="primary" onPress={p.onRefresh} testID="library-retry" />} />
            ) : (
              <EmptyState
                icon={query || tag ? 'search' : 'library'}
                title={query ? `Nothing matches "${query.trim()}"` : tag ? `No models tagged ${tag}` : 'The library is empty'}
                detail={query || tag ? 'Try a shorter name or another tag.' : 'Models people share appear here. You can also import a 3MF or STL from your files.'}
                action={query || tag ? undefined : <Button label="Import a file" icon="import" kind="primary" onPress={p.onImport} />}
              />
            )
          }
          renderItem={({ item: e }) => (
            <Row
              title={e.name}
              detail={[e.creator, e.format.toUpperCase()].filter(Boolean).join('  ')}
              mono
              leading={<Thumb uri={e.thumbUri} />}
              chevron
              onPress={() => p.onOpen(e)}
              testID={`entry-${e.id}`}
            />
          )}
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: t.gutter,
    marginBottom: t.space(1.5),
    paddingLeft: 12,
    height: 44,
    borderRadius: t.radius.md,
    backgroundColor: t.color.ink2,
    borderWidth: 1,
    borderColor: t.color.lineSoft,
  },
  input: { flex: 1, color: t.color.fg, fontFamily: font.body, fontSize: 16, height: 44 },
})
