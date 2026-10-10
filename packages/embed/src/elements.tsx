// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// <sx-viewport>, <sx-settings-panel> and <sx-agreement> for pages without React. Each renders
// the React piece into its own shadow root with the embed styles.
import type { PrintConfig } from '@slicerx/contracts'
import type { Theme } from '@slicerx/ui'
import type { BedOutline, ColorMode, PlateStyle, RenderMode, ToolpathFinish, ViewPreset, Viewport as Handle, ViewportPlate, ViewportTheme } from '@slicerx/viewport'
import { createRoot, type Root } from 'react-dom/client'
import { Agreement } from './agreement'
import { decodeQuantized, decodeStl } from './mesh'
import { SettingsPanel, type SettingsChange } from './settings-panel'
import { EMBED_CSS } from './styles'
import { EmbedTheme } from './theme'
import { EMBED_ACTIONS, type EmbedAction, type EmbedTool } from './tools'
import { Viewport } from './viewport'

// Server rendering (Next.js and the like) imports this module where HTMLElement does not exist.
const Base: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

/** The theme of an element: its `theme` property (a full theme) wins over the `theme` attribute (dark or light). */
function themeOf(el: HTMLElement, own: Theme | null): Theme | 'dark' | 'light' {
  if (own) return own
  return el.getAttribute('theme') === 'light' ? 'light' : 'dark'
}

const LOOKS: readonly string[] = ['studio', 'clay', 'xray', 'overhang', 'filament', 'cad']
const COLORS: readonly string[] = ['feature', 'tool', 'speed', 'flow', 'layerTime']
const VIEWS: readonly string[] = ['iso', 'top', 'front', 'fit']
const FINISHES: readonly string[] = ['matte', 'satin', 'glossy', 'silk'] satisfies ToolpathFinish[]
const PLATE_STYLES: readonly string[] = ['grid', 'textured-pei', 'smooth-pei', 'cool', 'engineering'] satisfies PlateStyle[]
const TOOLS: readonly string[] = ['select', 'move', 'rotate', 'scale'] satisfies EmbedTool[]

/** The tools attribute: present (empty or "true") for every tool, or a list such as "move rotate arrange". */
export function toolsAttr(value: string | null): boolean | EmbedAction[] {
  if (value === null || value === 'false') return false
  const list = value.split(/[\s,]+/).filter((a): a is EmbedAction => (EMBED_ACTIONS as readonly string[]).includes(a))
  return list.length ? list : value.trim() === '' || value === 'true'
}

function shadow(host: HTMLElement): { root: Root; mount: HTMLElement } {
  const sr = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `${EMBED_CSS}\n:host { display: block; }\n.sx-theme-scope, .sxe-viewport { height: 100%; }`
  const mount = document.createElement('div')
  mount.style.height = '100%'
  sr.append(style, mount)
  return { root: createRoot(mount), mount }
}

/** Loads a model URL (STL, or the quantized JSON of the SlicerX samples) into a one-object plate. */
async function plateFrom(url: string): Promise<ViewportPlate> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const name = url.split('/').pop() ?? 'model'
  const model = /\.json($|\?)/i.test(url) ? decodeQuantized(await res.json()) : decodeStl(await res.arrayBuffer(), name)
  const bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
  return {
    bed,
    objects: [
      {
        id: 'model',
        name: model.name,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, bed.widthMm / 2, bed.depthMm / 2, 0, 1],
        parts: model.parts.map((p, i) => ({ name: p.name, positions: p.positions, indices: p.indices, color: model.colors[i] ?? model.colors[0] ?? '#ebebe6' })),
      },
    ],
  }
}

class SxViewportElement extends Base {
  static observedAttributes = ['src', 'look', 'color-mode', 'view', 'layer', 'theme', 'finish', 'plate-style', 'tools', 'tool', 'reveal', 'bed-outline']
  #root: Root | null = null
  #vp: Handle | null = null
  #selection: string[] | undefined
  #plate: ViewportPlate | null = null
  #preview: ArrayBuffer | null = null
  #theme: Theme | null = null
  #sceneTheme: ViewportTheme | undefined
  #toolColors: string[] | undefined
  #src = ''

