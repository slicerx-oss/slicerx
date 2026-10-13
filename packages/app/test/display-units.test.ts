// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Display units: lengths show in mm or in, data stays in mm. Typed units always work, whatever the setting; a bare
// number takes the shown unit, and a step that follows a named value keeps its unit written in.
import { describe, expect, it } from 'vitest'
import { DEFAULT_UNITS, formatLength, fraction, fromMmText, lengthText, parseLength, readUnits, toMmText, type UnitPrefs } from '../src/cad/units'
import { evaluate, namesIn, withUnit } from '../src/cad/values'

const MM: UnitPrefs = DEFAULT_UNITS
const IN: UnitPrefs = { ...DEFAULT_UNITS, length: 'in' }
const values = { wall: 2, n: 6 }

describe('typed lengths', () => {
  const table: [string, UnitPrefs, number][] = [
    ['25.4mm', IN, 25.4],
    ['25.4 mm', IN, 25.4],
    ['1in', MM, 25.4],
    ['1 in', MM, 25.4],
    ['1"', MM, 25.4],
    ['3/8 in', MM, 9.525],
    ['3/8"', MM, 9.525],
    ['1 1/2"', MM, 38.1],
    ['1 1/2 in', MM, 38.1],
    ['2cm', IN, 20],
    ['0.1m', MM, 100],
    ["1'", MM, 304.8],
    ['1 ft', MM, 304.8],
    ['1 inch', MM, 25.4],
    ['2 inches', MM, 50.8],
    ['1', MM, 1],
    ['1', IN, 25.4],
    ['3/8', IN, 9.525],
    ['1 1/2', IN, 38.1],
    ['2,5', MM, 2.5],
    ['wall * 2', IN, 4],
    ['wall * 2', MM, 4],
    ['wall + 1', IN, 27.4],
    ['wall + 1', MM, 3],
    ['wall + 1mm', IN, 3],
    ['(1 + 1) * wall', IN, 4],
    ['1in + 1', MM, 26.4],
    ['1in + 1', IN, 50.8],
    ['-1/4 in', MM, -6.35],
    ['(3/8)in', MM, 9.525],
  ]
  it.each(table)('%s reads as the right mm', (text, u, mm) => {
    expect(parseLength(text, u, values)).toBeCloseTo(mm, 9)
  })

  it('refuses what does not read', () => {
    for (const bad of ['', 'abc', '1 in in', '2mm in', '1/0 in', '1 +', 'wal * 2', '1 2', '1in2', '(1in)mm']) expect(parseLength(bad, IN, values), bad).toBeNaN()
  })

  it('leaves plain mm arithmetic as it was', () => {
    expect(evaluate('wall * 2 + 1', (n) => (values as Record<string, number>)[n])).toBe(5)
    expect(evaluate('8 / 2 / 2', () => undefined)).toBe(2)
  })

  it('does not count a unit as a name', () => {
    expect(namesIn('1in + wall')).toEqual(['wall'])
    expect(namesIn('3/8 in')).toEqual([])
    expect(namesIn('(1 + 1)mm * m')).toEqual(['m'])
    expect(namesIn('in * 2')).toEqual(['in'])
  })
})

