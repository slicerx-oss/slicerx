// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One library model: cover, creator, description, tested print profiles, and Print.
import { StyleSheet, View } from 'react-native'
import { Button, IconButton } from '../components/button'
import { Icon } from '../components/icon'
import { EmptyState, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { SkeletonRows } from '../components/status'
import { Txt } from '../components/text'
import { font, t } from '../components/theme'
import { Thumb } from '../components/thumb'

export interface ModelDetail {
  id: string
  title: string
  description?: string | undefined
  coverUri?: string | undefined
  creator: { name: string; handle: string; avatarUri?: string | undefined }
  tags: string[]
  format?: string | undefined
  /** Version label such as "1.2". */
  version?: string | undefined
  sizeLabel?: string | undefined
  changelog?: string | undefined
  /** Settings the creator tested, one line each. */
  profiles: { printer: string; detail: string }[]
  likes?: number | undefined
  makes?: number | undefined
}

export interface ModelScreenProps {
  model: ModelDetail | null
  loading: boolean
  failed?: boolean | undefined
  onBack: () => void
  onRetry: () => void
  onOpenCreator: (handle: string) => void
  onSend: () => void
}

export function ModelScreen(p: ModelScreenProps) {
  const back = <IconButton icon="arrow-left" label="Back" onPress={p.onBack} testID="model-back" />
  const m = p.model
  if (!m) {
    return (
      <Screen header={<ScreenHeader title="Model" leading={back} />} testID="model-screen">
        {p.loading ? (
          <SkeletonRows count={4} thumb />
        ) : (
          <EmptyState
            icon={p.failed ? 'cloud-off' : 'search'}
            title={p.failed ? 'This model did not load' : 'Model not found'}
            detail={p.failed ? 'Check your connection and try again.' : 'It may have been removed by its creator.'}
            action={p.failed ? <Button label="Try again" kind="primary" onPress={p.onRetry} testID="model-retry" /> : undefined}
          />
        )}
      </Screen>
    )
  }
  const facts = [m.format ? m.format.toUpperCase() : null, m.version ? `version ${m.version}` : null, m.sizeLabel ?? null].filter(Boolean).join('  ')
  return (
    <Screen
      header={<ScreenHeader title={m.title} leading={back} />}
      testID="model-screen"
      footer={
        <View style={styles.footer}>
          <Button label="Print" icon="send-to-printer" kind="primary" size="lg" block onPress={p.onSend} testID="model-send" />
        </View>
      }
    >
      <View style={styles.top}>
        <Thumb uri={m.coverUri} size={96} />
        <View style={{ flex: 1, gap: 4, justifyContent: 'center' }}>
          {facts ? (
            <Txt variant="mono" tone="muted" style={{ fontSize: 12.5 }}>
              {facts}
            </Txt>
          ) : null}
          {m.likes !== undefined || m.makes !== undefined ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {m.likes !== undefined ? <Count icon="heart" n={m.likes} label="likes" /> : null}
              {m.makes !== undefined ? <Count icon="check" n={m.makes} label="makes" /> : null}
            </View>
          ) : null}
        </View>
      </View>
      {m.description ? (
        <Txt variant="body" tone="muted" style={styles.pad} testID="model-description">
          {m.description}
        </Txt>
      ) : null}
      {m.tags.length > 0 ? (
        <Txt variant="caption" tone="dim" style={[styles.pad, { paddingTop: t.space(1) }]}>
          {m.tags.map((x) => `#${x}`).join('  ')}
        </Txt>
      ) : null}

      <SectionLabel label="Creator" />
      <Row
        title={m.creator.name}
        detail="See their page and links"
        leading={<Thumb uri={m.creator.avatarUri} size={40} icon="creator" />}
        chevron
        onPress={() => p.onOpenCreator(m.creator.handle)}
        testID="model-creator"
      />

      {m.profiles.length > 0 ? (
        <>
          <SectionLabel label="Tested settings" />
          {m.profiles.map((pr, i) => (
            <Row key={i} title={pr.printer} detail={pr.detail} mono testID={`profile-${i}`} />
          ))}
        </>
      ) : null}

      {m.changelog ? (
        <>
          <SectionLabel label="What changed" />
          <Txt variant="caption" tone="muted" style={styles.pad}>
            {m.changelog}
          </Txt>
        </>
      ) : null}
    </Screen>
  )
}

function Count({ icon, n, label }: { icon: 'heart' | 'check'; n: number; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} aria-label={`${n} ${label}`}>
      <Icon name={icon} size={14} color={t.color.dim} />
      <Txt variant="mono" tone="muted" style={{ fontFamily: font.monoMedium, fontSize: 12.5 }}>
        {String(n)}
      </Txt>
    </View>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', gap: t.space(2), paddingHorizontal: t.gutter, paddingBottom: t.space(1.5) },
  pad: { paddingHorizontal: t.gutter },
  footer: { paddingHorizontal: t.gutter, paddingTop: t.space(1) },
})
