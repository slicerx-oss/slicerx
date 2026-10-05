// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sign in with the methods the edition offers (AuthClient.signInMethods()). Email sends a magic
// link; providers open the system browser. With no methods (offline or demo builds) it says so
// instead of showing buttons that cannot work.
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { AuthProvider, SignInMethod, StoreResult } from '@slicerx/contracts'
import { Button } from './button'
import { Txt } from './text'
import { font, t } from './theme'

export interface SignInProps {
  methods: readonly SignInMethod[]
  onEmail: (email: string) => Promise<StoreResult<void>>
  onProvider: (provider: AuthProvider) => Promise<StoreResult<void>>
  /** Line above the form: why signing in helps here. */
  reason?: string | undefined
}

const PROVIDER_LABEL: Record<AuthProvider, string> = { github: 'GitHub', google: 'Google', apple: 'Apple', discord: 'Discord' }

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

export function SignIn({ methods, onEmail, onProvider, reason }: SignInProps) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState<SignInMethod | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const providers = methods.filter((m): m is AuthProvider => m !== 'email')

  const run = (method: SignInMethod, call: () => Promise<StoreResult<void>>, onOk?: () => void) => {
    setBusy(method)
    setError(null)
    call()
      .then((r) => {
        if (r.ok) onOk?.()
        else setError(r.message)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not sign in. Try again'))
      .finally(() => setBusy(null))
  }

  if (methods.length === 0) {
    return (
      <Txt variant="caption" tone="muted" testID="sign-in-unavailable">
        Sign-in is not available in this build. Printers on paired computers still work.
      </Txt>
    )
  }

  if (sentTo) {
    return (
      <View style={{ gap: 8 }} testID="sign-in-sent">
        <Txt variant="bodyMedium">Check your email</Txt>
        <Txt variant="caption" tone="muted">{`We sent a sign-in link to ${sentTo}. Open it on this phone.`}</Txt>
        <Button label="Use another email" kind="ghost" onPress={() => setSentTo(null)} />
      </View>
    )
  }

  const trimmed = email.trim()
  return (
    <View style={{ gap: 10 }}>
      {reason ? (
        <Txt variant="caption" tone="muted">
          {reason}
        </Txt>
      ) : null}
      {methods.includes('email') ? (
        <>
          <TextInput
            nativeID="sign-in-email"
            testID="sign-in-email"
            aria-label="Email"
            placeholder="you@example.com"
            placeholderTextColor={t.color.dim}
            selectionColor={t.color.purple}
            keyboardAppearance="dark"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            autoCorrect={false}
            value={email}
            onChangeText={setEmail}
            returnKeyType="send"
            onSubmitEditing={() => {
              if (looksLikeEmail(trimmed)) run('email', () => onEmail(trimmed), () => setSentTo(trimmed))
            }}
            style={styles.input}
          />
          <Button
            label="Email me a sign-in link"
            kind="primary"
            block
            busy={busy === 'email'}
            disabled={!looksLikeEmail(trimmed) || busy !== null}
            onPress={() => run('email', () => onEmail(trimmed), () => setSentTo(trimmed))}
            testID="sign-in-send"
          />
        </>
      ) : null}
      {providers.map((pr) => (
        <Button
          key={pr}
          label={`Continue with ${PROVIDER_LABEL[pr]}`}
          kind="secondary"
          block
          busy={busy === pr}
          disabled={busy !== null}
          onPress={() => run(pr, () => onProvider(pr))}
          testID={`sign-in-${pr}`}
        />
      ))}
      {error ? (
        <Txt variant="caption" color={t.color.orange} aria-live="polite" testID="sign-in-error">
          {error}
        </Txt>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  input: {
    height: t.hit + 4,
    paddingHorizontal: 14,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.color.line,
    backgroundColor: t.color.ink2,
    color: t.color.fg,
    fontFamily: font.body,
    fontSize: 16,
  },
})
