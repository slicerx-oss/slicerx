// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted turns mimir plays in the tab before a model is connected. Each one streams text and calls real tools,
// so what it builds lands in the design's history like a person's edit.
import type { LlmMessage, ScriptStep } from '@slicerx/pilot'
import { get } from '../../state/store'
import type { MimirScript } from './scripted'

/** What the last tool call returned, from the tool message the runtime sent back. */
function lastResult(messages: readonly LlmMessage[]): Record<string, unknown> | null {
  const m = messages.at(-1)
  if (m?.role !== 'tool') return null
  try {
    return (JSON.parse(m.content) as { result?: Record<string, unknown> }).result ?? null
  } catch {
    return null
  }
}

/** The pick the last pilot.ask returned. */
export function lastPick(messages: readonly LlmMessage[]): string | null {
  const picked = lastResult(messages)?.['picked']
  return typeof picked === 'string' ? picked : null
}

/** The design the last design tool returned. */
export function lastDesign(messages: readonly LlmMessage[]): string | null {
  const design = lastResult(messages)?.['design']
  return typeof design === 'string' ? design : null
}

/** The middle of the bed, where the parts go. */
function bedMid(): [number, number] {
  const { bed } = get()
  return [bed.widthMm / 2, bed.depthMm / 2]
}

/** A step that needs the design the previous call made; without one it says so and stops. */
const withDesign =
  (make: (design: string, mid: [number, number]) => ScriptStep): ScriptStep =>
  (messages) => {
    const design = lastDesign(messages)
    if (!design) return { text: 'The design did not start, so I stopped here.' }
    const step = make(design, bedMid())
    return typeof step === 'function' ? step(messages) : step
  }

/** A rectangle as a sketch loop, centered on `c`. */
const rect = (c: [number, number], w: number, h: number): { points: [number, number][] } => ({
  points: [
    [c[0] - w / 2, c[1] - h / 2],
    [c[0] + w / 2, c[1] - h / 2],
    [c[0] + w / 2, c[1] + h / 2],
    [c[0] - w / 2, c[1] + h / 2],
  ],
})

/** A placeholder source: scripted lookups are examples, never real pages. */
const EXAMPLE_SOURCE = { title: 'Example spec sheet (scripted)', url: 'https://example.com/thermostat-specs' }

const backplate: ScriptStep[] = [
  {
    reasoning: 'The photo shows a round thermostat on a rectangular trim plate.',
    text: 'That looks like a round smart thermostat on a rectangular trim plate.',
    calls: [{ name: 'pilot.ask', args: { title: 'Confirm model', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] } }],
  },
  (messages) =>
    lastPick(messages) === 'other'
      ? { text: 'Send me the model name from its back, or a photo of the label, and I will look up its size.' }
      : {
          text: 'I found the trim plate size.',
          calls: [{ name: 'lookup.show', args: { title: 'Reference found', fields: [['Trim plate', '150.4 x 110.4 mm'], ['Center hole', '30 mm'], ['Mounting holes', '2 x 4.5 mm, 60 mm apart']], source: EXAMPLE_SOURCE } }],
        },
  { text: 'I will draw the outline and three holes, then extrude them together, 3 mm thick.', calls: [{ name: 'design.new', args: { name: 'Thermostat backplate' } }] },
  withDesign((design, mid) => ({
    calls: [
      {
        name: 'geom.extrude',
        args: {
          design,
          name: 'Backplate',
          // the outline, the center hole and two screw holes 60 mm apart; a loop inside another is a hole
          shape: { type: 'sketch', loops: [rect(mid, 150.4, 110.4), { type: 'circle', center: mid, diameterMm: 30 }, { type: 'circle', center: [mid[0], mid[1] - 30], diameterMm: 4.5 }, { type: 'circle', center: [mid[0], mid[1] + 30], diameterMm: 4.5 }] },
          distance_mm: 3,
        },
      },
    ],
  })),
  { text: 'The backplate is on the plate: 150.4 x 110.4 x 3 mm, with the 30 mm center hole and two 4.5 mm screw holes 60 mm apart. Every step is in its history in Model, so you can change any size there.' },
]

