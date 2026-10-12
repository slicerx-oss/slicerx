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

/** The values the last confirmed sheet gave, from the tool messages so far. */
export function sheetValues(messages: readonly LlmMessage[]): Record<string, number> | null {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k]!
    if (m.role !== 'tool') continue
    try {
      const r = (JSON.parse(m.content) as { result?: { values?: Record<string, number> } }).result
      if (r?.values) return r.values
    } catch {
      // not a tool reply this script reads
    }
  }
  return null
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

/** A step that needs the design the previous call made and the sizes the person confirmed; without them it says so and stops. */
const withDesign =
  (make: (design: string, mid: [number, number], v: Record<string, number>) => ScriptStep): ScriptStep =>
  (messages) => {
    const design = lastDesign(messages)
    if (!design) return { text: 'The design did not start, so I stopped here.' }
    const step = make(design, bedMid(), sheetValues(messages) ?? {})
    return typeof step === 'function' ? step(messages) : step
  }

/** A row on a sheet. */
const row = (key: string, label: string, value: number, source: 'asked' | 'lookup' | 'photo' | 'guess', more: Record<string, unknown> = {}) => ({ key, label, value, unit: 'mm', source, ...more })

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
  {
    text: 'Here are the sizes I will build with. The plate and holes come from the spec sheet; the thickness is my guess. Change anything that is off.',
    calls: [
      {
        name: 'pilot.sheet',
        args: {
          title: 'Backplate sizes',
          views: ['top', 'side'],
          dims: [
            row('plate_width', 'Plate width', 150.4, 'lookup', { sourceTitle: EXAMPLE_SOURCE.title, sourceUrl: EXAMPLE_SOURCE.url, min: 60, max: 250 }),
            row('plate_height', 'Plate height', 110.4, 'lookup', { sourceTitle: EXAMPLE_SOURCE.title, sourceUrl: EXAMPLE_SOURCE.url, min: 60, max: 250 }),
            row('thickness', 'Thickness', 3, 'guess', { min: 1.6, max: 10 }),
            row('center_hole', 'Center hole', 30, 'lookup', { sourceTitle: EXAMPLE_SOURCE.title, sourceUrl: EXAMPLE_SOURCE.url, min: 5, max: 60 }),
            row('screw_hole', 'Screw holes', 4.5, 'lookup', { sourceTitle: EXAMPLE_SOURCE.title, sourceUrl: EXAMPLE_SOURCE.url, min: 2, max: 8 }),
            row('screw_spacing', 'Screw spacing', 60, 'lookup', { sourceTitle: EXAMPLE_SOURCE.title, sourceUrl: EXAMPLE_SOURCE.url, min: 20, max: 100 }),
          ],
        },
      },
    ],
  },
  { text: 'I will draw the outline and three holes, then extrude them together.', calls: [{ name: 'design.new', args: { name: 'Thermostat backplate' } }] },
  withDesign((design, mid, v) => {
    const [w, h, t, c, d, gap] = [v['plate_width'] ?? 150.4, v['plate_height'] ?? 110.4, v['thickness'] ?? 3, v['center_hole'] ?? 30, v['screw_hole'] ?? 4.5, v['screw_spacing'] ?? 60]
    return {
      calls: [
        {
          name: 'geom.extrude',
          args: {
            design,
            name: 'Backplate',
            // the outline, the center hole and two screw holes; a loop inside another is a hole
            shape: { type: 'sketch', loops: [rect(mid, w, h), { type: 'circle', center: mid, diameterMm: c }, { type: 'circle', center: [mid[0], mid[1] - gap / 2], diameterMm: d }, { type: 'circle', center: [mid[0], mid[1] + gap / 2], diameterMm: d }] },
            distance_mm: t,
          },
        },
      ],
    }
  }),
  withDesign((design) => ({ calls: [{ name: 'pilot.sheet_bind', args: { design, binds: [{ key: 'thickness', step: 1 }] } }] })),
  (messages) => {
    const v = sheetValues(messages) ?? {}
    return { text: `The backplate is on the plate: ${v['plate_width']} x ${v['plate_height']} x ${v['thickness']} mm, with the ${v['center_hole']} mm center hole and two ${v['screw_hole']} mm screw holes ${v['screw_spacing']} mm apart. Its steps are in Model, so you can change any size there.` }
  },
]

