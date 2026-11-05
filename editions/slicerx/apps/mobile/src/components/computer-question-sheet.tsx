// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The question mimir waits on in SlicerX on a paired computer, in the same bottom sheet as the computer's approvals,
// one at a time. A tap answers it on the computer as a click there would; Cancel answers it with no pick. Answering
// unlocks nothing on a printer: anything mimir does next asks for its own approval.
import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { readOnlyLine, type QuestionCard } from '../data/mimir-questions'
import { ChoiceCard } from './pilot/choice-card'
import { Sheet } from './sheet'
import { t } from './theme'

export interface ComputerQuestionSheetProps {
  /** Oldest first. The sheet shows the first one. */
  questions: readonly QuestionCard[]
  onAnswer: (pairingId: string, choiceId: string | null) => Promise<void>
  /** The person closed the sheet: the card goes; the question still waits on the computer. */
  onClose: (pairingId: string) => void
}

export function ComputerQuestionSheet({ questions, onAnswer, onClose }: ComputerQuestionSheetProps) {
  const current = questions[0] ?? null
  const [closed, setClosed] = useState<string | null>(null)
  const shown = useRef<QuestionCard | null>(null)
  if (current) shown.current = current
  const q = current ?? shown.current
  if (!q) return null
  const key = current ? `${current.pairingId}:${current.question.askId}` : null
  const line = readOnlyLine(q)
  return (
    <Sheet
      open={current !== null && closed !== key}
      onClose={() => {
        if (!current) return
        setClosed(key)
        onClose(current.pairingId)
      }}
      title="mimir has a question"
      detail={questions.length > 1 ? `${questions.length} questions waiting` : undefined}
      testID="computer-question-sheet"
    >
      <View style={styles.body}>
        <ChoiceCard
          key={`${q.pairingId}:${q.question.askId}`}
          title={q.question.title}
          question={q.question.question}
          choices={q.question.choices}
          heading={`mimir on ${q.hostName} asks`}
          caption={`Your answer goes to mimir on ${q.hostName}.`}
          answered={q.answered}
          readOnly={line}
          picked={q.mine ? (q.mine.choiceId ?? '') : null}
          onAnswer={(choiceId) => onAnswer(q.pairingId, choiceId)}
          testID="computer-question"
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({ body: { paddingHorizontal: t.gutter } })
