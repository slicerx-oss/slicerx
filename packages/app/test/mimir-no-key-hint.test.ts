// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// With no model connected, the command bar's mimir row says what the connect card offers here, in the card's words:
// your own API key always, ChatGPT only where the shell can sign in, mimir free and a local model where offered.
import { describe, expect, it } from 'vitest'
import { connectHint, mimirChoices } from '../src/pilot-connect/mimir-choices'

describe('the connect hint', () => {
  it('names only what the connect card offers', () => {
    expect(connectHint(mimirChoices({ signIn: false, localAi: false, skip: false }))).toBe('Connect your own API key (OpenAI or Anthropic) first')
    expect(connectHint(mimirChoices({ signIn: true, localAi: false, skip: false }))).toBe('Connect ChatGPT or your own API key (OpenAI or Anthropic) first')
    expect(connectHint(mimirChoices({ cloud: 'ready', signIn: true, localAi: true, skip: false }))).toBe('Connect mimir free, ChatGPT, your own API key (OpenAI or Anthropic) or a local model first')
    expect(connectHint(mimirChoices({ cloud: 'sign-in', signIn: false, localAi: false, skip: true }))).toBe('Sign in for mimir free, or connect your own API key (OpenAI or Anthropic) first')
  })
})
