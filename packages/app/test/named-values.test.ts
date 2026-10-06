// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Named values: a project's table of numbers (wall = 2, lip = wall * 1.5) that any typed field can use. Arithmetic
// only: numbers, names, + - * /, parentheses. A value can use others, but not itself through a loop; the built-in
// clearance and nozzle come from the printer and the hole test.
import { describe, expect, it } from 'vitest'
import { bindFor, evaluate, namesIn, resolveValues, validName } from '../src/cad/values'

const get = (v: Record<string, number>) => (n: string) => v[n]

describe('expressions', () => {
  it('does arithmetic with names, precedence and parentheses', () => {
    expect(evaluate('2', get({}))).toBe(2)
    expect(evaluate(' 2,5 ', get({}))).toBe(2.5)
    expect(evaluate('wall * 2 + 1', get({ wall: 1.6 }))).toBeCloseTo(4.2)
    expect(evaluate('(wall + 1) * 2', get({ wall: 1.5 }))).toBe(5)
    expect(evaluate('-wall / 4', get({ wall: 2 }))).toBe(-0.5)
    expect(evaluate('10 - 2 - 3', get({}))).toBe(5)
    expect(evaluate('8 / 2 / 2', get({}))).toBe(2)
    expect(evaluate('.5 + 1.', get({}))).toBe(1.5)
  })

  it('says what is wrong in words', () => {
    expect(() => evaluate('wal * 2', get({ wall: 2 }))).toThrow(/no value named wal/)
    expect(() => evaluate('2 +', get({}))).toThrow(/ends too soon/)
    expect(() => evaluate('(2', get({}))).toThrow(/closing parenthesis/)
    expect(() => evaluate('2 $ 3', get({}))).toThrow(/\$/)
    expect(() => evaluate('1 / 0', get({}))).toThrow(/divides by 0/)
    expect(() => evaluate('', get({}))).toThrow(/empty/)
    expect(() => evaluate('max(1, 2)', get({ max: 1 }))).toThrow()
  })

  it('lists the names an expression uses', () => {
    expect(namesIn('wall * 2 + lip - wall')).toEqual(['wall', 'lip'])
    expect(namesIn('3.5')).toEqual([])
  })
})

describe('the value table', () => {
  it('resolves values that use other values, in any order', () => {
    const r = resolveValues([{ name: 'lip', expr: 'wall * 1.5' }, { name: 'wall', expr: '2' }], { clearance: 0.15, nozzle: 0.4 })
    expect(r.values).toMatchObject({ wall: 2, lip: 3, clearance: 0.15, nozzle: 0.4 })
    expect(r.errors).toEqual({})
  })

  it('reports a loop and a missing name, and keeps the rest', () => {
    const r = resolveValues(
      [
        { name: 'a', expr: 'b + 1' },
        { name: 'b', expr: 'a + 1' },
        { name: 'c', expr: 'nope' },
        { name: 'd', expr: 'clearance * 2' },
      ],
      { clearance: 0.2, nozzle: 0.4 },
    )
    expect(r.errors['a']).toMatch(/uses itself/)
    expect(r.errors['b']).toMatch(/uses itself/)
    expect(r.errors['c']).toMatch(/no value named nope/)
    expect(r.values['d']).toBeCloseTo(0.4)
    expect(r.values['a']).toBeUndefined()
  })

  it('takes plain names that are not built in or taken', () => {
    expect(validName('wall', [])).toBeNull()
    expect(validName('insert_m3', [])).toBeNull()
    expect(validName('2wall', [])).toMatch(/starts with a letter/)
    expect(validName('my wall', [])).toMatch(/letters, digits and _/)
    expect(validName('clearance', [])).toMatch(/built in/)
    expect(validName('wall', ['wall'])).toMatch(/already/)
  })
})

describe('binding a step to what was typed', () => {
  it('keeps an expression with a name when it gives the step its number', () => {
    const values = { wall: 2 }
    expect(bindFor('wall * 2', 4, values)).toBe('wall * 2')
    // A plain number, or text that does not give the step's number, binds nothing.
    expect(bindFor('4', 4, values)).toBeUndefined()
    expect(bindFor('wall', 5, values)).toBeUndefined()
    expect(bindFor('nope', 4, values)).toBeUndefined()
  })
})
