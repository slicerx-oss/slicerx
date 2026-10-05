// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { Chip } from '../button'
import { haptic } from '../feedback'
import { Icon } from '../icon'
import { font, t } from '../theme'

export interface Suggestion {
  id: string
  label: string
  prompt: string
}

export interface ComposerProps {
  onSend: (text: string) => void
  onStop: () => void
  running: boolean
  suggestions?: Suggestion[]
  disabled?: boolean
  placeholder?: string
}

export function Composer({ onSend, onStop, running, suggestions, disabled, placeholder = 'Ask mimir to plan, slice or check a printer' }: ComposerProps) {
  const [text, setText] = useState('')
  const canSend = text.trim().length > 0 && !disabled && !running
  const send = (value: string) => {
    const v = value.trim()
    if (!v || running || disabled) return
    haptic.tap()
    onSend(v)
    setText('')
  }
  return (
    <View style={styles.wrap}>
      {suggestions && suggestions.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          {suggestions.map((s) => (
            <Chip key={s.id} label={s.label} onPress={() => send(s.prompt)} testID={`suggest-${s.id}`} />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        <TextInput
          nativeID="pilot-input"
          testID="pilot-input"
          aria-label="Message mimir"
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={t.color.dim}
          selectionColor={t.color.purple}
          keyboardAppearance="dark"
          multiline
          editable={disabled !== true}
          style={styles.input}
          maxFontSizeMultiplier={1.6}
          onSubmitEditing={() => send(text)}
          blurOnSubmit={false}
        />
        {running ? (
          <Pressable role="button" aria-label="Stop mimir" testID="pilot-stop" onPress={onStop} style={[styles.send, styles.stop]} hitSlop={6}>
            <Icon name="stop" size={18} color={t.color.fg} />
          </Pressable>
        ) : (
          <Pressable
            role="button"
            aria-label="Send"
            aria-disabled={!canSend}
            testID="pilot-send"
            disabled={!canSend}
            onPress={() => send(text)}
            style={[styles.send, canSend ? null : styles.sendOff]}
            hitSlop={6}
          >
            <Icon name="arrow-up" size={20} color={canSend ? t.color.onGrad : t.color.dim} stroke={2.2} />
          </Pressable>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: t.color.lineSoft, backgroundColor: t.color.ink0, paddingTop: 10, paddingBottom: 10, gap: 10 },
  chips: { gap: 8, paddingHorizontal: t.gutter },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: t.gutter - 4,
    paddingLeft: 14,
    paddingRight: 5,
    paddingVertical: 5,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: t.color.line,
    backgroundColor: t.color.ink2,
  },
  input: { flex: 1, minHeight: 34, maxHeight: 132, paddingTop: 7, paddingBottom: 7, color: t.color.fg, fontFamily: font.body, fontSize: 16, lineHeight: 22 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: t.color.purple },
  sendOff: { backgroundColor: t.color.ink4 },
  stop: { backgroundColor: t.color.ink4 },
})
