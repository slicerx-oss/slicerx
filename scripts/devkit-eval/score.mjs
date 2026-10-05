// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scores one eval run from the app the agent left and its transcript. Each check is one point.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function files(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'slicerx-kit', '.git', 'dist', 'data'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) files(p, base, acc)
    else if (/\.(m?[jt]sx?|vue|svelte|json|html|css)$/.test(e.name)) acc.push({ path: p.slice(base.length + 1), text: readFileSync(p, 'utf8') })
  }
  return acc
}

/** Font family names compare without spaces or quotes, since "Fernleaf Sans" and "FernleafSans" are one choice of name to the developer. */
const sameFont = (a, b, within = false) => {
  const n = (x) => x.toLowerCase().replace(/[\s"']/g, '')
  return within ? n(a).includes(n(b)) : n(a) === n(b)
}

/** The shell commands the agent ran, from a Claude Code stream-json transcript (empty for other agents). */
function commands(transcript) {
  if (!existsSync(transcript)) return []
  const out = []
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    for (const c of ev.message?.content ?? []) if (c.type === 'tool_use' && c.name === 'Bash') out.push(String(c.input?.command ?? ''))
  }
  return out
}

const A_WORDS = /path a\b|own edition|separate (desktop )?app|your own slicer|white-?label/
const B_WORDS = /path b\b|embed|inside (the|your|an?) (app|window)/

/** The Start here question: the answer offers both a separate edition (A) and embedding (B) and asks which. */
export function askedAOrB(said) {
  const s = said.toLowerCase()
  return s.includes('?') && A_WORDS.test(s) && B_WORDS.test(s)
}

/** The reply to "I'm not sure, what do you recommend?" names Path A, the edition, before it names embedding. */
export function recommendedA(said) {
  const s = said.toLowerCase()
  const a = s.search(A_WORDS)
  const b = s.search(B_WORDS)
  return a >= 0 && (b < 0 || a < b) && !/(recommend|suggest|go with|choose|best fit)[^.\n]{0,60}(path b\b|embed)/.test(s)
}

/** Whether the host app was given a way to launch the edition: its config names a command, or any file in it names the edition. */
export function hostHooked(hostDir, want) {
  if (!existsSync(hostDir)) return false
  const cfg = join(hostDir, 'layermate.config.json')
  if (existsSync(cfg) && JSON.parse(readFileSync(cfg, 'utf8')).editionCommand) return true
  return files(hostDir).some((f) => f.path !== 'layermate.config.json' && new RegExp(`${want.id}|${want.name}`, 'i').test(f.text))
}

// npm and pnpm are .cmd shims on Windows, which spawn only finds through a shell
const WIN = process.platform === 'win32'

export function score({ app, clone, turns, transcript, persona, spawnSync }) {
  if (persona.path === 'A') return scoreEdition({ app, clone, turns, transcript, persona, spawnSync })
  const src = files(app)
  const code = src.filter((f) => /\.(m?[jt]sx?|vue|svelte)$/.test(f.path))
  const all = (re) => code.some((f) => re.test(f.text))
  const ran = commands(transcript)
  const pkg = src.find((f) => f.path === 'package.json')
  const deps = pkg ? JSON.stringify({ ...JSON.parse(pkg.text).dependencies, ...JSON.parse(pkg.text).devDependencies }) : ''
  const checks = []
  const parts = persona.expect.parts
  const check = (name, ok, note) => checks.push({ name, ok: Boolean(ok), ...(note ? { note } : {}) })

  // MCP: a project config naming the server, or the client's add command, and a check that it runs.
  const mcpConfig = src.find((f) => /(^|\/)(\.mcp|mcp|\.cursor\/mcp|\.vscode\/mcp)\.json$/.test(f.path) && /slicerx/.test(f.text) && /cli\.js|@slicerx\/mcp/.test(f.text))
  const mcpAdd = ran.find((c) => /mcp add(-json)?\s+.*slicerx/.test(c))
  check('connected the SlicerX MCP server for itself', mcpConfig || mcpAdd, mcpConfig?.path ?? mcpAdd?.slice(0, 120))
  check('checked the server runs', ran.some((c) => /@slicerx\/mcp\/dist\/cli\.js.*(--version|-v\b)|slicerx-mcp.*--version/.test(c)))

  // Interview: the first answer asks about parts, stack and brand, and no app code exists yet.
  const first = (turns[0]?.said ?? '').toLowerCase()
  const asked = ['viewport', 'slic', 'react', 'brand', 'color', 'font', 'printer', 'mimir', 'theme'].filter((w) => first.includes(w))
  const codeAfterFirst = (turns[0]?.files ?? []).filter((f) => /\.(m?[jt]sx?|vue|svelte)$/.test(f) && !/config\./.test(f))
  check('interviewed before writing code', first.includes('?') && asked.length >= 4 && codeAfterFirst.length === 0, `asked about ${asked.join(', ')}; code files after turn 1: ${codeAfterFirst.length}`)

  // The parts asked for, wired the way the kit says.
  const wants = [...(parts.some((p) => ['viewport', 'settings', 'locked'].includes(p)) ? ['@slicerx/embed'] : []), ...(parts.includes('slicing') ? ['@slicerx/mcp'] : [])]
  if (wants.length) check(`installed ${wants.join(' and ')} from the kit`, wants.every((w) => deps.includes(w)), deps.slice(0, 200))
  const fromEmbed = all(/from ['"]@slicerx\/embed['"]/)
  if (parts.includes('viewport')) check('viewport from @slicerx/embed', fromEmbed && all(/<Viewport\b|sx-viewport/))
  if (parts.includes('settings')) check('settings panel from @slicerx/embed', fromEmbed && all(/<SettingsPanel\b|sx-settings-panel/))
  if (parts.includes('locked')) check('locked projects with @slicerx/embed/sxlock or the sxlock tools', all(/@slicerx\/embed\/sxlock|slicerx_sxlock_open/) && all(/SxlockError|sxlock_/))
  if (parts.includes('slicing')) {
    // Slicing goes through the server from Node code; the browser bundle never starts it.
    const nodeSide = code.filter((f) => /from ['"]node:|require\(['"]node:|from ['"](express|electron|fastify|hono)['"]/.test(f.text))
    const starts = nodeSide.find((f) => /StdioClientTransport/.test(f.text) && /@slicerx\/mcp/.test(f.text))
    const slices = nodeSide.find((f) => /slicerx_slice_file/.test(f.text))
    const inBrowser = code.find((f) => !nodeSide.includes(f) && /StdioClientTransport|@slicerx\/mcp\/cli/.test(f.text))
    check('slices over MCP from a server process', starts && slices && !inBrowser, [starts?.path, slices?.path, inBrowser ? `browser: ${inBrowser.path}` : ''].filter(Boolean).join(', '))
  }
  const unasked = [
    ['printers', /slicerx_printer_queue/],
    ['locked', /sealSxlock|openSxlock|slicerx_sxlock_/],
    ['viewport', /<Viewport\b|sx-viewport/],
  ].filter(([p, re]) => !parts.includes(p) && all(re))
  check('no parts the developer did not ask for', unasked.length === 0, unasked.map(([p]) => p).join(', '))

  // Agreement and theme.
  check('shows the pre-alpha agreement', all(/<Agreement\b|sx-agreement/) && all(/agreementNeeded|readAgreement/))
  const accent = persona.expect.accent.toLowerCase()
  check('themed with the brand', all(/createTheme\(/) && code.some((f) => f.text.toLowerCase().includes(accent)) && all(/<EmbedTheme\b|\.theme\s*=|:theme\.prop=|\.theme=/))

  // Rules.
  check('kept the rules (no approvals, no tokens in code)', !all(/slicerx_approve/) && !src.some((f) => /sxk_[A-Za-z0-9]{8,}/.test(f.text)))

  // The app builds.
  let build = { status: 1, stdout: '', stderr: 'no package.json' }
  if (pkg) {
    if (!existsSync(join(app, 'node_modules'))) spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: app, encoding: 'utf8', shell: WIN })
    build = spawnSync('npm', ['run', 'build'], { cwd: app, encoding: 'utf8', timeout: 10 * 60_000, shell: WIN })
  }
  check('npm run build passes', build.status === 0, build.status === 0 ? undefined : `${build.stdout}${build.stderr}`.split('\n').filter((l) => /error/i.test(l)).slice(0, 3).join(' | '))

  return { points: checks.filter((c) => c.ok).length, max: checks.length, checks, cost_usd: turns.reduce((n, t) => n + (t.cost_usd ?? 0), 0) }
}

/**
 * Path A: the agent makes an edition in the clone. Points for interviewing first, saying the edition is a
 * separate app, a config that passes the checker and carries the brand, a build that succeeds, and a built
 * app that opens under the brand with no SlicerX in sight besides the credit.
 */
function scoreEdition({ app, clone, turns, transcript, persona, spawnSync }) {
  const want = persona.expect
  const checks = []
  const check = (name, ok, note) => checks.push({ name, ok: Boolean(ok), ...(note ? { note } : {}) })
  const ran = commands(transcript)
  const said = turns.map((t) => t.said.toLowerCase()).join('\n')
  const node = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: clone, encoding: 'utf8', timeout: 10 * 60_000, ...opts })

  const first = (turns[0]?.said ?? '').toLowerCase()
  // a persona with a host app is asked Path A or B first and says "I'm not sure" (turn 2), so the config may not exist until turn 3
  const early = (turns[persona.host ? 1 : 0]?.files ?? []).filter((f) => /edition\.config\./.test(f))
  check('interviewed before writing the config', first.includes('?') && early.length === 0, early.join(', '))
  if (persona.host) {
    check('asked Path A or B before writing anything', askedAOrB(turns[0]?.said ?? '') && !(turns[0]?.files ?? []).some((f) => /edition\.config\./.test(f)))
    check('recommended Path A (an edition) for a desktop app', recommendedA(turns[1]?.said ?? ''), (turns[1]?.said ?? '').slice(0, 160))
  }
  check('said the edition is a separate app the host app launches', /separate (desktop )?app|its own app|own installer|launch(es)? (it|the slicer)/.test(said))

  const config = join(clone, 'editions', want.id, 'edition.config.ts')
  const cli = join(clone, 'packages', 'edition-config', 'src', 'cli.ts')
  const checked = existsSync(config) ? node([cli, 'check', config]) : { status: 1, stdout: '', stderr: `no ${config}` }
  check('edition config passes the checker with no font warnings', checked.status === 0 && !/warning: font/.test(checked.stderr), `${checked.stderr}`.trim().slice(0, 300))

  let c = null
  if (checked.status === 0) c = JSON.parse(node([cli, 'resolve', config]).stdout)
  const tokens = c?.brand.theme?.tokens ?? {}
  const brandOk = c && c.brand.name === want.name && c.apps.desktop.identifier === want.identifier && tokens.colors?.purple?.toLowerCase() === want.accent && (tokens.fontFiles ?? []).some((f) => sameFont(f.family, want.font)) && c.legal.sourceUrl && !c.features.store && c.features.pilot && c.ai.provider === 'openai-compatible'
  check('config carries the brand, the bundled font and a local model', brandOk, c ? `${c.brand.name}, ${c.apps.desktop.identifier}, accent ${tokens.colors?.purple}, ai ${c.ai.provider}` : undefined)

  // the build: the desktop config names the product, and the browser app builds from the edition
  const env = { ...process.env, SLICERX_CONFIG: config }
  const tauri = checked.status === 0 ? node([cli, 'tauri', config, 'desktop']) : null
  const product = tauri?.status === 0 ? JSON.parse(tauri.stdout).productName : null
  const vite = checked.status === 0 ? spawnSync('pnpm', ['--filter', '@slicerx/web', 'exec', 'vite', 'build'], { cwd: clone, env, encoding: 'utf8', timeout: 20 * 60_000, shell: process.platform === 'win32' }) : null
  check('the edition builds (desktop config and browser app)', product === want.name && vite?.status === 0, [product && `product ${product}`, vite && vite.status !== 0 ? `${vite.stdout}${vite.stderr}`.split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ') : ''].filter(Boolean).join('; '))
  check('ran the documented build', ran.some((r) => /edition:build|build:app|build:wasm/.test(r)))

  // the built app opens under the brand
  let shown = null
  if (vite?.status === 0) {
    const r = node([join(import.meta.dirname, 'launch.mjs'), clone], { timeout: 3 * 60_000 })
    shown = r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') : { ok: false, error: r.stderr.slice(0, 300) }
  }
  const leaks = shown?.text ? shown.text.replace(/Made possible by SlicerX/g, '').match(/SlicerX/g)?.length ?? 0 : null
  const branded = shown?.ok && shown.title.includes(want.name) && shown.accent.toLowerCase() === want.accent && sameFont(shown.font, want.font, true) && leaks === 0 && !shown.errors.length
  check('the app opens branded (title, accent, font, no SlicerX but the credit)', branded, shown ? (shown.ok ? `title ${shown.title}, accent ${shown.accent}, font ${shown.font.split(',')[0]}, SlicerX ${leaks}, errors ${shown.errors.length}` : shown.error) : undefined)

  if (persona.host) check('hooked the host app up to open a model in the edition', hostHooked(join(app, persona.host), want))
  check('kept the rules (nothing pushed, no secrets in the config)', !ran.some((r) => /git\s+push/.test(r)) && !(existsSync(config) && /sxk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{16,}/.test(readFileSync(config, 'utf8'))))

  return { points: checks.filter((x) => x.ok).length, max: checks.length, checks, cost_usd: turns.reduce((n, t) => n + (t.cost_usd ?? 0), 0) }
}
