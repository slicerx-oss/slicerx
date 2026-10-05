# Copy and snippets

Text and markup for crediting SlicerX in your product, site, docs and announcements. Paste it as it is.

## The credit line

Made possible by SlicerX

Link it to https://slicerx.app/support. That page has both ways to support the project.

## What SlicerX is

One sentence:

> SlicerX is a free, open source slicer for 3D printers, with its own slicing engine written in Rust.

One paragraph:

> SlicerX is a free, open source slicer for 3D printers, with its own slicing engine written in Rust and a mesh CAD layer. It produces the same G-code on the desktop and in the browser, prints to printers on your local network without an account, and has a CLI, a C library, a WebAssembly package and an MCP server so other software can drive it. The code is Apache-2.0.

## Support SlicerX

> SlicerX is free and open source. If it helps you print, you can support its development on [Buy Me a Coffee](https://buymeacoffee.com/xccyf47w7r) or through [GitHub Sponsors](https://github.com/sponsors/Subydev). Both are listed at [slicerx.app/support](https://slicerx.app/support).

The source code will be at https://github.com/slicerx-oss/slicerx (coming soon). Leave that link out of anything you publish until the repository is public.

## Snippets

Copy the image files into your own site or repository. The snippets assume they sit in an `img/` folder next to the page; change the path to match yours. Each SVG is drawn with outlined type, so it looks the same without the fonts installed. Use the PNGs where SVG is not allowed, and the `@2x` file on high density screens.

### Badge, small (155 x 20)

HTML, switching with the reader's color scheme:

```html
<a href="https://slicerx.app/support">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="img/made-possible-by-slicerx-small-light.svg">
    <img src="img/made-possible-by-slicerx-small-dark.svg" width="155" height="20" alt="Made possible by SlicerX">
  </picture>
</a>
```

Markdown:

```markdown
[![Made possible by SlicerX](img/made-possible-by-slicerx-small-dark.svg)](https://slicerx.app/support)
```

### Badge, medium (221 x 32)

```html
<a href="https://slicerx.app/support">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="img/made-possible-by-slicerx-medium-light.svg">
    <img src="img/made-possible-by-slicerx-medium-dark.svg" width="221" height="32" alt="Made possible by SlicerX">
  </picture>
</a>
```

```markdown
[![Made possible by SlicerX](img/made-possible-by-slicerx-medium-dark.svg)](https://slicerx.app/support)
```

### Badge, large (317 x 48)

```html
<a href="https://slicerx.app/support">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="img/made-possible-by-slicerx-large-light.svg">
    <img src="img/made-possible-by-slicerx-large-dark.svg" width="317" height="48" alt="Made possible by SlicerX">
  </picture>
</a>
```

```markdown
[![Made possible by SlicerX](img/made-possible-by-slicerx-large-dark.svg)](https://slicerx.app/support)
```

### Support button (184 x 40)

For a site footer or an About page.

```html
<a href="https://slicerx.app/support">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="img/support-slicerx-light.svg">
    <img src="img/support-slicerx-dark.svg" width="184" height="40" alt="Support SlicerX">
  </picture>
</a>
```

```markdown
[![Support SlicerX](img/support-slicerx-dark.svg)](https://slicerx.app/support)
```

### A PNG for places that refuse SVG

```html
<a href="https://slicerx.app/support"><img src="img/made-possible-by-slicerx-small-dark.png" srcset="img/made-possible-by-slicerx-small-dark@2x.png 2x" width="155" height="20" alt="Made possible by SlicerX"></a>
```

### Plain text, for an About screen or a store description

```text
Made possible by SlicerX (https://slicerx.app/support)
```

## Screenshots

`screenshots/` has three shots at 1600 by 1000 for an announcement: the printer wall, the slicer's Preview, and one printer's live view. They show "Acme Slicer", the sample white-label edition in `packages/edition-config/fixtures/acme`, with demo data turned on, so they look like a partner edition and not like SlicerX itself. The printers and jobs are simulated. Your own edition will show your name, logo and colors in the same places.
