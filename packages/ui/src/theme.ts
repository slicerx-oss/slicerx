// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Themes: a typed object that maps onto the CSS variables every component reads. Nocturne is the
// default. Integrators build their own with createTheme() and apply it at runtime with
// applyTheme() or <ThemeProvider>. See THEMING.md.

export type ColorScheme = 'dark' | 'light'

/** Surface, text and meaning colors. Any CSS color value. */
export interface ThemeColors {
  /** Surfaces, from the page background (ink0) to raised controls (ink4). */
  ink0: string
  ink1: string
  ink2: string
  ink3: string
  ink4: string
  /** Hairlines: line for controls, lineSoft for dividers. */
  line: string
  lineSoft: string
  /** Text: fg for content, muted for labels, dim for captions and placeholders. */
  fg: string
  muted: string
  dim: string
  /** Meaning. Components pick these by role (see ROLE); keep the roles when you recolor. */
  purple: string
  pink: string
  cyan: string
  green: string
  orange: string
  yellow: string
  red: string
  /** Text drawn on top of the gradient. */
  onGrad: string
  /** The color shadows are made of, including alpha. */
  shadow: string
}

/** The signature gradient: logo, the one primary action per screen, the active tab underline. */
export interface ThemeGradient {
  from: string
  to: string
  /** CSS angle, for example "135deg". */
  angle: string
}

export interface ThemeFonts {
  /** Display face for titles and big numbers. */
  display: string
  /** UI and body face. */
  body: string
  /** Numbers, units, temperatures, file names. */
  mono: string
  /** Optional stylesheet that loads the faces; link it in the document head. */
  href?: string
}

export interface ThemeRadius {
  xs: string
  sm: string
  md: string
  lg: string
}

export interface ThemeSpacing {
  /** The grid unit in px. Every spacing token is a multiple of it; 8 is the default. */
  unit: number
}

/** Colors of the 3D studio behind the model. All are #rrggbb. */
export interface ThemeScene {
  /** Backdrop gradient, top edge. */
  top: string
  /** Backdrop gradient, bottom edge. */
  bottom: string
  /** Soft glow behind the model. */
  glow: string
  /** Side of the build plate. */
  plate: string
  /** Floor grid lines. */
  grid: string
  /** Outline of the model's edges. */
  edge: string
  /** Edges in x-ray mode. Optional: the default applies when absent. */
  xray?: string
}

export interface Theme {
  /** A short id, used in data-sx-theme on the themed element. */
  name: string
  scheme: ColorScheme
  colors: ThemeColors
  gradient: ThemeGradient
  fonts: ThemeFonts
  radius: ThemeRadius
  spacing: ThemeSpacing
  /** The 3D studio colors. Absent means the default dark studio. */
  scene?: ThemeScene
}

/** What createTheme() accepts: any subset, nested. */
export interface ThemeInput {
  name?: string
  scheme?: ColorScheme
  colors?: Partial<ThemeColors>
  gradient?: Partial<ThemeGradient>
  fonts?: Partial<ThemeFonts>
  radius?: Partial<ThemeRadius>
  spacing?: Partial<ThemeSpacing>
  scene?: ThemeScene
}

/** The default theme: Nocturne, a Dracula-derived dark palette. */
export const nocturne: Theme = {
  name: 'nocturne',
  scheme: 'dark',
  colors: {
    ink0: '#282a36',
    ink1: '#2c2e3c',
    ink2: '#2f3241',
    ink3: '#343746',
    ink4: '#3c3f50',
    line: '#44475a',
    lineSoft: '#3c3e4f',
    fg: '#f8f8f2',
    muted: '#9aa4c1',
    dim: '#8f9abb',
    purple: '#bd93f9',
    pink: '#ff79c6',
    cyan: '#8be9fd',
    green: '#50fa7b',
    orange: '#fab570',
    yellow: '#f1fa8c',
    red: '#ff5555',
    onGrad: '#1e2029',
    shadow: 'rgb(0 0 0 / 70%)',
  },
  gradient: { from: 'var(--purple)', to: 'var(--pink)', angle: '135deg' },
  fonts: {
    display: '"Unbounded Variable", "Unbounded", "Arial Black", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    body: '"Hanken Grotesk Variable", "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '16px' },
  spacing: { unit: 8 },
}

/** Builds a theme from overrides on top of a base (Nocturne unless given). */
export function createTheme(input: ThemeInput, base: Theme = nocturne): Theme {
  const fonts: ThemeFonts = { ...base.fonts, ...input.fonts }
  if (input.fonts && 'href' in input.fonts && input.fonts.href === undefined) delete fonts.href
  const scene = input.scene ?? base.scene
  return {
    ...(scene ? { scene } : {}),
    name: input.name ?? base.name,
    scheme: input.scheme ?? base.scheme,
    colors: { ...base.colors, ...input.colors },
    gradient: { ...base.gradient, ...input.gradient },
    fonts,
    radius: { ...base.radius, ...input.radius },
    spacing: { ...base.spacing, ...input.spacing },
  }
}

const COLOR_VARS: Record<keyof ThemeColors, string> = {
  ink0: '--ink-0',
  ink1: '--ink-1',
  ink2: '--ink-2',
  ink3: '--ink-3',
  ink4: '--ink-4',
  line: '--line',
  lineSoft: '--line-soft',
  fg: '--fg',
  muted: '--muted',
  dim: '--dim',
  purple: '--purple',
  pink: '--pink',
  cyan: '--cyan',
  green: '--green',
  orange: '--orange',
  yellow: '--yellow',
  red: '--red',
  onGrad: '--on-grad',
  shadow: '--shadow-color',
}

/** The CSS variables the 3D viewport reads its studio colors from. */
export const SCENE_VARS: Record<keyof ThemeScene, string> = {
  top: '--scene-top',
  bottom: '--scene-bottom',
  glow: '--scene-glow',
  plate: '--scene-plate',
  grid: '--scene-grid',
  edge: '--scene-edge',
  xray: '--scene-xray',
}

const SPACING_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6, 8]

