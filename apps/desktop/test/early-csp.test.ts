// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A bridge build's window collects content security refusals from the very start of the page (agent_bridge/window.rs)
// and the page's recorder takes them over (packages/app/src/agent-bridge/capture.ts). Both sides must use one name.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('early content security refusals', () => {
  it('are collected by the bridge window under the name the recorder drains', () => {
    const window = read('../src-tauri/src/agent_bridge/window.rs')
    const capture = read('../../../packages/app/src/agent-bridge/capture.ts')
    expect(window).toMatch(/initialization_script\(EARLY_CSP\)/)
    expect(window).toMatch(/document\.addEventListener\('securitypolicyviolation'/)
    expect(window).toContain('window.__sxEarlyCsp = kept')
    expect(capture).toContain('__sxEarlyCsp')
  })

  it('stays out of the shell outside the bridge module', () => {
    const main = read('../src-tauri/src/main.rs')
    expect(main).not.toContain('EARLY_CSP')
    expect(read('../src-tauri/src/agent_bridge/mod.rs')).toContain('mod window')
  })
})
