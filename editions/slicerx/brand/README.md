# The SlicerX brand kit

The icon is huginn, the raven, perched on three printed layers, in the purple to pink of the
filament gradient. The logo is the word Slicer with an X drawn as offset perimeters standing in for
its last letter: nested outlines in pink, purple and cyan, the way a slicer insets each wall.
Everything the apps and the site serve is generated from geometry, so both stay sharp at 16 px,
every file stays small, and the colors come from the Nocturne tokens.

This kit is the build of the brand assets. Files here are Apache-2.0 like the rest of the edition. The name and
the mark are SlicerX's: a fork changes both (see `docs/integrating.md`).

## Files

| File | What it does |
|---|---|
| `geometry.mjs` | the X, its cuts and palettes, the glow, the squircle |
| `raven.mjs` | the icon: the raven, its layers, its cuts and palettes |
| `text.mjs` | outlines type and builds the lockups |
| `emit.mjs` | writes every SVG in `svg/`, plus `paths.json` and `layout.json` |
| `raster.mjs` | renders `svg/` to `out/`: PNGs, `.ico`, `.icns` |
| `credit.mjs` | draws the "Made possible by SlicerX" badges and the "Support SlicerX" button into `docs/integrators/credit-kit/` |
| `wire.mjs` | copies the results to the site, the phone app, the desktop app and the README |
| `build.sh` | runs them in order. `--no-wire` stops before the copies |
| `export.sh <dir>` | copies the kit to a folder outside the repo for handing to other people |

Run `./build.sh`. It needs Node 24 and, the first time, network access to install `sharp` and
`opentype.js` into `.cache/`, which git ignores. The fonts (Unbounded, Hanken Grotesk, JetBrains
Mono, all SIL OFL) are read from the workspace install of `@expo-google-fonts`, or from `FONT_DIR`.
Nothing heavy runs: a full build takes a few seconds, so it stays on this machine.

## The icon

Drawn on a 100 unit grid. The raven faces left and sits on the top layer, its tail over the right
end of the stack. It is one silhouette with the folded wing and the eye cut out of it, so it reads
as a raven in one color too: a heavy beak, shaggy throat hackles, a wedge tail. The three layers are
beads with round ends, each a step wider than the one above, the way a print's first layers spread.
The art is moved a little up and left of the box's center, because the bird is heavy at the top
left and its tail is light. `raven.mjs` holds the shapes and `packages/ui/src/icons/perch-path.ts`
repeats them for the app's `AppMark`.

| Cut | What changes | Used at |
|---|---|---|
| full | hackles, a tapered wing gap, 4.8 unit layers | 64 px and up, and all print |
| small | a plain throat, a wider wing gap and eye, heavier layers with wider gaps | 20 to 48 px |
| 32 px | the small cut on a 32 px grid: 2 px layers and 1 px gaps on whole rows, a 2 px eye | the 32 px Windows frame and the Safari tile |
| 16 px | on a 16 px grid: 1 px layers on rows 10, 12 and 14, no legs or wing gap, a 1 px eye on a plate | the 16 px frames and the browser tab |

The bird runs from purple at the top left to pink at the bottom right. The layers run cyan to purple
left to right, the aegis gradient, `#8be9fd` to `#bd93f9`, so their purple end meets the bird's. On
light surfaces they deepen to `#1a8fb0` to `#6b3fc4`, which read on white. The bird's palettes are the X's `dark` and `light` pairs, plus `white`, `ink`,
`current` (one color that follows the text, for monochrome uses) and `mono`, a gray ramp for the
iOS tinted icon. Large icons on a ground of ours carry a soft violet glow around the bird, outside
its silhouette only. The layers cast none, so the gaps between them stay as dark as the plate.

| File | Use |
|---|---|
| `slicerx-mark.svg`, `slicerx-mark-light.svg` | the icon on clear, on dark and on light |
| `slicerx-mark-small.svg`, `slicerx-mark-small-light.svg` | the same, small cut |
| `slicerx-mark-white.svg`, `slicerx-mark-ink.svg` | one color, on dark and on light |
| `slicerx-mark-mono.svg`, `slicerx-mark-mono-small.svg` | `currentColor`, for monochrome uses |
| `slicerx-mark-16.svg` | the 16 px cut on clear |

## The X

Drawn on a 32 unit grid. The X is 24 units tall and 23 wide, centered, with horizontal terminals and
bands 9.6 units across. Inside the outer outline sit a second outline and a solid core, each inset
by the same slicer style offset with a gap under a unit between them. The outer outline is pink, the
second purple and the core cyan. `geometry.mjs` holds the math and `packages/ui/src/icons/mark-path.ts`
repeats it for the app, so the files and the app match.

