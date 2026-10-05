// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// React-free entry: "@slicerx/ui/theme". Safe for Node tools and servers.
export { SCENE_VARS, nocturne, createTheme, themeToVars, themeToCss, applyTheme, clearTheme, onThemeChange, resolveColor, THEME_EVENT } from './theme'
export type { Theme, ThemeInput, ThemeColors, ThemeGradient, ThemeFonts, ThemeRadius, ThemeSpacing, ThemeScene, ColorScheme } from './theme'
export { nocturneLight, forge, themes } from './themes'
export type { ThemeName } from './themes'
export { THEME_FILE_VERSION, TEXT_CONTRAST, GLYPH_CONTRAST, MAX_THEME_BYTES, derivePalette, deriveScene, SCENE_KEYS, themeColors, themeFromFile, validateThemeFile, parseThemeText, serializeTheme, themeWarnings, mixHex, contrast, readable, rehue, parseHex, formatHex } from './themefile'
export type { ThemeFile, DerivedPalette, ThemeResult } from './themefile'
export { BUNDLED_THEMES, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, DEFAULT_THEME_IDS, allThemes, findTheme, pickTheme, themeForScheme, slugify } from './theme-library'
export type { ThemeIds } from './theme-library'
export { UI_FONTS, MONO_FONTS, DEFAULT_UI_FONT, DEFAULT_MONO_FONT, THEME_FONT_CHOICE, resolveFonts } from './fonts'
export type { FontOption, FontChoice, ResolvedFonts } from './fonts'
