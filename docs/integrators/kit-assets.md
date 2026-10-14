# Standalone icons and tooltip loops

The integrator kit includes `assets/`, usable without React, SlicerX packages, or an app runtime. It contains every registered shaded tool icon in its own 32, 24 and 16 px drawing, the line icon set, and every registered tooltip demo. Both dark and light SVG variants are included. Still diagrams remain still; animated demos retain their CSS and SMIL animation and reduced-motion frame.

Build the full kit as usual, or generate just the assets with Node 24:

```sh
node scripts/pack-integrator-kit.mjs ./slicerx-kit --assets-only
```

`assets/manifest.json` records `kind`, `id`, `settingKey`, `title`, `theme`, `file`, and pixel `size` for each asset. Non-setting assets have `settingKey: null`. A loop shared by several settings has several manifest rows pointing to the same file. Loop titles are the registry's descriptive sentences; icon titles are readable forms of the stable icon ids. The manifest is the authoritative file list when regenerating into an existing folder.

## One stylesheet for colors

Include `assets/tokens.css`, then your overrides. Wrap inline SVGs in a theme container:

```html
<link rel="stylesheet" href="assets/tokens.css">
<style>[data-sx-theme] { --accent: #009b87; }</style>
<div data-sx-theme="dark"><!-- Insert the SVG markup here. --></div>
<div data-sx-theme="light"><!-- Insert the SVG markup here. --></div>
```

The token names are the existing UI contract: `--accent`, `--fg`, `--ink-0`, `--red`, `--cyan`, `--f-body`, `--scene-*`, `--stage-*`, and `--ti-*`. Changing `--accent` on the same theme container changes the derived icon and loop shades. Set individual stage or icon tokens for finer control. No app stylesheet is required.

Every SVG also contains fallback colors, so opening the file by itself works. CSS on a parent HTML page cannot cross into an `<img>` or `<object>` document. Insert SVG markup inline when you want the shared stylesheet to recolor it. Defaults and overrides preserve CSS variables rather than baking a custom palette into thousands of paths.

Exported ids and animation names are prefixed per asset, theme, and size, allowing different assets and both themes on one page. If inserting the same file more than once, give each copy a unique id prefix and update its `href` and `url(#...)` references, or use separate image documents.

## Plain HTML example

Serve the `assets` folder over HTTP and open `example.html`. It loads three shaded tool icons and three loops in both themes, using `example.css` to change the accent. The only JavaScript fetches trusted local SVG files and inserts their markup. The example does not load any app bundle, framework, font service, or backend.

Clients: the kit packaging command adds `--assets-only`; `node scripts/export-kit-assets.mjs <assets-directory>` is also available. No MCP tool or application command changes.