  /** Filament color per slot (#rrggbb, slot 1 first), for color-mode "tool". */
  get toolColors(): string[] | undefined {
    return this.#toolColors
  }
  set toolColors(c: string[] | undefined) {
    this.#toolColors = c
    this.#render()
  }

  /** A full theme from createTheme; overrides the theme attribute. */
  get theme(): Theme | null {
    return this.#theme
  }
  set theme(t: Theme | null) {
    this.#theme = t
    this.#render()
  }
  /** Colors of the 3D scene, over the ones that follow the theme. */
  get sceneTheme(): ViewportTheme | undefined {
    return this.#sceneTheme
  }
  set sceneTheme(t: ViewportTheme | undefined) {
    this.#sceneTheme = t
    this.#render()
  }

  get plate(): ViewportPlate | null {
    return this.#plate
  }
  set plate(p: ViewportPlate | null) {
    this.#plate = p
    this.#render()
  }
  get preview(): ArrayBuffer | null {
    return this.#preview
  }
  set preview(b: ArrayBuffer | null) {
    this.#preview = b
    this.#render()
  }

  /** Selected object ids. Unset, the view keeps its own selection; a `select` event reports each change. */
  get selection(): string[] | undefined {
    return this.#selection
  }
  set selection(ids: string[] | undefined) {
    this.#selection = ids
    this.#render()
  }

  /** Plays the plate reveal again, for a plate the host calls new. False when this view does not play it. */
  playReveal(): boolean {
    return this.#vp?.playReveal() ?? false
  }
  /** Spreads every model out on the plate; `transform` events follow. */
  arrange(): void {
    this.#vp?.arrange({ animate: true })
  }
  /** Sets models down on the bed: these ids, or every model. `transform` events follow. */
  dropToBed(ids?: string[]): void {
    this.#vp?.dropToBed?.(ids)
  }

  connectedCallback(): void {
    this.#root ??= shadow(this).root
    this.#render()
  }

  disconnectedCallback(): void {
    this.#root?.unmount()
    this.#root = null
    this.#vp = null
  }

  attributeChangedCallback(name: string): void {
    if (name === 'src') void this.#load()
    else this.#render()
  }

  async #load(): Promise<void> {
    const src = this.getAttribute('src') ?? ''
    if (!src || src === this.#src) return
    this.#src = src
    try {
      this.plate = await plateFrom(new URL(src, document.baseURI).href)
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', { detail: e instanceof Error ? e.message : String(e) }))
    }
  }

