// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// <Viewport>: @slicerx/viewport as a React component. The render loop stays in
// the viewport; props changes call its imperative setters, nothing per frame.
// With `tools` it is a Prepare step too: select, move, rotate, scale, arrange
// and drop to bed, from a toolbar over the view or the keys M, R, S and A.
import type { PreviewBuffers } from '@slicerx/contracts'
import { readPreview } from '@slicerx/contracts'
import { useTheme } from '@slicerx/ui'
import { createViewport, type BedOutline, type ColorMode, type PickEvent, type PlateStyle, type RenderMode, type ToolpathFinish, type TransformEvent, type ViewPreset, type Viewport as Handle, type ViewportPlate, type ViewportTheme } from '@slicerx/viewport'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { sceneFor } from './theme'
import { EMBED_ACTIONS, PrepareTools, toolKey, type EmbedAction, type EmbedTool } from './tools'

export interface ViewportProps {
  plate?: ViewportPlate | null
  /** SXPV bytes or parsed buffers; switches the view to toolpaths. */
  preview?: ArrayBuffer | PreviewBuffers | null
  /** Prepare look for the plate. */
  look?: RenderMode
  colorMode?: ColorMode
  /** Top visible layer, 1-based; default all. */
  layer?: number
  view?: ViewPreset
  quality?: 'high' | 'balanced' | 'low'
  onPick?: (e: PickEvent) => void
  /** The live handle, for anything the props do not cover. */
  onReady?: (viewport: Handle) => void
  /**
   * Colors of the 3D scene, toolpaths and heat ramp. Merged over the scene that follows the
   * surrounding EmbedTheme (its accent, and a light studio for a light theme).
   */
  sceneTheme?: ViewportTheme
  /** Filament color per slot (#rrggbb, slot 1 first), for colorMode "tool" and the plate's parts. */
  toolColors?: readonly string[]
  /**
   * How each slot's toolpaths shine (slot 1 first): matte, satin (everyday PLA, the default), glossy (PETG and the
   * like) or silk, which streaks along each bead. One value for every slot is a list of one.
   */
  toolFinishes?: readonly ToolpathFinish[]
  /** The bed under the print: `grid` (the default) or a build plate surface: textured-pei, smooth-pei, cool, engineering. */
  plateStyle?: PlateStyle
  /** The viewport could not start (no WebGL) or failed while drawing. Report it as a crash of the SlicerX part. */
  onError?: (error: Error) => void
  /**
   * The plate reveal: the outline traced and the grid laid, about 2 s. `true` (the default) plays it on the first
   * plate, `each-plate` on every new plate (another set of objects), `false` never. Reduced motion and software
   * graphics draw the plate at once.
   */
  reveal?: boolean | 'each-plate'
  /** The bed outline: `default`, a crisp glowing line, or `subtle`, thin and half strength for a calm theme. */
  bedOutline?: BedOutline
  /**
   * Prepare tools over the view: `true` for all of them, or a list of `select`, `move`, `rotate`, `scale`, `arrange`
   * and `drop`. Off by default; the view still selects on a click.
   */
  tools?: boolean | readonly EmbedAction[]
  /** The active tool. Without it the view keeps its own, `move` with tools shown and `select` without. */
  tool?: EmbedTool
  onToolChange?: (tool: EmbedTool) => void
  /** Selected object ids. Without it the view keeps its own selection. */
  selection?: readonly string[]
  onSelect?: (ids: string[]) => void
  /**
   * An object moved, turned, scaled, arranged or dropped to the bed. `final` is true on release and when an arrange
   * ends: store the transform in your plate then, so the next `plate` you pass keeps it.
   */
  onTransform?: (e: TransformEvent) => void
  label?: string
  className?: string
  style?: CSSProperties
}

/** Ids of a plate's objects: a new key is a new plate, for `reveal: 'each-plate'`. */
export function plateKey(plate: ViewportPlate | null | undefined): string {
  return plate ? plate.objects.map((o) => o.id).join('\n') : ''
}

