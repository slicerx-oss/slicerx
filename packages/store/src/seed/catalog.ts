// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Example catalog for the seed. Every creator and member here is fictional,
// and the models are neutral, generic objects.
import type { CreatorLinkKind, FileFormat, ListingLicense, ListingStatus } from '@slicerx/contracts'

export interface SeedListing {
  slug: string
  title: string
  description: string
  license: ListingLicense
  tags: string[]
  versions: { version: string; changelog: string }[]
  /** Defaults to approved. */
  status?: ListingStatus
  /** Shown to the creator for rejected and removed listings. */
  note?: string
  /** Defaults to 3mf. */
  format?: FileFormat
}

export interface SeedCreator {
  handle: string
  displayName: string
  owner: { handle: string; displayName: string }
  tagline: string
  bio: string
  location?: string
  trusted?: boolean
  links: { kind: CreatorLinkKind; label?: string; url: string }[]
  /** Slugs of approved listings shown first on the page, in order. */
  featured: string[]
  listings: SeedListing[]
}

export const SEED_OWNER = { handle: 'owner', displayName: 'Site owner' }
export const SEED_MODERATOR = { handle: 'moderator', displayName: 'Moderator' }
/** A member the moderators banned, to exercise the ban paths. */
export const SEED_BANNED = { handle: 'zed', displayName: 'Zed Q.', reason: 'Repeated spam in comments' }

