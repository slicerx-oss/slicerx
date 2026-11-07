// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer height graph's keyboard focus ring: a round accent line drawn by a circle right after each point, shown
// only when the point has keyboard focus, 2 px wide at any graph size.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = resolve(__dirname, '../src/workspaces/prepare')
const css = readFileSync(resolve(dir, 'layer-profile-editor.css'), 'utf8')
const tsx = readFileSync(resolve(dir, 'layer-profile-editor.tsx'), 'utf8')
/** The body of the CSS rule whose selector is exactly `sel`, at the start of a line. */
function rule(sel: string): string {
  for (const line of css.split('\n')) {
    if (line.startsWith(`${sel} {`)) return line.slice(sel.length + 2, line.lastIndexOf('}'))
  }
  return ''
}

describe('the layer graph focus ring', () => {
  it('is a hidden 2 px accent circle that keeps its width as the graph scales', () => {
    const ring = rule('.lp-focus')
    expect(ring).toContain('stroke: var(--accent)')
    expect(ring).toContain('stroke-width: 2')
    expect(ring).toContain('vector-effect: non-scaling-stroke')
    expect(ring).toContain('visibility: hidden')
    expect(ring).toContain('pointer-events: none')
  })

  it('shows only for keyboard focus on the point just before it', () => {
    expect(rule('.lp-point:focus-visible + .lp-focus')).toContain('visibility: visible')
    expect(css).not.toMatch(/\.lp-point:focus(?!-visible)/)
  })

  it('is drawn right after each point, so the sibling rule finds it', () => {
    expect(tsx).toMatch(/className="lp-point"[\s\S]*?\/>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<circle className="lp-focus"/)
    expect(tsx.match(/className="lp-focus"/g)).toHaveLength(1)
  })
})
