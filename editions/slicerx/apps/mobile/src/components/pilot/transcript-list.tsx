// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The conversation as one inverted list, so the newest line stays pinned above the composer while
// mimir streams, and older turns load as the person scrolls up.
import { useMemo, type ReactElement } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ApprovalCard } from './approval-card'
import { Bubble, Citations, Diff, ErrorLine, PermLine, PlanList, PluginsLoading, Say, Summary, Think, ToolGroup, Who } from './blocks'
import type { Block, Transcript } from './model'
import { t } from '../theme'

type Item =
  | { key: string; kind: 'user'; text: string; where: string | null }
  | { key: string; kind: 'who' }
  | { key: string; kind: 'block'; block: Block; replay: boolean }

/** Flattens turns into list rows, oldest first. */
export function transcriptItems(tr: Transcript): Item[] {
  const out: Item[] = []
  for (const turn of tr.turns) {
    if (turn.user !== null) out.push({ key: `${turn.id}u`, kind: 'user', text: turn.user, where: turn.where })
    if (turn.blocks.length > 0) out.push({ key: `${turn.id}w`, kind: 'who' })
    for (const b of turn.blocks) out.push({ key: `${turn.id}${b.id}`, kind: 'block', block: b, replay: turn.replay })
  }
  return out
}

export interface TranscriptListProps {
  transcript: Transcript
  onApprove: (r: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onDeny: (r: ApprovalRequest) => Promise<void>
  onRetry?: () => void
  /** Shown when there are no turns yet. */
  empty?: ReactElement
}

export function TranscriptList({ transcript, onApprove, onDeny, onRetry, empty }: TranscriptListProps) {
  const data = useMemo(() => transcriptItems(transcript).reverse(), [transcript])
  if (data.length === 0 && empty) return <View style={{ flex: 1 }}>{empty}</View>

  const renderBlock = (b: Block, replay: boolean): ReactElement | null => {
    switch (b.kind) {
      case 'plugins':
        return <PluginsLoading plugins={b.plugins} />
      case 'think':
        return <Think text={b.text} ms={b.ms} />
      case 'say':
        return <Say text={b.text} streaming={b.streaming} />
      case 'plan':
        return <PlanList steps={b.steps} />
      case 'tools':
        return <ToolGroup rows={b.rows} />
      case 'diff':
        return <Diff diff={b.diff} />
      case 'perm':
        return <PermLine permission={b.permission} mode={b.mode} message={b.message} />
      case 'approval':
        return <ApprovalCard request={b.request} resolution={b.resolution} actionable={!replay && !b.replay} onApprove={onApprove} onDeny={onDeny} />
      case 'summary':
        return <Summary title={b.title} rows={b.rows} stopped={b.stopped} ms={b.ms} />
      case 'citations':
        return <Citations items={b.items} />
      case 'error':
        return <ErrorLine message={b.message} retryable={b.retryable} {...(onRetry ? { onRetry } : {})} />
    }
  }

  return (
    <FlatList
      inverted
      data={data}
      keyExtractor={(i) => i.key}
      testID="transcript"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      renderItem={({ item }) => (
        <View style={item.kind === 'user' ? styles.userGap : item.kind === 'who' ? styles.whoGap : styles.blockGap}>
          {item.kind === 'user' ? <Bubble text={item.text} where={item.where} /> : item.kind === 'who' ? <Who /> : renderBlock(item.block, item.replay)}
        </View>
      )}
    />
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: t.gutter, paddingVertical: t.space(2) },
  userGap: { marginTop: 28 },
  whoGap: { marginTop: 22 },
  blockGap: { marginTop: 14 },
})
