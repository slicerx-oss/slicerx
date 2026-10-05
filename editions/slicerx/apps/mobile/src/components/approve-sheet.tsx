// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A bottom sheet that states exactly what will happen, then runs it on one tap. Used for pause,
// resume, cancel, sending a print and deleting an account.
import { StyleSheet, View } from 'react-native'
import { Button } from './button'
import { Sheet } from './sheet'
import { Txt } from './text'
import { t } from './theme'
import { useApproval } from './use-approval'

export interface ApproveSheetProps {
  open: boolean
  onClose: () => void
  title: string
  lines: string[]
  /** Button text, such as "Pause" or "Cancel print". */
  confirmLabel: string
  /** Danger for actions that cannot be undone. */
  danger?: boolean | undefined
  onConfirm: () => Promise<void>
  testID?: string | undefined
}

export function ApproveSheet({ open, onClose, title, lines, confirmLabel, danger, onConfirm, testID = 'approve-sheet' }: ApproveSheetProps) {
  const device = useApproval()
  const close = () => {
    device.clearError()
    onClose()
  }
  return (
    <Sheet open={open} onClose={close} title={title} testID={testID}>
      <View style={styles.body}>
        {lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={styles.bullet} />
            <Txt variant="caption" tone="muted" style={{ flex: 1, fontSize: 15, lineHeight: 22 }}>
              {l}
            </Txt>
          </View>
        ))}
        {device.error ? (
          <Txt variant="caption" color={t.color.orange} aria-live="polite" testID={`${testID}-error`}>
            {device.error}
          </Txt>
        ) : null}
        <View style={styles.actions}>
          <Button
            label={confirmLabel}
            kind={danger ? 'danger' : 'primary'}
            icon="approve"
            size="lg"
            block
            busy={device.busy}
            testID={`${testID}-confirm`}
            onPress={() => {
              void device.approve(onConfirm).then((ran) => {
                if (ran) onClose()
              })
            }}
          />
        </View>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: t.gutter, gap: 8 },
  bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.color.line, marginTop: 9 },
  actions: { flexDirection: 'row', marginTop: t.space(2) },
})
