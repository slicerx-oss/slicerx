// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Native module stand-ins for component tests (listed in the jest setupFiles).

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}))

jest.mock('expo-camera', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native')
  return { CameraView: View }
})

jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default)

// The real sheet needs Reanimated and a native gesture root. The stand-in renders its content
// while open, which is what the tests assert on.
jest.mock('@gorhom/bottom-sheet', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const { View } = jest.requireActual<typeof import('react-native')>('react-native')
  const BottomSheetModal = React.forwardRef(function BottomSheetModal(
    props: { children: React.ReactNode; onDismiss?: () => void },
    ref: React.Ref<{ present: () => void; dismiss: () => void }>,
  ) {
    const [open, setOpen] = React.useState(false)
    React.useImperativeHandle(ref, () => ({ present: () => setOpen(true), dismiss: () => setOpen(false) }))
    return open ? React.createElement(View, null, props.children) : null
  })
  return {
    BottomSheetModal,
    BottomSheetView: View,
    BottomSheetBackdrop: () => null,
    BottomSheetModalProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})

// The preference store persists to AsyncStorage; the official mock keeps it in memory.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'))