describe('format and parse round trip', () => {
  it('shows mm trimmed to its decimals and inches fixed', () => {
    expect(formatLength(25.4, MM)).toBe('25.4')
    expect(formatLength(10, MM)).toBe('10')
    expect(formatLength(1.23456, MM)).toBe('1.23')
    expect(formatLength(1.23456, { ...MM, mmDigits: 3 })).toBe('1.235')
    expect(formatLength(25.4, IN)).toBe('1.000')
    expect(formatLength(10, IN)).toBe('0.394')
    expect(formatLength(10, { ...IN, inchDigits: 2 })).toBe('0.39')
    expect(formatLength(-0.0001, IN)).toBe('0.000')
    expect(lengthText(25.4, IN)).toBe('1.000 in')
    expect(lengthText(12.5, MM)).toBe('12.5 mm')
  })

  it('shows inch fractions reduced', () => {
    expect(fraction(1.5, 64)).toBe('1 1/2')
    expect(fraction(0.375, 64)).toBe('3/8')
    expect(fraction(2, 16)).toBe('2')
    expect(fraction(-1.25, 16)).toBe('-1 1/4')
    expect(fraction(0, 16)).toBe('0')
    expect(formatLength(38.1, { ...IN, inchFraction: 64 })).toBe('1 1/2')
    expect(formatLength(1, { ...IN, inchFraction: 16 })).toBe('1/16')
  })

  const cases = [0, 0.1, 1, 9.525, 25.4, 38.1, 100, 254.03, -6.35]
  it.each([2, 3, 4])('reads back what it shows, %i decimals in inches and mm', (d) => {
    for (const u of [{ ...IN, inchDigits: d }, { ...MM, mmDigits: d }]) {
      for (const mm of cases) {
        const back = parseLength(formatLength(mm, u), u)
        expect(Math.abs(back - mm)).toBeLessThanOrEqual(0.5 * 10 ** -d * (u.length === 'in' ? 25.4 : 1) + 1e-9)
        // and the shown text is stable from there
        expect(formatLength(back, u)).toBe(formatLength(mm, u))
      }
    }
  })

  it('reads back fractions', () => {
    const u = { ...IN, inchFraction: 64 }
    for (const mm of [9.525, 38.1, 25.4, 0.396875]) expect(parseLength(formatLength(mm, u), u)).toBeCloseTo(mm, 9)
  })
})

describe('field text stays mm', () => {
  it('turns typed text into mm text, and back for showing', () => {
    expect(toMmText('1', IN)).toBe('25.4')
    expect(toMmText('1"', IN)).toBe('25.4')
    expect(Number(toMmText('3/8', IN))).toBeCloseTo(9.525, 9)
    expect(toMmText('1', MM)).toBe('1')
    expect(toMmText('1 +', IN)).toBe('1 +')
    expect(fromMmText('25.4', IN)).toBe('1.000')
    expect(fromMmText('25.4', MM)).toBe('25.4')
    expect(fromMmText('wall * 2', IN)).toBe('wall * 2')
  })

  it('writes the shown unit on bare numbers of an expression, so it reads the same in mm', () => {
    const look = (n: string) => (values as Record<string, number>)[n]
    const cases: [string, string][] = [
      ['wall + 1', 'wall + 1in'],
      ['wall * 2', 'wall * 2'],
      ['wall + 3/8', 'wall + 3/8in'],
      ['wall + 1 1/2', 'wall + 1 1/2in'],
      ['wall + 2 * 3', 'wall + (2 * 3)in'],
      ['wall - (1 + 1)', 'wall - ((1 + 1))in'],
      ['wall + 1mm', 'wall + 1mm'],
    ]
    for (const [typed, stored] of cases) {
      expect(withUnit(typed, 'in', look)).toBe(stored)
      expect(evaluate(stored, look)).toBeCloseTo(parseLength(typed, IN, values), 9)
    }
    expect(toMmText('wall + 1', IN, values)).toBe('wall + 1in')
  })
})

describe('saved units', () => {
  it('reads good values and drops bad ones', () => {
    expect(readUnits({ length: 'in', mmDigits: 1, inchDigits: 4, inchFraction: 32 })).toEqual({ length: 'in', mmDigits: 1, inchDigits: 4, inchFraction: 32 })
    expect(readUnits({ length: 'in' })).toEqual({ ...DEFAULT_UNITS, length: 'in' })
    expect(readUnits({ length: 'ft' })).toBeUndefined()
    expect(readUnits({ length: 'mm', mmDigits: 99, inchFraction: 3 })).toEqual(DEFAULT_UNITS)
    expect(readUnits(null)).toBeUndefined()
  })
})
