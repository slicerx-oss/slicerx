// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Export SVGs and their palette without a framework or app runtime.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TOOL_ICONS } from '../packages/ui/src/icons/tool-icons.ts'
import { ICON_PATHS } from '../packages/ui/src/icons/icon-paths.ts'
import { SMALL_ICON_PATHS } from '../packages/ui/src/icons/icon-small.ts'
import { stageInner, STAGE_W, STAGE_H } from '../packages/ui/src/components/tooltip-stage-svg.ts'
import { DEMOS, SETTING_DEMOS } from '../packages/app/src/lib/demos.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const title = (id) => id.replace(/[-_]/g, ' ').replace(/^./, (s) => s.toUpperCase())
const declarations = (s) => Object.fromEntries([...s.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))

export function palettes() {
  const css = read('packages/ui/src/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const base = declarations(css.match(/:root\s*\{([^}]+)\}/)[1])
  const light = declarations(css.match(/:root\[style\*="color-scheme: light"\]\s*\{([^}]+)\}/)[1])
  return Object.fromEntries(['dark', 'light'].map((scheme) => {
    const theme = JSON.parse(read(`packages/ui/themes/subban-${scheme}.json`))
    const vars = { ...base, ...(scheme === 'light' ? light : {}),
      '--accent': theme.accent, '--fg': theme.text, '--ink-0': theme.background,
      '--red': theme.ansi[1], '--cyan': theme.ansi[6], '--green': theme.ansi[2],
      '--scene-top': theme.scene.top, '--scene-bottom': theme.scene.bottom, '--scene-grid': theme.scene.grid,
      '--f-body': 'system-ui, -apple-system, sans-serif',
    }
    const keep = new Set(Object.keys(vars).filter((k) => /^--(?:stage-|ti-|scene-)/.test(k)))
    for (const k of ['--accent', '--fg', '--ink-0', '--red', '--cyan', '--green', '--f-body']) keep.add(k)
    for (const k of keep) for (const m of vars[k]?.matchAll(/var\((--[\w-]+)/g) ?? []) keep.add(m[1])
    return [scheme, Object.fromEntries([...keep].sort().filter((k) => vars[k]).map((k) => [k, vars[k]]))]
  }))
}

// Keep variables live for inline use, with complete fallbacks for an isolated SVG document.
export function fallbacks(text, vars, seen = new Set()) {
  let out = '', at = 0
  while (true) {
    const start = text.indexOf('var(', at)
    if (start < 0) return out + text.slice(at)
    out += text.slice(at, start)
    let end = start + 4, depth = 1, comma = -1
    for (; end < text.length && depth; end++) {
      const c = text[end]
      if (c === '(') depth++
      if (c === ')') depth--
      if (c === ',' && depth === 1 && comma < 0) comma = end
    }
    if (depth) throw new Error('Unclosed CSS variable')
    const name = text.slice(start + 4, comma < 0 ? end - 1 : comma).trim()
    if (seen.has(name)) throw new Error(`Circular token ${name}`)
    const value = vars[name] ?? (comma < 0 ? undefined : text.slice(comma + 1, end - 1).trim())
    if (value === undefined) throw new Error(`Missing default for ${name}`)
    out += `var(${name},${fallbacks(value, vars, new Set([...seen, name]))})`
    at = end
  }
}

export function namespaceSvg(text, prefix) {
  const ids = new Map([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], `${prefix}-${m[1]}`]))
  return text.replace(/\bid="([^"]+)"/g, (_, id) => `id="${ids.get(id)}"`)
    .replace(/url\(#([^)]*)\)/g, (_, id) => `url(#${ids.get(id) ?? id})`)
    .replace(/href="#([^"]+)"/g, (_, id) => `href="#${ids.get(id) ?? id}"`)
}

// Stage paths may combine their generated paint with a second inline style.
export function mergeSvgStyles(text) {
  return text.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const styles = [...tag.matchAll(/\sstyle="([^"]*)"/g)]
    if (styles.length < 2) return tag
    const merged = styles.map((m) => m[1].replace(/;?$/, ';')).join('')
    let first = true
    return tag.replace(/\sstyle="[^"]*"/g, () => {
      if (!first) return ''
      first = false
      return ` style="${merged}"`
    })
  })
}

// Unique classes isolate assets without adding ancestors that break SVG use clones.
export function namespaceClasses(text, prefix, rootClass) {
  const names = new Set([rootClass])
  for (const m of text.matchAll(/\bclass="([^"]+)"/g)) for (const name of m[1].split(/\s+/)) names.add(name)
  return text.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) =>
    `<style>${css.replace(/\.([a-zA-Z_][\w-]*)/g, (match, name) => names.has(name) ? `.${prefix}-${name}` : match)}</style>`)
    .replace(/\bclass="([^"]+)"/g, (_, classes) => `class="${classes} ${classes.split(/\s+/).map((name) => `${prefix}-${name}`).join(' ')}"`)
}

function documentSvg(id, scheme, width, height, cls, body, label, vars) {
  const prefix = `${id}-${scheme}-${width}`
  body = body.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) => {
    const names = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
    css = css.replace(/(@keyframes\s+|animation-name:)([\w-]+)/g, (match, lead, name) => names.has(name) ? `${lead}${prefix}-${name}` : match)
    return `<style>${css}</style>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls} ${prefix}-${cls}" data-sx-asset="${xml(id)}" data-sx-variant="${scheme}" data-sx-size="${width}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(label)}"><title>${xml(label)}</title>${namespaceSvg(fallbacks(namespaceClasses(mergeSvgStyles(body), prefix, cls), vars), prefix)}</svg>\n`
}