const box: ScriptStep[] = [
  {
    reasoning: 'A box with a separate lid that pushes in: a hollow body and a flat lid with a lip that fits inside it. Nothing here is known yet, so every size is a guess for the person to check.',
    text: 'Before I build it, check these sizes. They are my guesses for a small box; change them to fit what goes in it.',
    calls: [
      {
        name: 'pilot.sheet',
        args: {
          title: 'Box with lid sizes',
          views: ['iso', 'front'],
          dims: [
            row('width', 'Width', 80, 'guess', { min: 20, max: 250 }),
            row('depth', 'Depth', 60, 'guess', { min: 20, max: 250 }),
            row('height', 'Height', 40, 'guess', { min: 10, max: 200 }),
            row('wall', 'Wall', 2, 'guess', { min: 1.2, max: 5 }),
            row('lid_fit', 'Lid gap each side', 0.2, 'guess', { min: 0.05, max: 0.6, note: 'smaller is tighter' }),
            row('lip', 'Lid lip depth', 3, 'guess', { min: 1, max: 10 }),
          ],
        },
      },
    ],
  },
  (messages) => {
    const v = sheetValues(messages) ?? {}
    return { text: `I will make a ${v['width']} x ${v['depth']} x ${v['height']} mm box with ${v['wall']} mm walls, and a lid with a lip that pushes in.`, calls: [{ name: 'design.new', args: { name: 'Box with lid' } }] }
  },
  withDesign((design, [x, y], v) => ({ calls: [{ name: 'geom.extrude', args: { design, name: 'Box', shape: { type: 'rectangle', widthMm: v['width']!, heightMm: v['depth']! }, placement: { center: [x - (v['width']! / 2 + 5), y] }, distance_mm: v['height']! } }] })),
  withDesign((design, [x, y], v) => ({
    text: 'Now I hollow it from the top, leaving the floor.',
    calls: [{ name: 'geom.extrude', args: { design, part: 0, operation: 'cut', frame: { origin: [0, 0, v['height']!], normal: [0, 0, 1] }, shape: { type: 'rectangle', widthMm: v['width']! - 2 * v['wall']!, heightMm: v['depth']! - 2 * v['wall']! }, placement: { center: [x - (v['width']! / 2 + 5), y] }, distance_mm: v['height']! - v['wall']! } }],
  })),
  withDesign((design, [x, y], v) => ({
    text: 'Then the lid beside it.',
    calls: [{ name: 'geom.extrude', args: { design, name: 'Lid', shape: { type: 'rectangle', widthMm: v['width']!, heightMm: v['depth']! }, placement: { center: [x + (v['width']! / 2 + 5), y] }, distance_mm: v['wall']! } }],
  })),
  withDesign((design, [x, y], v) => ({
    calls: [
      {
        name: 'geom.extrude',
        args: {
          design,
          part: 1,
          operation: 'join',
          frame: { origin: [0, 0, v['wall']!], normal: [0, 0, 1] },
          // the lip sits inside the walls with the gap each side, so it pushes in without sanding
          shape: { type: 'rectangle', widthMm: v['width']! - 2 * (v['wall']! + v['lid_fit']!), heightMm: v['depth']! - 2 * (v['wall']! + v['lid_fit']!) },
          placement: { center: [x + (v['width']! / 2 + 5), y] },
          distance_mm: v['lip']!,
        },
      },
    ],
  })),
  // The height sets the box's extrude and, less the wall, the hollow's depth; the rest shape sketches.
  withDesign((design, _mid, v) => ({ calls: [{ name: 'pilot.sheet_bind', args: { design, binds: [{ key: 'height', step: 1 }, { key: 'height', step: 2, offset: -v['wall']! }, { key: 'lip', step: 4 }] } }] })),
  (messages) => {
    const v = sheetValues(messages) ?? {}
    return { text: `Done: the box and its lid, printed side by side. The lip is ${v['lid_fit']} mm smaller than the opening on each side; turn the lid over to fit it. Both parts are in Model with their steps.` }
  },
]

/** The stand's side profile, [along X, up], from the sizes on its sheet: a base, a front lip, a channel the phone sits in, and a back leaning at the lean angle. */
export function standProfile(v: Record<string, number>): [number, number][] {
  const depth = v['base_depth'] ?? 80
  const wall = 6
  const lipH = v['lip_height'] ?? 12
  const channel = (v['phone_thickness'] ?? 7.8) + (v['case_allowance'] ?? 1.5) + 1
  const lean = ((v['lean'] ?? 70) * Math.PI) / 180
  const back = 80
  const x0 = -depth / 2
  const lipEnd = x0 + wall
  const a: [number, number] = [lipEnd + channel, wall]
  const dir: [number, number] = [Math.cos(lean), Math.sin(lean)]
  const t1: [number, number] = [a[0] + dir[0] * back, a[1] + dir[1] * back]
  const t2: [number, number] = [t1[0] + Math.sin(lean) * wall, t1[1] - Math.cos(lean) * wall]
  const down = (t2[1] - wall) / dir[1]
  const b: [number, number] = [t2[0] - dir[0] * down, wall]
  const r = (p: [number, number]): [number, number] => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]
  return [[x0, 0], [depth / 2, 0], [depth / 2, wall], r(b), r(t2), r(t1), r(a), [lipEnd, wall], [lipEnd, lipH], [x0, lipH]]
}

/** The name of the tool the last step called, from the assistant's last message. */
function lastCall(messages: readonly LlmMessage[]): string | null {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k]!
    if (m.role === 'assistant') return m.toolCalls?.at(-1)?.name ?? null
  }
  return null
}

