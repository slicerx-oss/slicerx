// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The build eval cases: parts a maker asks for in one message, run through the mimir tab as the desktop app makes it.
// Most need curved or tapered solids (a loft through sections or a sweep along a path); four are boxy parts that
// extrudes build, as controls, and one asks for two separate parts. Each case says which design steps a good build
// uses and the sizes its result should have, so the score reads the built part rather than the reply.
import type { PilotMachine } from '@slicerx/contracts'

/**
 * One way a step counts toward a case: a tool name, or for geom.revolve a turn of less than a full circle (an arc of a
 * ring, as an elbow or a handle can be made).
 */
export type OpMatch = 'geom.loft' | 'geom.sweep' | 'geom.extrude' | 'geom.build' | 'geom.revolve' | 'geom.revolve:partial'

/** A size the built part must have: the bounding box along an axis, or its largest side across the bed. */
export interface SizeCheck {
  /** x, y and z are the bounding box sides; xy is the larger of x and y. */
  axis: 'x' | 'y' | 'z' | 'xy'
  minMm: number
  maxMm: number
}

/**
 * How a hook on the part is checked. lip: the hook is joined to a lofted stem over a face, at its side or its top (one
 * that stands apart, or meets the stem only along an edge or at a point, holds nothing), and its tip rises 3 mm or more
 * above the lowest point of the hook's outer half (a lip that keeps a headband on). leg: the rod's hook hangs a leg
 * past the bend, at least the rod's thickness plus 5 mm below its top, so a cable cannot slide off the end.
 */
export type HookSpec = { kind: 'lip' } | { kind: 'leg'; rodMm: number }

/**
 * How a box's lid is checked. hinged: the lid is a body of its own, sits on its box (within 2 mm of it, not laid apart
 * where no hinge joins them) and keeps the gap the fit rule gives a print in place joint on the case's machine, so it
 * neither fuses to the box nor binds; and the lid turns on a pin that runs through a knuckle of the box and a knuckle
 * of the lid (a separate pin, or one built into either part inside the other's knuckle).
 */
export type LidSpec = { kind: 'hinged' }

/**
 * The part holds something, so it is closed at the bottom: `mm`, the floor the person asked for (or the walls' size when
 * they named no floor), and `holeMm`, the widest hole they asked for through it, such as a planter's drain holes.
 */
export interface FloorSpec {
  mm: number
  holeMm?: number
}

export interface BuildCase {
  id: string
  title: string
  /** The person's one message. */
  prompt: string
  machine: PilotMachine
  /** At least one successful step of one of these kinds (any of them, not all). */
  ops: OpMatch[]
  /** Separate solid bodies a good result has, inclusive. */
  bodies: [number, number]
  sizes: SizeCheck[]
  /** A boxy part that extrudes build: it must not need a loft or sweep, and it must not be turned down. */
  control?: boolean
  /** The part has a hook, checked this way. */
  hook?: HookSpec
  /** The part has a lid, checked this way. */
  lid?: LidSpec
  /** The part holds something, and its floor is checked as design.check checks a plan that sets one. */
  floor?: FloorSpec
  /**
   * The person asks for this many separate parts in the one message, so each part may get its own dimension sheet and
   * Go without counting as an extra turn. One when not given.
   */
  parts?: number
}

const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

