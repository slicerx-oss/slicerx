// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's older ensure_vertical_shell_thickness switch values, as the app opens them. The engine reads the same
// values given raw as it reads these (packages/settings/tests/shell_thickness_legacy.rs slices both).
import { describe, expect, it } from 'vitest'
import { projectSettingChanges } from './project-open'

describe('an older ensure_vertical_shell_thickness switch in a project', () => {
  it.each([
    ['0', 'ensure_moderate'],
    ['1', 'ensure_all'],
    ['true', 'true'],
    ['false', 'false'],
  ])('%s opens as %s', (raw, opened) => {
    const r = projectSettingChanges({ ensure_vertical_shell_thickness: raw }, {} as never)
    expect(r.taken['ensure_vertical_shell_thickness']).toBe(opened)
  })
})
