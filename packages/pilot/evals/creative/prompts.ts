// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative prompt set: things makers ask for that go past brackets and boxes. Each prompt says what a good result
// looks like in numbers the mesh checks can test (evals/creative/mesh-checks.ts). Recorded replies live in
// evals/creative/recordings, one file per prompt id.
import type { PilotMachine } from '@slicerx/contracts'

export interface CreativePrompt {
  id: string
  title: string
  prompt: string
  machine: PilotMachine
  /** Separate solid bodies a good result has, inclusive. */
  bodies: [number, number]
  /**
   * Print in place: the bodies must come off the plate already able to move, so every gap between bodies that face
   * each other must clear the fit rule for print in place joints at this machine's nozzle and material.
   */
  mechanism?: boolean
}

const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const A1_MINI: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
const MK4S_PETG: PilotMachine = { printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 }
const P1S_06: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.6 }

export const CREATIVE_PROMPTS: CreativePrompt[] = [
  {
    id: 'flexi-dragon',
    title: 'Flexi dragon',
    prompt: 'Make me a print in place flexi dragon, about 180 mm nose to tail, with a jointed body and tail that wiggles straight off the plate.',
    machine: P1S,
    bodies: [8, 60],
    mechanism: true,
  },
  {
    id: 'articulated-lizard',
    title: 'Articulated lizard',
    prompt: 'I want an articulated lizard, around 150 mm long, with segments that swing side to side. It has to print in one go with no supports.',
    machine: P1S,
    bodies: [6, 40],
    mechanism: true,
  },
  {
    id: 'fidget-spinner',
    title: 'Fidget spinner',
    prompt: 'Design a three lobe fidget spinner, 75 mm across, with a print in place hub that spins without a bearing.',
    machine: P1S,
    bodies: [2, 5],
    mechanism: true,
  },
  {
    id: 'infinity-cube',
    title: 'Infinity cube',
    prompt: 'Make an infinity cube that prints in place: eight 20 mm cubes joined by hinges so it folds over and over.',
    machine: P1S,
    bodies: [8, 24],
    mechanism: true,
  },
  {
    id: 'hinge-box',
    title: 'Print in place hinge box',
    prompt: 'A small box with a lid on a print in place hinge, 60 by 40 by 30 mm, for SD cards. Printing it in PETG.',
    machine: MK4S_PETG,
    bodies: [2, 4],
    mechanism: true,
  },
  {
    id: 'gear-pair',
    title: 'Gear pair',
    prompt: 'Make a pair of meshing spur gears on a base plate with pins, 20 and 40 teeth, module 1.5, that turn right off the plate.',
    machine: P1S,
    bodies: [2, 5],
    mechanism: true,
  },
  {
    id: 'planetary-gear',
    title: 'Planetary gear set',
    prompt: 'Print in place planetary gear set: a sun, three planets and a ring gear, 70 mm across and 10 mm thick.',
    machine: P1S,
    bodies: [5, 8],
    mechanism: true,
  },
  {
    id: 'taco',
    title: 'Taco',
    prompt: 'Make a taco I can print for my kid\'s play kitchen: folded shell with a lettuce and meat filling, about 100 mm long.',
    machine: P1S,
    bodies: [1, 4],
  },
  {
    id: 'mushroom',
    title: 'Mushroom',
    prompt: 'Model a cute toadstool mushroom, 60 mm tall, with a domed cap and a thick stem, flat on the bottom.',
    machine: A1_MINI,
    bodies: [1, 2],
  },
  {
    id: 'knit-vase',
    title: 'Knit texture vase',
    prompt: 'A vase with a knitted texture all over the outside, 90 mm wide and 160 mm tall, with a solid 2 mm wall so it holds water.',
    machine: A1_MINI,
    bodies: [1, 1],
  },
  {
    id: 'ship-hull',
    title: 'Ship hull section',
    prompt: 'Make a section of a wooden ship hull for a diorama, 120 mm long, with the curved planking and ribs showing on the inside.',
    machine: P1S,
    bodies: [1, 1],
  },
  {
    id: 'cable-organizer',
    title: 'Cable organizer',
    prompt: 'A desk cable organizer with five slots for USB cables, 100 mm long, that sits on the desk edge.',
    machine: P1S,
    bodies: [1, 1],
  },
  {
    id: 'phone-stand',
    title: 'Phone stand',
    prompt: 'Phone stand for my desk, holds a phone at about 65 degrees, with a slot at the bottom for the charging cable.',
    machine: P1S,
    bodies: [1, 2],
  },
  {
    id: 'flexi-fish',
    title: 'Flexi fish',
    prompt: 'A print in place flexi fish, 120 mm long, with jointed body segments and a tail fin that flops.',
    machine: A1_MINI,
    bodies: [4, 30],
    mechanism: true,
  },
  {
    id: 'pip-chain',
    title: 'Print in place chain',
    prompt: 'Make a short chain of eight linked oval links that prints flat and comes off the bed already linked.',
    machine: P1S,
    bodies: [3, 20],
    mechanism: true,
  },
  {
    id: 'spinner-ring',
    title: 'Spinner ring',
    prompt: 'A spinner ring, 19 mm inner diameter, with a band that spins freely around the core. Print in place, no assembly.',
    machine: P1S,
    bodies: [2, 3],
    mechanism: true,
  },
  {
    id: 'honeycomb-pen-cup',
    title: 'Honeycomb pen cup',
    prompt: 'A hexagon pen cup with a honeycomb pattern cut through the side walls, 80 mm across and 100 mm tall.',
    machine: P1S_06,
    bodies: [1, 1],
  },
  {
    id: 'toy-rocket',
    title: 'Toy rocket',
    prompt: 'A chunky toy rocket with three fins and a pointed nose cone, 150 mm tall, that stands up on its fins.',
    machine: A1_MINI,
    bodies: [1, 4],
  },
  {
    id: 'headphone-hook',
    title: 'Headphone hook',
    prompt: 'An under desk headphone hook that screws on, with two countersunk screw holes and a wide rounded hook.',
    machine: P1S,
    bodies: [1, 1],
  },
  {
    id: 'snowflake-ornament',
    title: 'Snowflake ornament',
    prompt: 'A six armed snowflake tree ornament, 80 mm across and 3 mm thick, with a loop at the top for a string.',
    machine: A1_MINI,
    bodies: [1, 1],
  },
]