const PHONES = { iphone: { name: 'iPhone 15', w: 71.6, t: 7.8 }, pixel: { name: 'Pixel 8', w: 70.8, t: 8.9 } } as const
const PHONE_SOURCE = { title: 'Example phone specs (scripted)', url: 'https://example.com/phone-specs' }

/** One step's reply, as a script step gives it. */
type StepData = Exclude<ScriptStep, (messages: LlmMessage[]) => unknown>

function standSheet(phone: { w: number; t: number } | null): StepData {
  const src = phone ? { sourceTitle: PHONE_SOURCE.title, sourceUrl: PHONE_SOURCE.url } : {}
  const how = phone ? 'lookup' : 'guess'
  return {
    text: phone
      ? 'These are the sizes I will build with. The phone comes from its specs; the rest are my guesses. Check the case: a thick case needs more room.'
      : 'I do not know that phone, so these are all guesses. Measure its width and thickness and put in the real ones.',
    calls: [
      {
        name: 'pilot.sheet',
        args: {
          title: 'Phone stand sizes',
          views: ['side', 'front'],
          dims: [
            row('phone_width', 'Phone width', phone?.w ?? 72, how, { ...src, min: 50, max: 100 }),
            row('phone_thickness', 'Phone thickness', phone?.t ?? 8.5, how, { ...src, min: 5, max: 20 }),
            row('case_allowance', 'Room for a case', 1.5, 'guess', { min: 0, max: 6 }),
            { ...row('lean', 'Lean angle', 70, 'guess', { min: 55, max: 80 }), unit: 'deg' },
            row('stand_width', 'Stand width', 70, 'guess', { min: 40, max: 120 }),
            row('base_depth', 'Base depth', 80, 'guess', { min: 60, max: 140 }),
            row('lip_height', 'Front lip height', 12, 'guess', { min: 8, max: 30 }),
          ],
        },
      },
    ],
  }
}

/** The stand after its first question: each step follows from the last tool it called. */
const standNext: ScriptStep = (messages) => {
  const picked = messages.map((m) => (m.role === 'tool' ? /"picked":"(\w+)"/.exec(m.content)?.[1] : undefined)).find(Boolean) as keyof typeof PHONES | 'other' | undefined
  const phone = picked && picked !== 'other' ? PHONES[picked] : null
  const design = lastDesign(messages)
  const v = sheetValues(messages) ?? {}
  const [x, y] = bedMid()
  switch (lastCall(messages)) {
    case 'pilot.ask':
      return phone ? { text: `I found the ${phone.name}'s size.`, calls: [{ name: 'lookup.show', args: { title: `${phone.name} size`, fields: [['Width', `${phone.w} mm`], ['Thickness', `${phone.t} mm`]], source: PHONE_SOURCE } }] } : standSheet(null)
    case 'lookup.show':
      return standSheet(phone)
    case 'pilot.sheet':
      return { calls: [{ name: 'design.new', args: { name: 'Phone stand' } }] }
    case 'design.new':
      if (!design) return { text: 'The design did not start, so I stopped here.' }
      return {
        calls: [
          {
            name: 'geom.extrude',
            args: {
              design,
              name: 'Stand',
              // the side profile stands on the bed, facing front; it extrudes half the width to each side
              frame: { origin: [x, y, 0], normal: [0, -1, 0] },
              shape: { type: 'sketch', loops: [{ points: standProfile(v) }] },
              distance_mm: (v['stand_width'] ?? 70) / 2,
              extent: 'symmetric',
            },
          },
        ],
      }
    case 'geom.extrude':
      return design ? { calls: [{ name: 'pilot.sheet_bind', args: { design, binds: [{ key: 'stand_width', step: 1, scale: 0.5 }] } }] } : { text: 'The stand did not build, so I stopped here.' }
    default:
      return { text: `The stand is on the plate, ${v['stand_width']} mm wide, leaning back ${v['lean']} degrees, with room for a ${v['phone_thickness']} mm phone in a case. It prints standing as it is, with no supports.` }
  }
}

const stand: ScriptStep[] = [
  {
    reasoning: 'A phone stand has to fit the phone, so the first thing to know is which phone.',
    text: 'Which phone is it for? Its size sets the slot it sits in.',
    calls: [{ name: 'pilot.ask', args: { title: 'Which phone', question: 'Which phone will sit on the stand?', choices: [{ id: 'iphone', label: 'An iPhone 15' }, { id: 'pixel', label: 'A Pixel 8' }, { id: 'other', label: 'Something else' }] } }],
  },
  ...Array.from({ length: 7 }, () => standNext),
]

export const SCRIPTS: MimirScript[] = [
  { id: 'backplate', match: /thermostat|backplate|wall mount/i, steps: backplate },
  { id: 'box', match: /\bbox\b|\blid\b/i, steps: box },
  { id: 'stand', match: /phone|stand/i, steps: stand },
]
