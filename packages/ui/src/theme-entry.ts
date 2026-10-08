// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// React-free entry: "@slicerx/ui/theme". Safe for Node tools and servers.
export { SCENE_VARS, subban, nocturne, createTheme, themeToVars, themeToCss, applyTheme, clearTheme, onThemeChange, resolveColor, THEME_EVENT } from './theme'
export type { Theme, ThemeInput, ThemeColors, ThemeGradient, ThemeFonts, ThemeRadius, ThemeSpacing, ThemeScene, ColorScheme } from './theme'
export { subbanLight, nocturneLight, forge, themes } from './themes'
export type { ThemeName } from './themes'
export { THEME_FILE_VERSION, TEXT_CONTRAST, GLYPH_CONTRAST, HIGH_TEXT_CONTRAST, COLOR_VISION, MAX_THEME_BYTES, derivePalette, deriveScene, SCENE_KEYS, themeColors, themeFromFile, validateThemeFile, parseThemeText, serializeTheme, themeWarnings, mixHex, contrast, readable, rehue, parseHex, formatHex } from './themefile'
export type { ThemeFile, DerivedPalette, ThemeResult, PaletteOptions, ContrastLevel, ColorVision } from './themefile'
export { DEFAULT_THEMES, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, DEFAULT_THEME_IDS, LEGACY_THEME_IDS, allThemes, findTheme, pickTheme, pickFamily, familyId, themeFamilies, migrateThemeId, themeForScheme, slugify } from './theme-library'
export type { ThemeIds, ThemeFamily } from './theme-library'
export { TEXT_SIZES, FONT_WEIGHTS, TEXT_SCALE, WEIGHT_STEPS, bodyPx, typeVars, applyType } from './appearance'
export type { TextSize, FontWeight } from './appearance'
export { UI_FONTS, MONO_FONTS, DEFAULT_UI_FONT, DEFAULT_MONO_FONT, THEME_FONT_CHOICE, resolveFonts } from './fonts'
export type { FontOption, FontChoice, ResolvedFonts } from './fonts'
