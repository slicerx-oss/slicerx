// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir names a printer setting with the words the Printer settings dialog shows, so a plan's change list and the
// dialog never disagree about what a row is called.
import { describe, expect, it } from 'vitest'
import { settingDef } from '@slicerx/settings'
import kbIndex from '../src/kb/generated/kb.json' with { type: 'json' }
import { createKnowledgeBase, type KbIndex } from '../src/kb/kb'

const kb = createKnowledgeBase(kbIndex as KbIndex)
const printer = kb.settings().filter((s) => settingDef(s.key)?.section === 'printer')

describe('printer setting labels in the knowledge base', () => {
  it('has printer settings in the catalog', () => {
    expect(printer.length).toBeGreaterThan(5)
  })

  it('labels every printer setting as the settings schema does', () => {
    expect(printer.filter((s) => s.label !== settingDef(s.key)!.label).map((s) => `${s.key}: ${s.label}`)).toEqual([])
  })

  it('looks a printer setting up by the same label', () => {
    for (const s of printer) expect(kb.setting(s.key)?.label, s.key).toBe(settingDef(s.key)!.label)
  })
})
