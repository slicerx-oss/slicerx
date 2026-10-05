// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import '../src/polyfills'
import 'react-native-url-polyfill/auto'
import { HankenGrotesk_400Regular, HankenGrotesk_500Medium, HankenGrotesk_600SemiBold, HankenGrotesk_700Bold } from '@expo-google-fonts/hanken-grotesk'
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono'
import { Unbounded_600SemiBold } from '@expo-google-fonts/unbounded'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { t } from '../src/components/theme'
import { ComputerApprovals } from '../src/data/computer-approvals'
import { PocketProvider } from '../src/data/provider'

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    Unbounded_600SemiBold,
  })
  const ready = fontsLoaded || fontError !== null
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.color.ink0 }}>
      <SafeAreaProvider>
        <PocketProvider>
          <BottomSheetModalProvider>
            <StatusBar style="light" />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.color.ink0 }, animation: 'slide_from_right' }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="printer/[id]" />
              <Stack.Screen name="pilot" />
              <Stack.Screen name="send" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
              <Stack.Screen name="model/[slug]" />
              <Stack.Screen name="creator/[handle]" />
              <Stack.Screen name="notifications" />
              <Stack.Screen name="pair" />
              <Stack.Screen name="auth/callback" options={{ animation: 'none' }} />
            </Stack>
            <ComputerApprovals />
          </BottomSheetModalProvider>
        </PocketProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