export function Viewport({ plate, preview, look = 'studio', colorMode = 'feature', layer, view, quality = 'high', onPick, onReady, sceneTheme, toolColors, toolFinishes, plateStyle = 'grid', onError, reveal = true, bedOutline = 'default', tools, tool, onToolChange, selection, onSelect, onTransform, label = '3D view', className, style }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = useState<Handle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  const errorRef = useRef(onError)
  errorRef.current = onError
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const transformRef = useRef(onTransform)
  transformRef.current = onTransform
  const actions = tools === true ? EMBED_ACTIONS : tools ? EMBED_ACTIONS.filter((a) => tools.includes(a)) : []
  const [ownTool, setOwnTool] = useState<EmbedTool | null>(null)
  const active: EmbedTool = tool ?? ownTool ?? (actions.length ? 'move' : 'select')
  const pickTool = (t: EmbedTool) => {
    if (tool === undefined) setOwnTool(t)
    onToolChange?.(t)
  }
  const [picked, setPicked] = useState<readonly string[]>([])
  const selected = selection ?? picked
  const { theme } = useTheme()
  const scene = useMemo(() => {
    const auto = sceneFor(theme)
    if (!sceneTheme) return auto
    return { ...auto, ...sceneTheme, scene: { ...auto?.scene, ...sceneTheme.scene } }
  }, [theme, sceneTheme])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let handle: Handle
    try {
      handle = createViewport(canvas, { quality, label, reveal: reveal !== false })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      setError(err.message)
      errorRef.current?.(err)
      return
    }
    const off = handle.on('pick', (e) => pickRef.current?.(e))
    const offError = handle.on('error', (e) => errorRef.current?.(new Error(e.message)))
    const offSelect = handle.on('select', (e) => {
      setPicked(e.ids)
      selectRef.current?.(e.ids)
    })
    const offTransform = handle.on('transform', (e) => transformRef.current?.(e))
    setVp(handle)
    readyRef.current?.(handle)
    return () => {
      off()
      offError()
      offSelect()
      offTransform()
      handle.dispose()
      setVp(null)
    }
    // reveal is read once, at the start: the viewport decides then whether it may play
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality, label])

  const buffers = preview instanceof ArrayBuffer ? readPreview(preview) : (preview ?? null)

  useEffect(() => {
    if (vp && plate) vp.setPlate(plate)
  }, [vp, plate])
  // each new plate (another set of objects, not the same objects moved) plays the reveal again
  const key = plateKey(plate)
  useEffect(() => {
    if (vp && key && reveal === 'each-plate') vp.playReveal()
  }, [vp, key, reveal])
  const sel = selection?.join('\n')
  useEffect(() => {
    if (vp && sel !== undefined) vp.setSelection(sel ? sel.split('\n') : [])
  }, [vp, sel])
  useEffect(() => vp?.setTool(active), [vp, active])
  useEffect(() => vp?.setBedOutline?.(bedOutline), [vp, bedOutline])
  useEffect(() => {
    if (!vp) return
    vp.setPreview(buffers)
    vp.setMode(buffers ? 'preview' : 'prepare')
    // buffers is derived from preview; the identity of preview is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, preview])
  useEffect(() => {
    if (vp && buffers) vp.setLayerRange(0, Math.max(0, Math.min(layer ?? buffers.layerCount, buffers.layerCount) - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, preview, layer])
  useEffect(() => vp?.setTheme(scene), [vp, scene])
  const slots = toolColors?.join(',')
  useEffect(() => {
    if (vp && slots) vp.setToolColors(slots.split(','))
  }, [vp, slots])
  const finishes = toolFinishes?.join(',')
  useEffect(() => {
    if (vp && finishes) vp.setToolFinishes?.(finishes.split(',') as ToolpathFinish[])
  }, [vp, finishes])
  useEffect(() => vp?.setPlateStyle?.(plateStyle), [vp, plateStyle])
  useEffect(() => vp?.setRenderMode(look), [vp, look])
  useEffect(() => vp?.setColorMode(colorMode), [vp, colorMode])
  useEffect(() => {
    if (vp && view) vp.view(view, { animate: true })
  }, [vp, view])

  const run = (a: EmbedAction) => {
    if (!vp) return
    if (a === 'arrange') vp.arrange({ animate: true })
    else if (a === 'drop') vp.dropToBed?.(selected.length ? selected : undefined)
    else pickTool(a)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const a = actions.find((x) => toolKey(x) === e.key.toUpperCase())
    if (!a) return
    e.preventDefault()
    run(a)
  }

  return (
    <div className={className ? `sxe-viewport ${className}` : 'sxe-viewport'} style={style} onKeyDown={actions.length ? onKey : undefined}>
      <canvas ref={canvasRef} className="sxe-canvas" tabIndex={0} />
      {actions.length && vp ? <PrepareTools actions={actions} tool={active} onAction={run} /> : null}
      {error ? (
        <p className="sxe-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
