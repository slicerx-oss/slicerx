// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { setAssistantBrand } from '@slicerx/contracts'
import { Icon } from '../src/icons/icon'
import { AssistantStyle } from '../src/assistant-style'
import { ThemeProvider } from '../src/theme-provider'
import { subban, subbanLight } from '../src/theme-entry'

afterEach(() => setAssistantBrand())

it('replaces both assistant marks while preserving size and accessible name', () => {
  setAssistantBrand({ name: 'yourmate', icon: 'https://example.com/yourmate.svg' })
  for (const name of ['mimir', 'pilot'] as const) {
    const markup = renderToStaticMarkup(<Icon name={name} size={32} label="yourmate" />)
    expect(markup).toContain('width="32"')
    expect(markup).toContain('aria-label="yourmate"')
    expect(markup).toContain('<image href="https://example.com/yourmate.svg"')
    expect(markup).not.toContain('data-icon-pending')
  }
  expect(renderToStaticMarkup(<Icon name="model" />)).not.toContain('<image')
})

it('keeps the built-in mark by default and scopes each theme accent to assistant surfaces', () => {
  expect(renderToStaticMarkup(<Icon name="mimir" />)).not.toContain('<image')
  expect(renderToStaticMarkup(<AssistantStyle />)).toBe('')
  setAssistantBrand({ accent: { light: '#006b65', dark: '#63e6d4' } })
  for (const [theme, accent] of [[subban, '#63e6d4'], [subbanLight, '#006b65']] as const) {
    const markup = renderToStaticMarkup(<ThemeProvider theme={theme}><AssistantStyle /><Icon name="mimir" /></ThemeProvider>)
    expect(markup).toContain(`--purple: ${accent}`)
    expect(markup).toContain(`color:${accent}`)
    expect(markup).toContain('.sx-pilot')
  }
})
