# Theming @slicerx/ui

Every component reads its colors, gradient, fonts, radii and spacing from CSS variables. A theme is a typed object that sets those variables. Nocturne, the dark default, is built in; you can ship your own brand on top of it, switch themes at runtime without a reload, replace icons, and put your own logo in the brand slot.

## Quick start

```tsx
import '@slicerx/ui/styles.css'
import { ThemeProvider, createTheme, nocturneLight } from '@slicerx/ui'

const acme = createTheme({
  name: 'acme',
  colors: { purple: '#2f6df6', pink: '#22c1c3', onGrad: '#ffffff' },
  fonts: { body: '"Inter", system-ui, sans-serif', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' },
  radius: { md: '6px', lg: '10px' },
})

export function App() {
  const [theme, setTheme] = useState(acme)
  return (
    <ThemeProvider theme={theme} logo={<img src="/acme.svg" alt="Acme" height={18} />}>
      <button onClick={() => setTheme(nocturneLight)}>Light</button>
      ...
    </ThemeProvider>
  )
}
```

Link `theme.fonts.href` in the document head when your theme names faces the page does not already load.

## The theme object

```ts
interface Theme {
  name: string                 // short id; appears as data-sx-theme on the themed element
  scheme: 'dark' | 'light'     // sets color-scheme so native controls and scrollbars match
  colors: ThemeColors
  gradient: { from: string; to: string; angle: string }
  fonts: { display: string; body: string; mono: string; href?: string }
  radius: { xs: string; sm: string; md: string; lg: string }
  spacing: { unit: number }    // px; every spacing token is a multiple (8 by default)
}
```

`ThemeColors`:

| Key | Variable | Used for |
| --- | --- | --- |
| `ink0` to `ink4` | `--ink-0` to `--ink-4` | Surfaces, from the page background to raised controls |
| `line`, `lineSoft` | `--line`, `--line-soft` | Hairlines on controls and between sections |
| `fg`, `muted`, `dim` | `--fg`, `--muted`, `--dim` | Content text, labels, captions and placeholders |
| `purple` | `--purple` | Accent, selection, focus |
| `pink` | `--pink` | Creators, commerce, Vault |
| `cyan` | `--cyan` | Progress, info, live data |
| `green` | `--green` | Ready, ok |
| `orange` | `--orange` | Needs attention |
| `yellow` | `--yellow` | String literals in code views |
| `red` | `--red` | Errors |
| `onGrad` | `--on-grad` | Text on the gradient |
| `shadow` | `--shadow-color` | Shadow color, with alpha |

The keys keep their Nocturne names so a recolored theme still reads the same in code: `purple` is "the accent color" even when you make it blue. Tints (`--purple-tint`, `--pink-tint`, `--purple-ring`, `--glass`) derive from these with `color-mix`, so they follow your colors.

`gradient.from` and `gradient.to` default to `var(--purple)` and `var(--pink)`; set concrete colors to detach the gradient from the accent. The gradient is reserved for the logo, the single primary action on a screen, and the active tab underline.

## Functions

- `createTheme(overrides, base = nocturne)`: merges nested overrides on top of a base theme and returns a complete `Theme`.
- `themeToVars(theme)`: the variables as a name to value map.
- `themeToCss(theme, selector = ':root')`: a stylesheet rule, for server rendering or a static theme.
- `applyTheme(theme, element = document.documentElement)`: sets the variables at runtime and dispatches an `sx-theme` event.
- `clearTheme(element?)`: removes them, so the stylesheet defaults apply again.
- `onThemeChange(callback, target = document)`: subscribes to theme changes; returns an unsubscribe.
- `resolveColor(theme, value)`: turns `var(--purple)` style references into the theme's concrete color, for canvases and WebGPU materials that cannot read CSS.

## ThemeProvider

```tsx
<ThemeProvider theme={theme} icons={overrides} logo={node} scope="root" | "scope">
```

- `theme`: applied on mount and whenever the prop changes. On the server it renders a style tag so the first paint is themed.
- `scope`: `"root"` (default) themes the whole document, so the page background, dialogs and toasts follow. `"scope"` wraps children in a `div[data-sx-theme]` and themes only that subtree, for embedding a themed SlicerX panel inside another product.
- `icons`: a partial map from icon name to inner SVG markup on the 24px grid (stroke 1.75, `currentColor`). Overridden icons render wherever the package uses `Icon`.
- `logo`: any element. It replaces the SlicerX wordmark and mark in `Logo`, and so in the app bar. Keep it about 18px tall for the bar.

`useTheme()` returns `{ theme, icons, logo }` for your own components.

## Built-in themes

- `nocturne`: the default, dark.
- `nocturneLight`: the same palette meanings on light surfaces, text contrast at WCAG AA.
- `forge`: an example rebrand with a warm accent, other typefaces, sharper corners and a 6px grid. Use it as a starting point for your own.

`themes` maps the three by name.

## Rules that keep a theme readable

- Keep the roles. Purple is the accent, pink is commerce, cyan is live data, green ok, orange attention, red error. Change the hues, not what they mean.
- Check text contrast: `fg` on `ink0` to `ink3` and `muted` on `ink1` should pass WCAG AA at body size.
- Keep `line` visibly different from `ink3`, or controls lose their edges.
- Pick an `onGrad` that reads on both gradient stops.
- The spacing unit changes every gap and gutter at once; values between 6 and 10 keep the layout intact.

## Static theming without React

Build the stylesheet once and ship it:

```ts
import { themeToCss, forge } from '@slicerx/ui'
writeFileSync('theme.css', themeToCss(forge))
```

Or set the variables by hand in your own CSS; the names in the table above are the contract.