export async function exportAssets(dest) {
  mkdirSync(dest, { recursive: true })
  const themes = palettes(), assets = []
  const save = (file, content) => { mkdirSync(dirname(join(dest, file)), { recursive: true }); writeFileSync(join(dest, file), content) }
  save('tokens.css', '/* SPDX-License-Identifier: Apache-2.0 */\n/* Copyright (C) 2026 The SlicerX contributors */\n' + Object.entries(themes).map(([scheme, vars]) => `[data-sx-theme="${scheme}"] {\n  color-scheme: ${scheme};\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`).join('\n') + '\n')
  const iconCss = read('packages/ui/src/icons/tool-icons.css')
  for (const [kind, table] of [['tool-icon', TOOL_ICONS], ['icon', ICON_PATHS]]) {
    for (const id of Object.keys(table).sort()) for (const size of [32, 24, 16]) for (const [scheme, vars] of Object.entries(themes)) {
      const file = `${kind}s/${scheme}/${id}-${size}.svg`
      let body, cls
      if (kind === 'tool-icon') {
        if (typeof table[id][size] !== 'string') throw new Error(`Missing ${size}px drawing: ${id}`)
        body = `<style>${iconCss}</style>${table[id][size]}`
        cls = 'ti'
      } else {
        const small = size === 16 && SMALL_ICON_PATHS[id]
        const grid = small ? 16 : 24
        body = `<g transform="scale(${size / grid})" fill="none" stroke="var(--accent)" stroke-width="${small ? 1.5 : 1.75}" stroke-linecap="round" stroke-linejoin="round">${small || table[id]}</g>`
        cls = 'sx-ic'
      }
      save(file, documentSvg(id, scheme, size, size, cls, body, title(id), vars))
      assets.push({ kind, id, settingKey: null, title: title(id), theme: scheme, file, size: { width: size, height: size } })
    }
  }
  for (const [id, demo] of Object.entries(DEMOS).sort(([a], [b]) => a.localeCompare(b))) {
    // The registry's loader is the source of truth, including aliases such as holefit -> hole.
    const module = demo.stage?.toString().match(/import\(['"]\.\.\/demos\/([^'"]+)['"]\)/)?.[1]
    if (!module || !/^[\w-]+$/.test(module)) throw new Error(`Unsupported loop loader: ${id}`)
    const { loop } = await import(pathToFileURL(join(root, 'packages/app/src/demos', `${module}.ts`)).href)
    const settings = Object.entries(SETTING_DEMOS).filter(([, value]) => value === id).map(([key]) => key)
    for (const [scheme, vars] of Object.entries(themes)) {
      const file = `loops/${scheme}/${id}.svg`
      const bg = `<defs><linearGradient id="background" x2="0" y2="1"><stop offset="0" style="stop-color:var(--scene-top)"/><stop offset="1" style="stop-color:var(--scene-bottom)"/></linearGradient></defs><rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#background)"/>`
      save(file, documentSvg(id, scheme, STAGE_W, STAGE_H, 'sxs', bg + stageInner(loop), demo.label, vars))
      for (const key of settings.length ? settings : [null]) assets.push({ kind: 'loop', id, settingKey: key, title: demo.label, theme: scheme, file, size: { width: STAGE_W, height: STAGE_H } })
    }
  }
  const manifest = { schemaVersion: 1, tokens: 'tokens.css', example: 'example.html', assets }
  save('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  save('example.css', '/* Change this one stylesheet to recolor every inline icon and loop. */\n[data-sx-theme] { --accent: #009b87; }\n')
  save('example.html', example())
  return manifest
}

function example() {
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Standalone kit assets</title>
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="example.css">
<style>body{margin:0;font:16px system-ui}section{padding:24px;color:var(--fg);background:var(--ink-0)}h1,h2{margin:0 0 16px}.icons,.loops{display:flex;gap:24px;align-items:center;flex-wrap:wrap}.icons{margin-bottom:24px}.loops svg{max-width:100%;height:auto;border-radius:8px}p{max-width:65ch}</style>
<section data-sx-theme="dark"><h1>Standalone kit assets</h1><p>One stylesheet changes the accent. SVG files load inline with no app package.</p><h2>Dark</h2><div class="icons"></div><div class="loops"></div></section>
<section data-sx-theme="light"><h2>Light</h2><div class="icons"></div><div class="loops"></div></section>
<script type="module">
try {
  const manifest = await (await fetch('manifest.json')).json();
  const iconIds = [...new Set(manifest.assets.filter(a => a.kind === 'tool-icon').map(a => a.id))].slice(0, 3);
  for (const section of document.querySelectorAll('section')) {
    const theme = section.dataset.sxTheme;
    for (const [kind, ids, container] of [['tool-icon', iconIds, '.icons'], ['loop', ['push', 'sketch', 'fillet'], '.loops']]) {
      for (const id of ids) {
        const asset = manifest.assets.find(a => a.kind === kind && a.id === id && a.theme === theme && (kind === 'loop' || a.size.width === 32));
        const response = await fetch(asset.file);
        if (!response.ok) throw new Error(asset.file);
        const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
        if (parsed.querySelector('parsererror')) throw new Error('Invalid SVG: ' + asset.file);
        section.querySelector(container).append(document.importNode(parsed.documentElement, true));
      }
    }
  }
  document.body.dataset.ready = 'true';
} catch (error) { document.body.dataset.error = String(error); throw error; }
</script>
`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await exportAssets(resolve(process.argv[2] ?? 'slicerx-kit/assets'))
  console.log(`Exported ${new Set(manifest.assets.map((a) => a.file)).size} SVG files`)
}
