// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bottom sheet with drag to dismiss, sized to its content. Needs BottomSheetModalProvider at the
// app root (under GestureHandlerRootView).
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { IconButton } from './button'
import { useReducedMotion } from './feedback'
import { Txt } from './text'
import { t } from './theme'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string | undefined
  /** Line under the title. */
  detail?: string | undefined
  children: ReactNode
  testID?: string | undefined
}

export function Sheet({ open, onClose, title, detail, children, testID }: SheetProps) {
  const ref = useRef<BottomSheetModal>(null)
  const insets = useSafeAreaInsets()
  const reduced = useReducedMotion()

  // The modal is imperative; this keeps it in step with the open prop.
  useEffect(() => {
    if (open) ref.current?.present()
    else ref.current?.dismiss()
  }, [open])

  const backdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" opacity={0.6} />,
    [],
  )

  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={onClose}
      backdropComponent={backdrop}
      enableDynamicSizing
      animateOnMount={!reduced}
      backgroundStyle={styles.bg}
      handleIndicatorStyle={styles.handle}
      aria-label={title}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + t.space(2) }} testID={testID}>
        {title ? (
          <View style={styles.head}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="heading" role="heading">
                {title}
              </Txt>
              {detail ? (
                <Txt variant="caption" tone="muted">
                  {detail}
                </Txt>
              ) : null}
            </View>
            <IconButton icon="close" label="Close" onPress={onClose} testID={testID ? `${testID}-close` : undefined} />
          </View>
        ) : null}
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  )
}

const styles = StyleSheet.create({
  bg: { backgroundColor: t.color.ink2, borderTopLeftRadius: t.radius.lg + 4, borderTopRightRadius: t.radius.lg + 4 },
  handle: { backgroundColor: t.color.line, width: 36 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space(1), paddingLeft: t.gutter, paddingRight: t.space(1), paddingBottom: t.space(1.5) },
})