/** The CSS custom properties a theme sets, as a name to value map. */
export function themeToVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const key of Object.keys(COLOR_VARS) as (keyof ThemeColors)[]) vars[COLOR_VARS[key]] = theme.colors[key]
  vars['--grad-from'] = theme.gradient.from
  vars['--grad-to'] = theme.gradient.to
  vars['--grad-angle'] = theme.gradient.angle
  vars['--f-display'] = theme.fonts.display
  vars['--f-body'] = theme.fonts.body
  vars['--f-mono'] = theme.fonts.mono
  vars['--r-xs'] = theme.radius.xs
  vars['--r-sm'] = theme.radius.sm
  vars['--r-md'] = theme.radius.md
  vars['--r-lg'] = theme.radius.lg
  SPACING_STEPS.forEach((step, i) => {
    vars[`--s-${i + 1}`] = `${theme.spacing.unit * step}px`
  })
  vars['--gutter'] = `${theme.spacing.unit * 2}px`
  if (theme.scene) for (const k of Object.keys(SCENE_VARS) as (keyof ThemeScene)[]) if (theme.scene[k]) vars[SCENE_VARS[k]] = theme.scene[k] as string
  return vars
}

/**
 * A stylesheet rule that applies the theme to a selector. Use it for server rendering
 * (put the string in a style tag) or for a static theme with no runtime switching.
 */
export function themeToCss(theme: Theme, selector = ':root'): string {
  const body = Object.entries(themeToVars(theme))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${body}\n}\n`
}

export const THEME_EVENT = 'sx-theme'

/**
 * Applies a theme at runtime, with no reload: sets the variables on the element (the document
 * root by default), records the name in data-sx-theme, and dispatches an "sx-theme" event that
 * canvases and the viewport listen to (see onThemeChange).
 */
export function applyTheme(theme: Theme, el?: HTMLElement): void {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!target) return
  const vars = themeToVars(theme)
  for (const [k, v] of Object.entries(vars)) target.style.setProperty(k, v)
  // Studio colors of an earlier theme must not linger when this one sets none.
  for (const k of Object.values(SCENE_VARS)) if (!(k in vars)) target.style.removeProperty(k)
  target.style.setProperty('color-scheme', theme.scheme)
  target.dataset['sxTheme'] = theme.name
  target.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme, bubbles: true }))
}

/** Removes what applyTheme set, so the stylesheet defaults apply again. */
export function clearTheme(el?: HTMLElement): void {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!target) return
  for (const k of Object.keys(themeToVars(nocturne))) target.style.removeProperty(k)
  for (const k of Object.values(SCENE_VARS)) target.style.removeProperty(k)
  target.style.removeProperty('color-scheme')
  delete target.dataset['sxTheme']
}

/** Calls back with each theme applied under the element (the document by default). Returns an unsubscribe. */
export function onThemeChange(cb: (theme: Theme) => void, el?: EventTarget): () => void {
  const target = el ?? (typeof document !== 'undefined' ? document : undefined)
  if (!target) return () => undefined
  const handler = (e: Event) => cb((e as CustomEvent<Theme>).detail)
  target.addEventListener(THEME_EVENT, handler)
  return () => target.removeEventListener(THEME_EVENT, handler)
}

/**
 * The theme's colors as concrete values for code that draws outside CSS (WebGPU materials,
 * canvas). Values that reference variables (the default gradient stops) resolve through the
 * colors map; anything else is returned as written.
 */
export function resolveColor(theme: Theme, value: string): string {
  const m = value.match(/^var\((--[a-z0-9-]+)\)$/)
  if (!m) return value
  const key = (Object.keys(COLOR_VARS) as (keyof ThemeColors)[]).find((k) => COLOR_VARS[k] === m[1])
  return key ? theme.colors[key] : value
}
