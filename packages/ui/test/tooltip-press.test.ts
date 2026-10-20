// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A long press that showed a tip drops the one click its release makes, and never the tap that comes after it.
import { describe, expect, it } from 'vitest'
import { pressClickGuard } from '../src/components/tooltip'

/** A stand-in for a control and what lies inside it. */
function control(...inside: object[]) {
  const self = {}
  return { self, contains: (other: Node | null) => other === self || inside.includes(other as object) }
}

function make() {
  let t = 1000
  const g = pressClickGuard(() => t)
  return { g, tick: (ms: number) => (t += ms) }
}

const node = (o: object) => o as unknown as Node

describe('the long press click guard', () => {
  it('drops the click the release makes on the pressed control', () => {
    const { g, tick } = make()
    const icon = {}
    const pin = control(icon)
    g.lifted(pin)
    tick(3)
    expect(g.take(node(icon))).toBe(true)
  })
  it('lets the next tap through, even one that comes right away', () => {
    const { g, tick } = make()
    const pin = control()
    g.lifted(pin)
    tick(3)
    expect(g.take(node(pin.self))).toBe(true)
    tick(50)
    expect(g.take(node(pin.self))).toBe(false)
    expect(g.take(node({}))).toBe(false)
  })
  it('lets a tap on another control through when the release made no click', () => {
    const { g, tick } = make()
    g.lifted(control())
    tick(100)
    const tab = control()
    expect(g.take(node(tab.self))).toBe(false)
  })
  it('lets a tap on the pressed control through once the moment has passed', () => {
    const { g, tick } = make()
    const pin = control()
    g.lifted(pin)
    tick(401)
    expect(g.take(node(pin.self))).toBe(false)
  })
  it('drops nothing before any long press', () => {
    const { g } = make()
    expect(g.take(null)).toBe(false)
    expect(g.take(node({}))).toBe(false)
  })
})
