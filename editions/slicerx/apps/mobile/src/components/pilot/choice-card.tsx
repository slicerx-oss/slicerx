// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A question mimir asks the person: its choices as full-width buttons and a quiet Cancel. Answering is a tap; the card
// never answers on its own. When it cannot be answered from here (SlicerX on the computer is closed, the computer is out
// of reach, a saved log), the choices show as a plain list with one line that says why. The pressed button stays where
// it is while the answer goes out, and nothing around it moves.
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button } from '../button'
import { Icon } from '../icon'
import { Txt } from '../text'
import { font, t } from '../theme'

export interface ChoiceCardProps {
  /** Card title; the question alone when empty. */
  title?: string | undefined
  question: string
  choices: { id: string; label: string }[]
  /** Line above the title, such as which computer asks. */
  heading?: string | undefined
  /** Under the buttons while it can be answered, such as where the answer goes. */
  caption?: string | undefined
  /** Answers it: a choice id, or null for Cancel. Absent, or with `readOnly` set, the card has no buttons. */
  onAnswer?: ((choiceId: string | null) => Promise<void>) | undefined
  /** Why it cannot be answered here, in one plain line. */
  readOnly?: string | undefined
  /** Set once it was answered: the note shown in place of the buttons. */
  answered?: string | undefined
  /** The pick, for a card answered before it showed here (a saved log): shown in the list. */
  picked?: string | null | undefined
  testID?: string | undefined
}

export function ChoiceCard({ title, question, choices, heading = 'mimir asks', caption, onAnswer, readOnly, answered, picked, testID = 'choice-card' }: ChoiceCardProps) {
  const [sending, setSending] = useState<string | null | undefined>(undefined)
  const [note, setNote] = useState<string | null>(null)
  const live = onAnswer !== undefined && readOnly === undefined && answered === undefined
  const busy = sending !== undefined

  const send = (choiceId: string | null) => {
    if (!onAnswer || busy) return
    setSending(choiceId)
    setNote(null)
    onAnswer(choiceId)
      .catch((e: unknown) => setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSending(undefined))
  }

  return (
    <View style={styles.card} role="summary" aria-label="Question from mimir" testID={testID}>
      <View style={styles.top}>
        <Icon name="pilot" size={16} color={t.color.purple} />
        <Txt variant="caption" tone="muted" style={{ flex: 1 }}>
          {heading}
        </Txt>
      </View>
      {title ? (
        <Txt variant="heading" style={styles.title}>
          {title}
        </Txt>
      ) : null}
      <Txt variant="caption" tone="muted" style={styles.question}>
        {question}
      </Txt>
      {live ? (
        <>
          <View style={styles.choices}>
            {choices.map((c) => (
              <Button key={c.id} label={c.label} kind="secondary" block busy={sending === c.id} disabled={busy} onPress={() => send(c.id)} testID={`${testID}-choice-${c.id}`} />
            ))}
          </View>
          <View style={styles.footer}>
            <Button label="Cancel" kind="ghost" busy={sending === null} disabled={busy} onPress={() => send(null)} testID={`${testID}-cancel`} />
            <Txt variant="caption" tone="dim" style={{ flex: 1 }} aria-live="polite" testID={`${testID}-caption`}>
              {note ?? caption ?? ''}
            </Txt>
          </View>
        </>
      ) : (
        <>
          <View style={styles.list} testID={`${testID}-list`}>
            {choices.map((c) => (
              <View key={c.id} style={styles.item}>
                {c.id === picked ? <Icon name="check" size={14} color={t.color.green} /> : <View style={styles.bullet} />}
                <Txt variant="caption" tone={c.id === picked ? 'fg' : 'muted'} style={{ flex: 1, fontSize: 15, lineHeight: 22 }}>
                  {c.label}
                </Txt>
              </View>
            ))}
          </View>
          <Txt variant="caption" tone="dim" style={styles.line} aria-live="polite" testID={answered !== undefined ? `${testID}-answered` : `${testID}-readonly`}>
            {answered ?? readOnly ?? (picked === '' ? 'Canceled' : picked ? 'Answered' : 'Waiting for an answer on the computer')}
          </Txt>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: t.color.purpleEdge, backgroundColor: t.color.purpleTint, borderRadius: t.radius.md + 2, overflow: 'hidden' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  title: { paddingHorizontal: 16, paddingTop: 8 },
  question: { paddingHorizontal: 16, paddingTop: 4, fontSize: 15, lineHeight: 22 },
  choices: { gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 },
  list: { paddingHorizontal: 16, paddingTop: 10, gap: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 22 },
  bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.color.line, marginHorizontal: 4.5 },
  line: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, fontFamily: font.bodyMedium },
})