export const SEED_CREATORS: SeedCreator[] = [
  {
    handle: 'marrow-works',
    displayName: 'Marrow Works',
    owner: { handle: 'marrow', displayName: 'Marrow Works' },
    tagline: 'Articulated fossils and desk skeletons',
    bio: 'Print-in-place fossils with tuned joint clearances for 0.4 mm nozzles.',
    location: 'Rotterdam, Netherlands',
    trusted: true,
    links: [
      { kind: 'website', label: 'Website', url: 'https://marrow-works.example.com' },
      { kind: 'printables', label: 'Printables', url: 'https://www.printables.com/@marrowworks' },
      { kind: 'youtube', label: 'Build videos', url: 'https://www.youtube.com/@marrowworks' },
    ],
    featured: ['articulated-fossil-fish', 'spine-cable-organizer'],
    listings: [
      { slug: 'articulated-fossil-fish', title: 'Articulated fossil fish', description: 'Print-in-place fish skeleton with 22 linked segments. Tested at 0.20 mm.', license: 'cc-by', tags: ['articulated', 'print-in-place', 'desk'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '1.1.0', changelog: 'Looser joint clearance for PETG' }] },
      { slug: 'desk-skull-planter', title: 'Desk skull planter', description: 'Small planter with a drainage insert. Prints without supports.', license: 'cc-by-sa', tags: ['planter', 'home'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'spine-cable-organizer', title: 'Spine cable organizer', description: 'Flexible vertebra chain that holds six cables along a desk edge.', license: 'cc-by', tags: ['desk', 'organizer', 'functional'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '1.2.0', changelog: 'Adds a clamp for 30 mm desks' }] },
      { slug: 'ribcage-pen-holder', title: 'Ribcage pen holder', description: 'Pen cup shaped like a ribcage, split for AMS color changes.', license: 'cc-by-nc', tags: ['desk', 'multicolor'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'trilobite-coaster-set', title: 'Trilobite coaster set', description: 'Four coasters with a raised trilobite pattern. Print flat, no supports.', license: 'cc-by', tags: ['home', 'desk'], versions: [{ version: '1.0.0', changelog: 'First release' }], status: 'pending' },
    ],
  },
  {
    handle: 'tidewell-studio',
    displayName: 'Tidewell Studio',
    owner: { handle: 'tidewell', displayName: 'Tidewell Studio' },
    tagline: 'Coastal pieces for the home',
    bio: 'Planters, dishes and lamp shades with textured surfaces that hide layer lines.',
    location: 'Portland, Oregon',
    links: [
      { kind: 'website', label: 'Website', url: 'https://tidewell.example.com' },
      { kind: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/tidewellstudio' },
    ],
    featured: ['wave-dish', 'lighthouse-lamp-shade', 'tide-pool-planter'],
    listings: [
      { slug: 'tide-pool-planter', title: 'Tide pool planter', description: 'Three-pocket planter with a textured rock surface.', license: 'cc-by-sa', tags: ['planter', 'home', 'texture'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'wave-dish', title: 'Wave dish', description: 'Shallow key dish with a vase-mode wave rim.', license: 'cc0', tags: ['home', 'vase-mode'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'lighthouse-lamp-shade', title: 'Lighthouse lamp shade', description: 'Lamp shade for E14 bulbs. Print in translucent PETG at 0.16 mm.', license: 'cc-by-nc', tags: ['lamp', 'home'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '2.0.0', changelog: 'Taller body, new vent pattern' }] },
      { slug: 'shell-tealight-holder', title: 'Shell tealight holder', description: 'Tealight holder with a heat shield ring. LED candles recommended.', license: 'cc-by', tags: ['home', 'gift'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'anchor-cabinet-pull', title: 'Anchor cabinet pull', description: 'Cabinet pull shaped like an anchor. Takes an M4 screw.', license: 'cc-by', tags: ['home', 'hardware'], versions: [{ version: '1.0.0', changelog: 'First release' }], status: 'pending' },
    ],
  },
  {
    handle: 'kestrel-parts',
    displayName: 'Kestrel Parts',
    owner: { handle: 'kestrel', displayName: 'Kestrel Parts' },
    tagline: 'Functional parts for the workshop',
    bio: 'Workshop parts designed for PETG and ASA, with load notes on every listing.',
    links: [
      { kind: 'website', label: 'Website', url: 'https://kestrel-parts.example.com' },
      { kind: 'github', label: 'Sources', url: 'https://github.com/kestrelparts' },
      { kind: 'kofi', label: 'Support the work', url: 'https://ko-fi.com/kestrelparts' },
    ],
    featured: ['filament-spool-holder', 'bench-vise-jaw-pads'],
    listings: [
      { slug: 'filament-spool-holder', title: 'Filament spool holder', description: 'Bearing spool holder for 200 mm spools. Uses two 608 bearings.', license: 'cc-by-sa', tags: ['functional', 'printer-upgrade'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '1.1.0', changelog: 'Wider base' }, { version: '1.2.0', changelog: 'Adds a 3 kg spool option' }] },
      { slug: 'hinged-cable-clip-set', title: 'Hinged cable clip set', description: 'Print-in-place hinged clips for 4 to 12 mm cables.', license: 'cc0', tags: ['functional', 'print-in-place'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'bench-vise-jaw-pads', title: 'Bench vise jaw pads', description: 'Magnetic soft jaws for 100 mm vises. Print in TPU 95A.', license: 'cc-by', tags: ['functional', 'workshop', 'tpu'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'drawer-label-frames', title: 'Drawer label frames', description: 'Snap-in label frames for common parts drawers.', license: 'cc-by', tags: ['organizer', 'workshop'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'chain-link-cable-guide', title: 'Chain link cable guide', description: 'Snap-together chain links that guide a cable bundle along a bench.', license: 'cc-by', tags: ['functional', 'workshop', 'organizer'], versions: [{ version: '0.9.0', changelog: 'First release' }], status: 'pending', format: 'stl' },
    ],
  },
  {
    handle: 'oddfellow-minis',
    displayName: 'Oddfellow Minis',
    owner: { handle: 'oddfellow', displayName: 'Oddfellow Minis' },
    tagline: 'Tabletop miniatures and terrain',
    bio: 'Miniatures sliced for 0.12 mm layers with supports placed by hand.',
    links: [
      { kind: 'website', label: 'Website', url: 'https://oddfellow-minis.example.com' },
      { kind: 'discord', label: 'Discord', url: 'https://discord.gg/oddfellowminis' },
      { kind: 'cults3d', label: 'Cults', url: 'https://cults3d.com/en/users/oddfellow' },
    ],
    featured: ['lantern-keeper', 'dungeon-door-set'],
    listings: [
      { slug: 'lantern-keeper', title: 'Lantern keeper miniature', description: '32 mm scale figure with a separate lantern arm.', license: 'cc-by-nc', tags: ['miniature', 'tabletop'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '1.0.1', changelog: 'Thicker lantern handle' }] },
      { slug: 'mossback-toad', title: 'Mossback toad', description: 'Large toad mount with a textured back. Supports included.', license: 'cc-by-nc-sa', tags: ['miniature', 'creature'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'dungeon-door-set', title: 'Dungeon door set', description: 'Four doors with working hinges for 28 mm terrain.', license: 'cc-by', tags: ['terrain', 'tabletop', 'print-in-place'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'tavern-furniture-kit', title: 'Tavern furniture kit', description: 'Tables, stools, barrels and a bar counter on one plate.', license: 'cc0', tags: ['terrain', 'tabletop'], versions: [{ version: '1.0.0', changelog: 'First release' }], format: 'stl' },
      { slug: 'wizard-tower-terrain', title: 'Wizard tower terrain', description: 'Modular tower with a spiral stair.', license: 'cc-by', tags: ['terrain', 'tabletop'], versions: [{ version: '1.0.0', changelog: 'First release' }], status: 'rejected', note: 'The preview images show a model from a commercial game. Upload only models you made or have the right to share, then resubmit.' },
      { slug: 'logo-keychain', title: 'Logo keychain', description: 'Keychain with a company logo.', license: 'custom', tags: ['gift'], versions: [{ version: '1.0.0', changelog: 'First release' }], status: 'removed', note: 'Uses a trademarked logo. Taken down after a report.' },
    ],
  },
  {
    handle: 'ferro-labs',
    displayName: 'Ferro Labs',
    owner: { handle: 'ferro', displayName: 'Ferro Labs' },
    tagline: 'Mechanisms you can print and study',
    bio: 'Gearboxes, compliant mechanisms and test pieces with documented tolerances.',
    location: 'Tampere, Finland',
    links: [
      { kind: 'website', label: 'Website', url: 'https://ferro-labs.example.com' },
      { kind: 'github', label: 'Parametric sources', url: 'https://github.com/ferrolabs' },
      { kind: 'makerworld', label: 'MakerWorld', url: 'https://makerworld.com/en/@ferrolabs' },
    ],
    featured: ['planetary-gearbox-demo', 'parametric-enclosure', 'compliant-gripper'],
    listings: [
      { slug: 'planetary-gearbox-demo', title: 'Planetary gearbox demo', description: 'Hand-cranked 5:1 planetary gearbox. Prints in place.', license: 'cc-by-sa', tags: ['mechanism', 'print-in-place', 'education'], versions: [{ version: '1.0.0', changelog: 'First release' }, { version: '1.1.0', changelog: 'Quieter tooth profile' }], format: 'sx3mf' },
      { slug: 'print-in-place-wrench-set', title: 'Print-in-place wrench set', description: 'Adjustable wrench set in three sizes.', license: 'cc-by', tags: ['tool', 'print-in-place'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'parametric-enclosure', title: 'Parametric enclosure', description: 'Electronics box with snap lid. Sizes from 40 to 160 mm.', license: 'cc0', tags: ['functional', 'electronics'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'compliant-gripper', title: 'Compliant gripper', description: 'Single-piece gripper for small robot arms. Print in PETG.', license: 'cc-by', tags: ['mechanism', 'robotics'], versions: [{ version: '1.0.0', changelog: 'First release' }] },
      { slug: 'gear-tooth-test-strip', title: 'Gear tooth test strip', description: 'A strip of gear teeth at five clearances, for tuning a printer.', license: 'cc0', tags: ['education', 'calibration'], versions: [{ version: '1.0.0', changelog: 'First release' }], status: 'archived' },
    ],
  },
]

/** The signed-in member in every demo ("RV"). */
export const DEMO_MEMBER = { handle: 'rv', displayName: 'RV' }

export const SEED_MEMBERS: { handle: string; displayName: string }[] = [
  DEMO_MEMBER,
  { handle: 'ash', displayName: 'Ash P.' },
  { handle: 'bo', displayName: 'Bo L.' },
  { handle: 'cam', displayName: 'Cam D.' },
  { handle: 'dee', displayName: 'Dee M.' },
  { handle: 'eli', displayName: 'Eli S.' },
  { handle: 'fen', displayName: 'Fen K.' },
  { handle: 'gus', displayName: 'Gus R.' },
  { handle: 'hal', displayName: 'Hal O.' },
  { handle: 'ivy', displayName: 'Ivy T.' },
  { handle: 'jo', displayName: 'Jo W.' },
  { handle: 'kit', displayName: 'Kit N.' },
]

export const PRINTERS = [
  { model: 'Bambu Lab X1 Carbon', kind: 'bambu' },
  { model: 'Bambu Lab P1S', kind: 'bambu' },
  { model: 'Prusa MK4S', kind: 'prusalink' },
  { model: 'Voron 2.4 350', kind: 'moonraker' },
] as const

export const FILAMENTS = ['Generic PLA', 'Generic PETG', 'Bambu PLA Matte', 'Prusament PETG', 'Generic TPU 95A']

export const COMMENT_LINES = [
  'Printed this at 0.20 mm on the first try. Joints moved freely.',
  'Which filament did you use for the photos?',
  'The tested profile saved me a calibration print.',
  'Worked in PETG after raising the bed to 80 C.',
  'Could you add a version with a wider base?',
  'Printed two in one plate with no issues.',
  'The changelog note on clearances helped a lot.',
  'Supports came off cleanly with the included profile.',
]

export const MAKE_CAPTIONS = [
  'First layer came out clean on the textured plate.',
  'Printed in matte white, 2 h 10 m.',
  'Swapped to silk PLA for this one.',
  'Two colors with the AMS.',
  'Scaled to 120 percent, still printed without supports.',
]