  #render(): void {
    if (!this.#root) return
    const look = this.getAttribute('look') ?? 'studio'
    const color = this.getAttribute('color-mode') ?? 'feature'
    const view = this.getAttribute('view')
    const layer = Number(this.getAttribute('layer'))
    // finish="silk" for every slot, or one per slot: finish="satin silk matte".
    const finishes = (this.getAttribute('finish') ?? '').split(/[\s,]+/).filter((f): f is ToolpathFinish => FINISHES.includes(f))
    const plateStyle = this.getAttribute('plate-style') ?? ''
    const tool = this.getAttribute('tool') ?? ''
    const reveal = this.getAttribute('reveal')
    this.#root.render(
      <EmbedTheme theme={themeOf(this, this.#theme)}>
      <Viewport
        plate={this.#plate}
        preview={this.#preview}
        look={(LOOKS.includes(look) ? look : 'studio') as RenderMode}
        colorMode={(COLORS.includes(color) ? color : 'feature') as ColorMode}
        {...(view && VIEWS.includes(view) ? { view: view as ViewPreset } : {})}
        {...(layer > 0 ? { layer } : {})}
        label={this.getAttribute('aria-label') ?? '3D view'}
        {...(this.#sceneTheme ? { sceneTheme: this.#sceneTheme } : {})}
        {...(this.#toolColors ? { toolColors: this.#toolColors } : {})}
        {...(finishes.length ? { toolFinishes: finishes } : {})}
        {...(PLATE_STYLES.includes(plateStyle) ? { plateStyle: plateStyle as PlateStyle } : {})}
        tools={toolsAttr(this.getAttribute('tools'))}
        {...(TOOLS.includes(tool) ? { tool: tool as EmbedTool } : {})}
        reveal={reveal === 'each-plate' ? 'each-plate' : reveal !== 'off' && reveal !== 'false'}
        bedOutline={(this.getAttribute('bed-outline') === 'subtle' ? 'subtle' : 'default') as BedOutline}
        {...(this.#selection ? { selection: this.#selection } : {})}
        onReady={(vp) => (this.#vp = vp)}
        onToolChange={(t) => {
          // a tool attribute follows the toolbar, so the page reads the tool in use from it
          if (this.hasAttribute('tool')) this.setAttribute('tool', t)
          this.dispatchEvent(new CustomEvent('tool', { detail: t }))
        }}
        onSelect={(ids) => this.dispatchEvent(new CustomEvent('select', { detail: ids }))}
        onTransform={(e) => this.dispatchEvent(new CustomEvent('transform', { detail: e }))}
        onPick={(e) => this.dispatchEvent(new CustomEvent('pick', { detail: e }))}
        onError={(e) => this.dispatchEvent(new CustomEvent('error', { detail: e.message }))}
      />
      </EmbedTheme>,
    )
  }
}

class SxSettingsPanelElement extends Base {
  static observedAttributes = ['mode', 'theme']
  #root: Root | null = null
  #config: PrintConfig | undefined
  #theme: Theme | null = null

  /** A full theme from createTheme; overrides the theme attribute. */
  get theme(): Theme | null {
    return this.#theme
  }
  set theme(t: Theme | null) {
    this.#theme = t
    this.#render()
  }

  set config(c: PrintConfig | undefined) {
    this.#config = c
    this.#render()
  }

  connectedCallback(): void {
    this.#root ??= shadow(this).root
    this.#render()
  }

  disconnectedCallback(): void {
    this.#root?.unmount()
    this.#root = null
  }

  attributeChangedCallback(): void {
    this.#render()
  }

  #render(): void {
    this.#root?.render(
      <EmbedTheme theme={themeOf(this, this.#theme)}>
      <SettingsPanel
        mode={this.getAttribute('mode') === 'advanced' ? 'advanced' : 'easy'}
        {...(this.#config ? { config: this.#config } : {})}
        onChange={(detail: SettingsChange) => this.dispatchEvent(new CustomEvent('change', { detail }))}
      />
      </EmbedTheme>,
    )
  }
}

/** The pre-alpha agreement. Attribute `app-name`; property `theme`; an `accept` event with the record. */
class SxAgreementElement extends Base {
  static observedAttributes = ['app-name', 'theme']
  #root: Root | null = null
  #theme: Theme | null = null

  get theme(): Theme | null {
    return this.#theme
  }
  set theme(t: Theme | null) {
    this.#theme = t
    this.#render()
  }

  connectedCallback(): void {
    this.#root ??= shadow(this).root
    this.#render()
  }

  disconnectedCallback(): void {
    this.#root?.unmount()
    this.#root = null
  }

  attributeChangedCallback(): void {
    this.#render()
  }

  #render(): void {
    this.#root?.render(
      <EmbedTheme theme={themeOf(this, this.#theme)}>
        <Agreement appName={this.getAttribute('app-name') ?? 'this app'} onAccept={(record) => this.dispatchEvent(new CustomEvent('accept', { detail: record }))} />
      </EmbedTheme>,
    )
  }
}

/** Registers <sx-viewport>, <sx-settings-panel> and <sx-agreement>. Safe to call more than once. */
export function defineSlicerXElements(): void {
  if (!customElements.get('sx-viewport')) customElements.define('sx-viewport', SxViewportElement)
  if (!customElements.get('sx-settings-panel')) customElements.define('sx-settings-panel', SxSettingsPanelElement)
  if (!customElements.get('sx-agreement')) customElements.define('sx-agreement', SxAgreementElement)
}
