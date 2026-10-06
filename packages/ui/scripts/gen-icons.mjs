// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds src/icons/icon-paths.ts from three sources: icons/base.mjs (the approved concept icon
// set, frozen, always first and unchanged) icons/extra.mjs and icons/hardware.mjs (icons added in this package).
// Groups with the same name are merged, base icons first. Fails on a name drawn in both
// sources, a grouped name with no drawing, or a drawing that no group lists.
// Run: node packages/ui/scripts/gen-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const { BASE_ICONS: SX_ICONS, BASE_ICON_GROUPS: SX_ICON_GROUPS } = await import(pathToFileURL(resolve(here, '../icons/base.mjs')).href)
const { EXTRA_ICONS, EXTRA_ICON_GROUPS } = await import(pathToFileURL(resolve(here, '../icons/extra.mjs')).href)

const { HARDWARE_ICONS, HARDWARE_ICON_GROUPS } = await import(pathToFileURL(resolve(here, '../icons/hardware.mjs')).href)

const collisions = [...Object.keys(EXTRA_ICONS), ...Object.keys(HARDWARE_ICONS)].filter((n, i, all) => Object.hasOwn(SX_ICONS, n) || all.indexOf(n) !== i)
if (collisions.length) throw new Error('icons redrawn across icons/base.mjs, icons/extra.mjs and icons/hardware.mjs: ' + collisions.join(', '))

const icons = { ...SX_ICONS, ...EXTRA_ICONS, ...HARDWARE_ICONS }
// The concept file predates the mimir name; the group label follows the product name.
const label = (group) => (group === 'Pilot' ? 'mimir' : group)
const groups = {}
for (const source of [SX_ICON_GROUPS, EXTRA_ICON_GROUPS, HARDWARE_ICON_GROUPS]) {
  for (const [group, list] of Object.entries(source)) groups[label(group)] = [...(groups[label(group)] ?? []), ...list]
}

const names = Object.keys(icons)
const grouped = Object.values(groups).flat()
const missing = grouped.filter((n) => !Object.hasOwn(icons, n))
if (missing.length) throw new Error('icons listed in a group but not drawn: ' + missing.join(', '))
const twice = grouped.filter((n, i) => grouped.indexOf(n) !== i)
if (twice.length) throw new Error('icons listed in more than one group: ' + twice.join(', '))
const loose = names.filter((n) => !grouped.includes(n))
if (loose.length) throw new Error('icons drawn but not in any group: ' + loose.join(', '))

const { STARTUP_ICONS } = await import(pathToFileURL(resolve(here, '../icons/startup.mjs')).href)
const undrawn = STARTUP_ICONS.filter((n) => !Object.hasOwn(icons, n))
if (undrawn.length) throw new Error('icons/startup.mjs lists icons that are not drawn: ' + undrawn.join(', '))

const header = [
  // REUSE-IgnoreStart
  '// SPDX-License-Identifier: Apache-2.0',
  // REUSE-IgnoreEnd
  '// Copyright (C) 2026 The SlicerX contributors',
  '// Generated from icons/*.mjs by scripts/gen-icons.mjs. Do not edit by hand.',
  '',
]
// The names alone, for the type and isIconName, as one string so a startup chunk carries no quoted icon names.
writeFileSync(resolve(here, '../src/icons/icon-names.ts'), [
  ...header,
  'export type IconName =',
  ...names.map((n) => `  | ${JSON.stringify(n)}`),
  '',
  '/** Every icon name. */',
  `export const ICON_NAMES: ReadonlySet<string> = new Set(${JSON.stringify(names.join(' '))}.split(' '))`,
  '',
].join('\n'))
// The markup of the icons in icons/startup.mjs, which loads with the shell; the full table loads on first use.
writeFileSync(resolve(here, '../src/icons/icon-startup.ts'), [
  ...header,
  "import type { IconName } from './icon-names'",
  '',
  '/** Inner SVG markup of the icons the shell can draw at its first paint (icons/startup.mjs). */',
  'export const STARTUP_ICON_PATHS: Partial<Record<IconName, string>> = {',
  ...STARTUP_ICONS.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(icons[n])},`),
  '}',
  '',
].join('\n'))

const lines = [
  ...header,
  "import type { IconName } from './icon-names'",
  '',
  '/** Inner SVG markup for each icon, drawn on a 24px grid at stroke 1.75 in currentColor. */',
  'export const ICON_PATHS = {',
  ...names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(icons[n])},`),
  '} as const satisfies Record<IconName, string>',
  '',
  "export type { IconName } from './icon-names'",
  '',
  '/** The icon names by group, in the order the icon pages show them. */',
  'export const ICON_GROUPS: Readonly<Record<string, readonly IconName[]>> = {',
  ...Object.entries(groups).map(([g, list]) => `  ${JSON.stringify(g)}: ${JSON.stringify(list)},`),
  '}',
  '',
  `export const ICON_COUNT = ${names.length}`,
  '',
]
writeFileSync(resolve(here, '../src/icons/icon-paths.ts'), lines.join('\n'))
console.log(`wrote ${names.length} icons, ${STARTUP_ICONS.length} of them in the startup table (${Object.keys(SX_ICONS).length} from icons/base.mjs, ${Object.keys(EXTRA_ICONS).length} from icons/extra.mjs, ${Object.keys(HARDWARE_ICONS).length} from icons/hardware.mjs) in ${Object.keys(groups).length} groups`)