The X alone is in `slicerx-x.svg`, `-light`, `-small`, `-small-light`, `-white` and `-ink`, for a
place that needs the letter without the word. It is not the icon.

### Colors

| Palette | Middle ring | Outer ring | Core | Where it goes |
|---|---|---|---|---|
| `dark` | `#bd93f9` | `#ff79c6` | `#8be9fd` | ink 0 and every dark surface. The default |
| `light` | `#6b3fc4` | `#c1268a` | `#0b7a99` | paper and every light surface. The dark set falls under 3 to 1 there, so it deepens |
| `white` | `#f8f8f2` | `#f8f8f2` | `#f8f8f2` | one color on dark: engraving, embossing, photos |
| `ink` | `#17181f` | `#17181f` | `#17181f` | one color on light: single ink print |
| `mono` | `#bdbdbd` | `#f2f2f2` | `#8a8a8a` | the iOS tinted icon, which the system colors itself |

Grounds: `#121319` (ink 0) dark, `#f4f4f9` light. The word is `#f8f8f2` on dark and `#17181f` on light.
The descriptor under a stacked lockup is `#a9afd0` on dark and `#4d5474` on light.

### Glow

Large marks on a ground of ours carry a soft violet glow at the edges. It exists outside the X only:
a mask cuts it off inside the shape, so the gaps between rings stay clear and the cut reads the
same with or without it. The glow is used on the app icons, the splash, the tile, the cards and the
dark banner. It is never used below 48 px, on a light ground, on a one-color mark, on the tinted
icon, or on a surface the brand does not own, such as a tab strip or somebody else's page.

### Cuts and sizes

The gaps between rings fall under one pixel below 48 px, so the small sizes have their own cuts, the
way a typeface has an optical size. It is one design, not three.

| Cut | Rings | Used at |
|---|---|---|
| full | two outlines and a solid core, outline 1.1 and 0.9 units | 48 px and up, and all print |
| small | one 1.5 unit outline and a solid core | 24 to 48 px: the large credit badge, the app's logo at small sizes, `slicerx-x-small` |
| tab | a 2.4 unit outline and a solid core on a slightly bolder X | under 20 px: the small credit badges, the app bar's logo |

Minimum size: on screen the mark is 16 px and the horizontal lockup 72 px wide. In print the mark is
6 mm and the horizontal lockup 25 mm wide.

### Clear space

Keep 8 units clear on every side of the mark, a quarter of its 32 unit box. The lockup files carry
that space built in (8 units of their own mark), so placing a file edge to edge never breaks the
rule. The mark files have it too, as the grid's own margin.

## The logo

The word Slicer in Unbounded 600, tracked -0.02em, with the mark standing in as its X. The X is drawn 5 percent
over the cap height (0.735 of the font size) and centered on it, because fine line work looks lighter
than Unbounded's solid letters. Its box overhangs the X by 4.5
units on each side, so it is pulled in by that much and 0.015 em is left before it, which spaces it
like a tight letter. There is no separate symbol in front and no typed X.

| File | Use |
|---|---|
| `slicerx-lockup.svg` | horizontal, on dark. The default |
| `slicerx-lockup-light.svg` | horizontal, on light |
| `slicerx-lockup-white.svg`, `slicerx-lockup-ink.svg` | one color, on dark and on light |
| `slicerx-lockup-stacked.svg`, `slicerx-lockup-stacked-light.svg` | over the descriptor, for square spaces. The mark never stacks above the word |

Inside the app and the site the logo is the `Logo` component in `@slicerx/ui`, which draws the same
geometry live. Use these files where a component cannot go: an email, a slide, a store listing.

## App icons

The raven and its layers are 80 percent of the plate across on every plate. The platform decides
the shape, the icon never changes.

| File | Platform | Notes |
|---|---|---|
| `slicerx-app-icon.svg` | iOS and iPadOS, dark | a full square, because the system rounds it. Flattened, no alpha |
| `slicerx-app-icon-light.svg` | iOS light | the `light` palette on a pale plate |
| `slicerx-app-icon-tinted.svg` | iOS tinted | gray on clear, no glow. The system lays its color and ground over it |
| `slicerx-app-icon-macos.svg` | macOS | a squircle plate on the 1024 grid with 100 px margin and a soft shadow |
| `slicerx-app-icon-macos-small.svg` | macOS, 32 to 64 px | small cut, no glow, no shadow |
| `slicerx-app-icon-windows.svg`, `-windows-small.svg` | Windows, and Linux | a square tile with a small radius, a top highlight and an edge light; small cut under 64 px |
| `slicerx-app-icon-16.svg`, `slicerx-app-icon-32.svg` | macOS and Windows at 16 px, Windows at 32 px | the pixel cuts on a plain plate |
| `slicerx-android-foreground.svg` | Android adaptive | the art inside a circle 61 percent across, the 66 dp safe zone |
| `slicerx-android-background.svg` | Android adaptive | solid ink 0 |
| `slicerx-android-monochrome.svg` | Android themed icon | alpha only |
| `slicerx-tile.svg`, `slicerx-tile-light.svg` | avatars | rounded plate |
| `slicerx-avatar.svg` | round crops, such as a Discord server | full bleed night square, the art inside a circle 80 percent across; also the manifest's maskable icon |
| `slicerx-splash.svg`, `slicerx-splash-light.svg` | launch screens | the mark on clear |

