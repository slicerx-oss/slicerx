// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint preview's picture draws each painted state in the project's filament of that number, the color the slice
// prints, and a part's own filament the same way. A project with white, black, buff and red filaments has a funnel
// painted in filament 3: the picture shows it buff, not the engine's own third color (a red). Changing filament 3's
// color changes the picture. The tools run as the mimir tab runs them, on a design host with the geometry engine
// (replies recorded).
import { describe, expect, it } from 'vitest'
import { headlessDesignHost } from '../evals/creative/design-host'
import { decodePng } from '../src/look'
import { createCardPlans, createPlanRegistry, tabToolset, type FilamentList } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

const g = useGeomEngine('paint-preview-colors')

const WHITE = '#f2f2f0'
const BLACK = '#1a1a1a'
const BUFF = '#d9a441'
const RED = '#a82a22'
/** The engine's own third color, which a picture drawn without the project's filaments used for filament 3. */
const ENGINE_THIRD = '#d93b2b'

/** The open project's filaments, held here as the app's rail holds them. */
function projectFilaments(colors: string[]): FilamentList {
  const list = colors.map((color, k) => ({ slot: k + 1, type: 'PLA', color }))
  return {
    list: () => list.map((f) => ({ ...f })),
    add: (slot, patch) => void list.push({ slot, type: patch.type ?? 'PLA', color: patch.color ?? '#ffffff' }),
    set: (slot, patch) => void Object.assign(list[slot - 1]!, patch),
  }
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number]

/** Whether pixel `p` is `color` shaded: each channel the color's own times one light factor, within 3 of 255. */
function shadeOf(p: [number, number, number], color: string): boolean {
  const c = rgb(color)
  const k = (p[0] + p[1] + p[2]) / (c[0] + c[1] + c[2])
  return k > 0.2 && c.every((v, i) => Math.abs(p[i]! - v * k) <= 3)
}

/** The picture's pixels that are not its background (the top left pixel's color). */
async function modelPixels(png: string): Promise<[number, number, number][]> {
  const img = await decodePng(png)
  if (!img) throw new Error('the picture is not a PNG the test reads')
  const out: [number, number, number][] = []
  for (let n = 0; n < img.w * img.h; n++) {
    const i = n * img.ch
    const p: [number, number, number] = [img.px[i]!, img.px[i + 1]!, img.px[i + 2]!]
    if (Math.abs(p[0] - img.px[0]!) + Math.abs(p[1] - img.px[1]!) + Math.abs(p[2] - img.px[2]!) > 6) out.push(p)
  }
  return out
}

describe('the paint preview picture', () => {
  /** The render requests the tools sent, with the engine's replies. */
  const renders: Record<string, unknown>[] = []
  const engine = (op: string, request: unknown) => {
    if (op === 'render') renders.push(request as Record<string, unknown>)
    return g.engine(op, request)
  }

  async function setUp() {
    renders.length = 0
    const host = headlessDesignHost(engine)
    const filaments = projectFilaments([WHITE, BLACK, BUFF, RED])
    const tools = tabToolset(host, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4, filaments })
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name)!
      const out = await t.run(t.input.parse(args) as never, {} as never)
      expect(out.ok, out.summary).not.toBe(false)
      return out
    }
    const design = ((await run('design.new', { name: 'Ship' })).output as { design: string }).design
    await run('geom.build', { design, name: 'Hull', slot: 1, solids: [{ type: 'box', min: [-40, -8, 0], max: [40, 8, 12] }] })
    await run('geom.build', { design, name: 'Funnel', slot: 1, solids: [{ type: 'box', min: [-6, -5, 12], max: [6, 5, 30] }] })
    /** The funnel previewed in filament 3, with its picture: the render request and the picture's model pixels. */
    const funnelIn3 = async () => {
      const out = await run('paint.preview', { design, part: 1, state: 3, target: { kind: 'part' }, view: 'iso', size: 256, image: true })
      const png = (out as { images?: { data: string }[] }).images?.[0]?.data
      expect(png, 'paint.preview with image true returns a picture').toBeDefined()
      return { request: renders.at(-1)!, pixels: await modelPixels(png!) }
    }
    return { run, filaments, funnelIn3 }
  }

  it("draws a part painted in filament 3 in the project's filament 3, buff", async () => {
    const { funnelIn3 } = await setUp()
    const { request, pixels } = await funnelIn3()
    // the renderer is given the project's filaments, filament 1 first
    expect(request['colors']).toEqual([WHITE, BLACK, BUFF, RED])
    // the funnel is drawn buff, and nothing in the engine's own third color
    const buff = pixels.filter((p) => shadeOf(p, BUFF)).length
    const third = pixels.filter((p) => shadeOf(p, ENGINE_THIRD)).length
    expect({ buff: buff > 500, third }).toEqual({ buff: true, third: 0 })
    // the hull, unpainted in filament 1, is drawn in the project's white
    expect(pixels.filter((p) => shadeOf(p, WHITE)).length).toBeGreaterThan(500)
  }, 60_000)

  it("follows filament 3's color when it changes", async () => {
    const { run, funnelIn3 } = await setUp()
    const GREEN = '#2e8b57'
    await run('project.set_filament', { slot: 3, color: GREEN })
    const { request, pixels } = await funnelIn3()
    expect(request['colors']).toEqual([WHITE, BLACK, GREEN, RED])
    expect(pixels.filter((p) => shadeOf(p, GREEN)).length).toBeGreaterThan(500)
    expect(pixels.filter((p) => shadeOf(p, BUFF)).length).toBe(0)
  }, 60_000)
})
