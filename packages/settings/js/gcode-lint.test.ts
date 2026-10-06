// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lintGcode, type LintLimits, type LintSection, type LintTrust } from './gcode-lint'

interface Case {
  text: string
  section: LintSection
  trust: LintTrust
  limits: LintLimits
  expect: [number, string, string][]
}

const cases = (JSON.parse(readFileSync(new URL('../../core/tests/gcode_lint_cases.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases

describe('the G-code linter', () => {
  it('finds what the engine finds in every shared case', () => {
    expect(cases.length).toBeGreaterThan(30)
    for (const c of cases) expect(lintGcode(c.text, c.section, c.trust, c.limits).map((f) => [f.line, f.code, f.severity]), JSON.stringify(c.text)).toEqual(c.expect)
  })

  it('reads template text: placeholders are unknown values, not errors', () => {
    const t = (text: string, section: LintSection = 'start', trust: LintTrust = 'untrusted') => lintGcode(text, section, trust, {}, { template: true }).map((f) => f.code)
    expect(t('M104 S[nozzle_temperature_initial_layer]\nM109 S{nozzle_temperature[0]}\nM190 D[bed_temperature_initial_layer_single]')).toEqual([])
    expect(t('{if curr_bed_type=="Textured PEI Plate"}\nG29.1 Z{-0.02}\n{endif}')).toEqual([])
    // A command behind a placeholder is still the command.
    expect(t('{if true}M500{endif}')).toEqual(['eeprom_write'])
    expect(t('M500 ; [save]')).toEqual(['eeprom_write'])
    expect(t('M104 S999 ; {x}', 'start', 'trusted')).toEqual(['nozzle_over_limit'])
  })
})