/** Box and lid sit side by side, 90 mm apart. */
const BOX = { w: 80, d: 60, h: 40, wall: 2, gap: 45, fit: 0.2, lip: 3 }

const box: ScriptStep[] = [
  {
    reasoning: 'A box with a separate lid that pushes in: a hollow body and a flat lid with a lip that fits inside it.',
    text: `I will make an ${BOX.w} x ${BOX.d} x ${BOX.h} mm box with ${BOX.wall} mm walls, and a lid with a lip that pushes in.`,
    calls: [{ name: 'design.new', args: { name: 'Box with lid' } }],
  },
  withDesign((design, [x, y]) => ({ calls: [{ name: 'geom.extrude', args: { design, name: 'Box', shape: { type: 'rectangle', widthMm: BOX.w, heightMm: BOX.d }, placement: { center: [x - BOX.gap, y] }, distance_mm: BOX.h } }] })),
  withDesign((design, [x, y]) => ({
    text: 'Now I hollow it from the top, leaving the floor.',
    calls: [{ name: 'geom.extrude', args: { design, part: 0, operation: 'cut', frame: { origin: [0, 0, BOX.h], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: BOX.w - 2 * BOX.wall, heightMm: BOX.d - 2 * BOX.wall }, placement: { center: [x - BOX.gap, y] }, distance_mm: BOX.h - BOX.wall } }],
  })),
  withDesign((design, [x, y]) => ({
    text: 'Then the lid beside it.',
    calls: [{ name: 'geom.extrude', args: { design, name: 'Lid', shape: { type: 'rectangle', widthMm: BOX.w, heightMm: BOX.d }, placement: { center: [x + BOX.gap, y] }, distance_mm: BOX.wall } }],
  })),
  withDesign((design, [x, y]) => ({
    calls: [
      {
        name: 'geom.extrude',
        args: {
          design,
          part: 1,
          operation: 'join',
          frame: { origin: [0, 0, BOX.wall], normal: [0, 0, 1] },
          // the lip sits inside the walls with a 0.2 mm gap each side, so it pushes in without sanding
          shape: { type: 'rectangle', widthMm: BOX.w - 2 * (BOX.wall + BOX.fit), heightMm: BOX.d - 2 * (BOX.wall + BOX.fit) },
          placement: { center: [x + BOX.gap, y] },
          distance_mm: BOX.lip,
        },
      },
    ],
  })),
  { text: `Done: the box and its lid, printed side by side. The lip is ${BOX.fit} mm smaller than the opening on each side; turn the lid over to fit it. Both parts are in Model with their steps.` },
]

/** The stand's side profile, [along X, up]: a base, a front lip and a back leaning at 70 degrees. */
const STAND_PROFILE: [number, number][] = [
  [-40, 0],
  [40, 0],
  [40, 6],
  [0.4, 6],
  [27, 79.1],
  [21.4, 81.2],
  [-6, 6],
  [-34, 6],
  [-34, 16],
  [-40, 16],
]

const stand: ScriptStep[] = [
  {
    reasoning: 'A phone stand is one side profile extruded to width: a base, a lip that holds the phone and a back it leans on.',
    text: 'I will draw the side profile of the stand, then extrude it 70 mm wide.',
    calls: [{ name: 'design.new', args: { name: 'Phone stand' } }],
  },
  withDesign((design, [x, y]) => ({
    calls: [
      {
        name: 'geom.extrude',
        args: {
          design,
          name: 'Stand',
          // the side profile stands on the bed, facing front; it extrudes 35 mm to each side
          frame: { origin: [x, y, 0], normal: [0, -1, 0] },
          shape: { type: 'sketch', loops: [{ points: STAND_PROFILE }] },
          distance_mm: 35,
          extent: 'symmetric',
        },
      },
    ],
  })),
  { text: 'The stand is on the plate: 80 mm deep, 81 mm tall and 70 mm wide. The phone rests on the base against the back, held by the front lip; it prints standing as it is, with no supports.' },
]

export const SCRIPTS: MimirScript[] = [
  { id: 'backplate', match: /thermostat|backplate|wall mount/i, steps: backplate },
  { id: 'box', match: /\bbox\b|\blid\b/i, steps: box },
  { id: 'stand', match: /phone|stand/i, steps: stand },
]
