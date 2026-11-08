// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The build eval cases: parts a maker asks for in one message, run through the mimir tab as the desktop app makes it.
// Six need curved or tapered solids (a loft through sections or a sweep along a path), and two are boxy parts that
// extrudes build, as controls. Each case says which design steps a good build uses and the sizes its result should
// have, so the score reads the built part rather than the reply.
import type { PilotMachine } from '@slicerx/contracts'

/**
 * One way a step counts toward a case: a tool name, or for geom.revolve a turn of less than a full circle (an arc of a
 * ring, as an elbow or a handle can be made).
 */
export type OpMatch = 'geom.loft' | 'geom.sweep' | 'geom.extrude' | 'geom.revolve' | 'geom.revolve:partial'

/** A size the built part must have: the bounding box along an axis, or its largest side across the bed. */
export interface SizeCheck {
  /** x, y and z are the bounding box sides; xy is the larger of x and y. */
  axis: 'x' | 'y' | 'z' | 'xy'
  minMm: number
  maxMm: number
}

export interface BuildCase {
  id: string
  title: string
  /** The person's one message. */
  prompt: string
  machine: PilotMachine
  /** At least one successful step of one of these kinds. */
  ops: OpMatch[]
  /** Separate solid bodies a good result has, inclusive. */
  bodies: [number, number]
  sizes: SizeCheck[]
  /** A boxy part that extrudes build: it must not need a loft or sweep, and it must not be turned down. */
  control?: boolean
}

const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

export const BUILD_CASES: BuildCase[] = [
  {
    id: 'headphone-stand',
    title: 'Headphone stand',
    // the owner's prompt, word for word: mimir turned it down on 0.2.17, saying the hook and stem need a sweep and a loft
    prompt: "Design a headphone stand: a round weighted base, a hollow tapered stem, and a curved hook at the top with a soft lip so the headband doesn't slide off. Ask me for the main sizes first.",
    machine: P1S,
    ops: ['geom.loft', 'geom.sweep'],
    bodies: [1, 3],
    sizes: [
      { axis: 'z', minMm: 150, maxMm: 256 },
      { axis: 'xy', minMm: 80, maxMm: 256 },
    ],
  },
  {
    id: 'square-bottle',
    title: 'Bottle with a neck',
    prompt: 'Make a bottle with a 70 mm square body, 150 mm tall, that blends smoothly into a round neck 30 mm across and 25 mm tall. 2 mm walls, closed bottom, open at the top.',
    machine: P1S,
    ops: ['geom.loft'],
    bodies: [1, 1],
    sizes: [
      // 150 + 25, or more if the blend sits between the body and the neck
      { axis: 'z', minMm: 165, maxMm: 215 },
      { axis: 'xy', minMm: 67, maxMm: 75 },
    ],
  },
  {
    id: 'cable-hook',
    title: 'Cable hook on a swept path',
    prompt: 'A cable hook made from a 10 mm round rod bent into a J: 60 mm straight up from a 40 by 40 by 5 mm base plate, then curving over in a 20 mm radius hook. Two screw holes in the plate.',
    machine: P1S,
    ops: ['geom.sweep'],
    bodies: [1, 1],
    sizes: [
      { axis: 'z', minMm: 70, maxMm: 100 },
      { axis: 'xy', minMm: 40, maxMm: 80 },
    ],
  },
  {
    id: 'mug-handle',
    title: 'Mug handle',
    prompt: 'Design a replacement mug handle to glue on: a C shaped loop 80 mm tall that sticks out 30 mm from the mug, with an oval cross section 14 by 9 mm and flat ends that sit against the mug.',
    machine: P1S,
    ops: ['geom.sweep', 'geom.loft', 'geom.revolve:partial'],
    bodies: [1, 1],
    sizes: [
      { axis: 'z', minMm: 70, maxMm: 95 },
      { axis: 'xy', minMm: 25, maxMm: 45 },
    ],
  },
  {
    id: 'twisted-vase',
    title: 'Twisted vase',
    prompt: 'A twisted hexagon vase, 80 mm across the corners and 160 mm tall, where the hexagon turns 60 degrees from bottom to top. 2 mm walls and a solid 3 mm bottom.',
    machine: P1S,
    ops: ['geom.loft'],
    bodies: [1, 1],
    sizes: [
      { axis: 'z', minMm: 150, maxMm: 170 },
      { axis: 'xy', minMm: 68, maxMm: 85 },
    ],
  },
  {
    id: 'pipe-elbow',
    title: 'Pipe elbow',
    prompt: 'A 90 degree pipe elbow: 32 mm outside diameter, 2.5 mm wall, 50 mm bend radius, with 20 mm straight ends on both sides.',
    machine: P1S,
    ops: ['geom.sweep', 'geom.revolve:partial'],
    bodies: [1, 1],
    sizes: [
      // each leg reaches bend radius + half the diameter + the straight end: 50 + 16 + 20 = 86
      { axis: 'xy', minMm: 80, maxMm: 92 },
    ],
  },
  {
    id: 'pi5-case',
    title: 'Raspberry Pi 5 case',
    prompt: 'Make a simple two part case for a Raspberry Pi 5: a base tray with standoffs for the board and a lid that sits on top, with openings for the USB, Ethernet and power ports.',
    machine: P1S,
    ops: ['geom.extrude'],
    bodies: [2, 3],
    sizes: [{ axis: 'xy', minMm: 88, maxMm: 120 }],
    control: true,
  },
  {
    id: 'hinged-box',
    title: 'Hinged box',
    prompt: 'A small box with a hinged lid, 80 by 50 by 35 mm, 2 mm walls, with a pin hinge along the back edge.',
    machine: P1S,
    ops: ['geom.extrude'],
    bodies: [1, 4],
    sizes: [{ axis: 'xy', minMm: 75, maxMm: 100 }],
    control: true,
  },
]
