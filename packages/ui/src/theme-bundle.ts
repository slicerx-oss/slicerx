// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every bundled theme (JSON files in packages/ui/themes), for the picker. Loaded on demand, so the app's
// startup carries only the default theme (theme-library.ts).

import subbanDark from '../themes/subban-dark.json'
import subbanLight from '../themes/subban-light.json'
import dracula from '../themes/dracula.json'
import alucard from '../themes/alucard.json'
import catppuccinMocha from '../themes/catppuccin-mocha.json'
import catppuccinMacchiato from '../themes/catppuccin-macchiato.json'
import catppuccinFrappe from '../themes/catppuccin-frappe.json'
import catppuccinLatte from '../themes/catppuccin-latte.json'
import nord from '../themes/nord.json'
import nordLight from '../themes/nord-light.json'
import atomOneDark from '../themes/atom-one-dark.json'
import oneLight from '../themes/one-light.json'
import tokyoNight from '../themes/tokyo-night.json'
import tokyoNightDay from '../themes/tokyo-night-day.json'
import githubDark from '../themes/github-dark.json'
import githubLight from '../themes/github-light.json'
import solarizedDark from '../themes/solarized-dark.json'
import solarizedLight from '../themes/solarized-light.json'
import night from '../themes/night.json'
import nightLight from '../themes/night-light.json'
import gothic from '../themes/gothic.json'
import gothicDark from '../themes/gothic-dark.json'
import newsprint from '../themes/newsprint.json'
import newsprintDark from '../themes/newsprint-dark.json'
import pixyll from '../themes/pixyll.json'
import pixyllDark from '../themes/pixyll-dark.json'
import whitey from '../themes/whitey.json'
import whiteyDark from '../themes/whitey-dark.json'
import { bundledFile } from './theme-library'
import type { ThemeFile } from './themefile'

/** Family by family, Subban first; within a family the dark modes, then the light one. */
export const BUNDLED_THEMES: readonly ThemeFile[] = [
  subbanDark,
  subbanLight,
  dracula,
  alucard,
  catppuccinMocha,
  catppuccinMacchiato,
  catppuccinFrappe,
  catppuccinLatte,
  nord,
  nordLight,
  atomOneDark,
  oneLight,
  tokyoNight,
  tokyoNightDay,
  githubDark,
  githubLight,
  solarizedDark,
  solarizedLight,
  night,
  nightLight,
  gothic,
  gothicDark,
  newsprint,
  newsprintDark,
  pixyll,
  pixyllDark,
  whitey,
  whiteyDark,
].map(bundledFile)