`out/desktop/` holds the Tauri set: `icon.icns` (16 to 1024 px with the @2x frames), `icon.ico`
(16 to 256 px, PNG frames), the PNG sizes and the Windows Store logos.

## Browser tab

Chrome and Firefox read `slicerx-tab.svg`: no tile, the 16 px cut so the layers land on whole
pixels at 16 and 32 px, and the colors ask the browser for its scheme (the `dark` pair on a dark
strip, the `light` pair on a light one). Safari reads no SVG icon and takes the `.ico`. When a
clear icon is too dark for its tab bar Safari puts a pale plate behind it, and an icon with a ground
of its own is left alone, so the `.ico` carries ink 0: `slicerx-tab-tile.svg` (the 32 px cut) at 32
and 48 px and `slicerx-tab-tile-16.svg` at 16. Check a change to either in both browsers, in both
schemes.

## Cards and banners

| File | Size | Use |
|---|---|---|
| `slicerx-og.svg`, `out/social/slicerx-og-1200x630.png` | 1200 by 630 | the static link preview |
| `slicerx-github-social.svg` | 1280 by 640 | the repository's social preview |
| `slicerx-banner-dark.svg`, `-light.svg` | 1280 by 360 | the README banner |
| `slicerx-og-art.svg` | 1200 by 630 | the card with no words, for the site's route |

The card is the ground, layer hairlines, and a large X standing at the right with the slice plane
through it. Rings below the plane are laid and lit, rings above are a ghost of what is still to
print. It is the brand's own story: a model built one layer at a time.

The site serves the same card from `apps/site/app/opengraph-image.tsx`. The route reads the art and
the lockup from `apps/site/assets/brand/`, sets the headline and tagline live in Hanken Grotesk, and
takes its positions from `layout.json`, so the static card and the live one share a layout.

## Where it goes

`wire.mjs` lists every copy. In short:

| Destination | What |
|---|---|
| `apps/site/app/` | `icon.svg`, `favicon.ico`, `apple-icon.png` |
| `apps/site/public/brand/` | the manifest icons, the mark and lockups, a static card. Public addresses: regenerate under the same name, never rename |
| `apps/site/assets/` | the art, lockup and layout the card route reads, and its three fonts |
| `editions/slicerx/apps/mobile/assets/` | `icon.png` (dark), `icon-light.png`, `icon-tinted.png`, `adaptive-icon.png`, `adaptive-icon-monochrome.png`, `splash-icon.png`, `splash-icon-light.png` |
| `apps/desktop/src-tauri/icons/` | the whole Tauri set, and `icons-src/icon-1024.png` |
| `docs/readme-assets/` | `banner.svg`, `banner-dark.svg`, `banner-light.svg` |

## Don't

- Stretch, squash, rotate or skew the icon, the mark or the lockup.
- Use the X alone as the app's icon, or put the raven in the wordmark. The icon is the raven, the
  logo keeps the X.
- Flip the raven to face right, or take it off its layers.
- Recolor the rings outside the palettes above, or reorder them.
- Drop the outer outline or the core from the full cut.
- Put a separate symbol in front of the word, or type the X.
- Put the glow on a small mark, a light ground, or a surface the brand does not own.
- Use the full cut below 48 px or the small cut above it. Pick the file made for the size.
- Put the mark on a ground that takes its contrast under 3 to 1: use `light`, `white` or `ink`.
- Add a drop shadow, a bevel or an outline to the lockup.
- Show the mark in a state color. State belongs to the status dot, never to the logo.

## Changing it

Edit the numbers in `raven.mjs` (the icon), `geometry.mjs` (the X, the cuts, the palettes),
`emit.mjs` (the plates, the cards) or `text.mjs` (the lockup), then run `./build.sh`. Change
`raven.mjs` and `packages/ui/src/icons/perch-path.ts` together. Colors also live in `design/tokens.css` and
`packages/ui`, and the palettes here have to be changed with them. The phone app's `Logo` and the
site's `Logo` draw the geometry live and take their colors from the theme.