export const BUILD_CASES: BuildCase[] = [
  {
    id: 'headphone-stand',
    title: 'Headphone stand',
    // a request an earlier build turned down, saying the hook and stem need a sweep and a loft
    prompt: "Design a headphone stand: a round weighted base, a hollow tapered stem, and a curved hook at the top with a soft lip so the headband doesn't slide off. Ask me for the main sizes first.",
    machine: P1S,
    ops: ['geom.loft', 'geom.sweep'],
    bodies: [1, 3],
    sizes: [
      { axis: 'z', minMm: 150, maxMm: 256 },
      { axis: 'xy', minMm: 80, maxMm: 256 },
    ],
    hook: { kind: 'lip' },
  },
  {
    id: 'square-bottle',
    title: 'Bottle with a neck',
    prompt: 'Make a bottle with a 70 mm square body, 150 mm tall, that blends smoothly into a round neck 30 mm across and 25 mm tall. 2 mm walls, closed bottom, open at the top.',
    machine: P1S,
    ops: ['geom.loft'],
    bodies: [1, 1],
    floor: { mm: 2 },
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
      // the 5 mm plate, the 60 mm rise and the bend's 20 mm radius to the rod's middle, plus half the 10 mm rod: 90, or
      // 85 when the rise is read from the bed; a hook that turns over at the top of its rise stands only 70
      { axis: 'z', minMm: 80, maxMm: 100 },
      { axis: 'xy', minMm: 40, maxMm: 80 },
    ],
    hook: { kind: 'leg', rodMm: 10 },
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
    floor: { mm: 3 },
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
    ops: ['geom.extrude', 'geom.build'],
    bodies: [2, 3],
    sizes: [{ axis: 'xy', minMm: 88, maxMm: 120 }],
    // a one-plan control, so no parts allowance: one approved plan with one sheet for every size, the lid's included
    control: true,
  },
  {
    id: 'hinged-box',
    title: 'Hinged box',
    prompt: 'A small box with a hinged lid, 80 by 50 by 35 mm, 2 mm walls, with a pin hinge along the back edge.',
    machine: P1S,
    ops: ['geom.extrude', 'geom.build'],
    bodies: [1, 4],
    sizes: [
      { axis: 'xy', minMm: 75, maxMm: 100 },
      // 35 mm closed, with the lid on its box; the hinge knuckles or a lid laid over the top may stand up to 10 mm more.
      // A lid printed open beside the box is measured closed (score.ts closedHeight; owner, 2026-11-12, this case only)
      { axis: 'z', minMm: 33, maxMm: 45 },
    ],
    lid: { kind: 'hinged' },
    control: true,
  },
  // a loft vase that changes section, a handle swept along an arc, a clip and a stand that extrudes and fillets build, a
  // planter and saucer as two separate parts, and a hook with a rounded tip
  {
    id: 'flared-vase',
    title: 'Flared vase',
    prompt: 'A vase that starts as a 60 mm square at the bottom and flares out to a round top 110 mm across, 150 mm tall, with a slight twist on the way up. 2 mm walls and a solid 3 mm bottom.',
    machine: P1S,
    ops: ['geom.loft'],
    bodies: [1, 1],
    floor: { mm: 3 },
    sizes: [
      { axis: 'z', minMm: 140, maxMm: 160 },
      // the round top sets the width; the square foot is 85 mm corner to corner
      { axis: 'xy', minMm: 100, maxMm: 118 },
    ],
  },
  {
    id: 'drawer-handle',
    title: 'Curved drawer handle',
    prompt: 'A curved drawer handle: a round bar 12 mm thick that arches out 30 mm from the drawer front between two posts 128 mm apart, center to center, with an M4 screw hole in the end of each post.',
    machine: P1S,
    ops: ['geom.sweep', 'geom.revolve:partial'],
    bodies: [1, 1],
    sizes: [
      // 128 between the posts plus a post's width either side
      { axis: 'xy', minMm: 128, maxMm: 160 },
    ],
  },
  {
    // a control: scored on closure, body count, wall, bed fit and size only; the C opening and snap tab are not read
    id: 'cable-clip',
    title: 'Cable clip with a snap tab',
    prompt: 'A cable clip to screw under my desk: a 30 by 20 mm base, 3 mm thick, with a countersunk screw hole, and a C shaped clip on top for an 8 mm cable with a snap tab at the opening so the cable clicks in. Round off the outside edges.',
    machine: P1S,
    ops: ['geom.extrude', 'geom.build'],
    bodies: [1, 1],
    sizes: [
      { axis: 'xy', minMm: 28, maxMm: 45 },
      // the base and a clip around an 8 mm cable
      { axis: 'z', minMm: 10, maxMm: 25 },
    ],
    control: true,
  },
  {
    // a control: scored on closure, body count, wall, bed fit and size only; the lean, lip and cable gap are not read
    id: 'phone-stand-lip',
    title: 'Phone stand with an angled lip',
    prompt: 'A phone stand for my desk, 80 mm wide, that holds the phone leaning back at about 60 degrees, with an angled lip at the front 10 mm tall so it does not slide off and a gap in the lip for the charging cable.',
    machine: P1S,
    ops: ['geom.extrude', 'geom.build'],
    bodies: [1, 1],
    sizes: [
      { axis: 'xy', minMm: 75, maxMm: 150 },
      { axis: 'z', minMm: 40, maxMm: 150 },
    ],
    control: true,
  },
  {
    id: 'planter-saucer',
    title: 'Planter and saucer',
    prompt: 'A round planter 120 mm across and 100 mm tall with 3 mm walls and five 6 mm drainage holes in the bottom, plus a separate saucer for it to sit in, 140 mm across and 15 mm tall. Two separate parts.',
    machine: P1S,
    ops: ['geom.extrude', 'geom.revolve', 'geom.loft', 'geom.build'],
    // the planter and the saucer, each its own body, and each may get its own sheet and Go
    bodies: [2, 2],
    parts: 2,
    // the planter's floor has the five drain holes; the saucer's has none
    floor: { mm: 3, holeMm: 6 },
    sizes: [
      // the saucer is the widest; the planter the tallest, standing in its saucer or apart
      { axis: 'xy', minMm: 135, maxMm: 150 },
      { axis: 'z', minMm: 95, maxMm: 118 },
    ],
  },
  {
    id: 'coat-hook',
    title: 'Coat hook with a rounded tip',
    prompt: 'A wall coat hook: a 25 by 70 mm back plate, 5 mm thick, with two countersunk screw holes, and a 12 mm round arm that comes out 50 mm from the wall and curves up at the end into a rounded tip so it will not snag a coat.',
    machine: P1S,
    ops: ['geom.sweep', 'geom.revolve:partial'],
    bodies: [1, 1],
    sizes: [
      // the plate's 70 mm, whichever way the hook lies on the bed
      { axis: 'xy', minMm: 25, maxMm: 100 },
      { axis: 'z', minMm: 25, maxMm: 100 },
    ],
  },
  // a sweep that narrows along its path: a hollow spout and a hook arm thinner at the tip than at the wall
  {
    id: 'watering-spout',
    title: 'Watering can spout',
    prompt: 'A watering can spout: a tube 22 mm round at the base that tapers to 9 mm at the tip as it curves up 70 mm, with a 1.6 mm wall, open at both ends.',
    machine: P1S,
    ops: ['geom.sweep'],
    bodies: [1, 1],
    sizes: [
      // it rises 70 mm, plus up to the base's radius where the base meets the bed at an angle
      { axis: 'z', minMm: 60, maxMm: 95 },
      { axis: 'xy', minMm: 20, maxMm: 90 },
    ],
  },
  {
    id: 'tapered-hook',
    title: 'Coat hook with a tapered arm',
    prompt: 'A wall coat hook: a 30 by 80 mm back plate, 5 mm thick, with two countersunk screw holes, and a round arm 16 mm thick at the wall that tapers to 8 mm at the tip, comes out 60 mm and curves up at the end.',
    machine: P1S,
    ops: ['geom.sweep'],
    bodies: [1, 1],
    sizes: [
      // the plate's 80 mm, whichever way the hook lies on the bed
      { axis: 'xy', minMm: 30, maxMm: 110 },
      { axis: 'z', minMm: 30, maxMm: 110 },
    ],
  },
  // a sweep whose section changes along its path: a rectangular duct that ends round
  {
    id: 'duct-transition',
    title: 'Rectangular to round duct',
    prompt: 'A duct from a 100 by 50 mm rectangle to a 100 mm round outlet over a 90 degree bend, with a 2 mm wall, open at both ends.',
    machine: P1S,
    ops: ['geom.sweep'],
    bodies: [1, 1],
    sizes: [
      // the 100 mm across both ends, plus the bend, whichever way it lies on the bed
      { axis: 'xy', minMm: 95, maxMm: 256 },
      { axis: 'z', minMm: 45, maxMm: 256 },
    ],
  },
]
