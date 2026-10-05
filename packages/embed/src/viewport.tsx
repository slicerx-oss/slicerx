// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// <Viewport>: @slicerx/viewport as a React component. The render loop stays in
// the viewport; props changes call its imperative setters, nothing per frame.
import type { PreviewBuffers } from '@slicerx/contracts'
import { readPreview } from '@slicerx/contracts'
import { useTheme } from '@slicerx/ui'
import { createViewport, type ColorMode, type PickEvent, type RenderMode, type ViewPreset, type Viewport as Handle, type ViewportPlate, type ViewportTheme } from '@slicerx/viewport'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { sceneFor } from './theme'

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
  /** The viewport could not start (no WebGL) or failed while drawing. Report it as a crash of the SlicerX part. */
  onError?: (error: Error) => void
  label?: string
  className?: string
  style?: CSSProperties
}

export function Viewport({ plate, preview, look = 'studio', colorMode = 'feature', layer, view, quality = 'high', onPick, onReady, sceneTheme, toolColors, onError, label = '3D view', className, style }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = useState<Handle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  const errorRef = useRef(onError)
  errorRef.current = onError
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
      handle = createViewport(canvas, { quality, label })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      setError(err.message)
      errorRef.current?.(err)
      return
    }
    const off = handle.on('pick', (e) => pickRef.current?.(e))
    const offError = handle.on('error', (e) => errorRef.current?.(new Error(e.message)))
    setVp(handle)
    readyRef.current?.(handle)
    return () => {
      off()
      offError()
      handle.dispose()
      setVp(null)
    }
  }, [quality, label])

  const buffers = preview instanceof ArrayBuffer ? readPreview(preview) : (preview ?? null)

  useEffect(() => {
    if (vp && plate) vp.setPlate(plate)
  }, [vp, plate])
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
  const tools = toolColors?.join(',')
  useEffect(() => {
    if (vp && tools) vp.setToolColors(tools.split(','))
  }, [vp, tools])
  useEffect(() => vp?.setRenderMode(look), [vp, look])
  useEffect(() => vp?.setColorMode(colorMode), [vp, colorMode])
  useEffect(() => {
    if (vp && view) vp.view(view, { animate: true })
  }, [vp, view])

  return (
    <div className={className ? `sxe-viewport ${className}` : 'sxe-viewport'} style={style}>
      <canvas ref={canvasRef} className="sxe-canvas" tabIndex={0} />
      {error ? (
        <p className="sxe-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
