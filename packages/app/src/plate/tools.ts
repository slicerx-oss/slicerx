// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The active plate tool and a handle on the running viewport, so toolbar buttons, keys and
// commands can reach camera calls without a React path to the canvas.
import type { Guides, PaintSettings, PickEvent, Viewport } from '@slicerx/viewport'
import { createStore, useStore } from 'zustand'

/** `probe` belongs to the modeling tools: clicks report what is under the cursor and nothing is selected or moved. */
export type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'face' | 'paint' | 'brim' | 'probe'

/** `rotateSpace`: the rotate rings turn about the bed's axes (`world`) or the object's own (`local`). */
export const toolStore = createStore<{ tool: Tool; rotateSpace: 'world' | 'local' }>()(() => ({ tool: 'move', rotateSpace: 'world' }))

export function useTool(): Tool {
  return useStore(toolStore, (s) => s.tool)
}

export function setTool(tool: Tool): void {
  toolStore.setState({ tool })
}

export function useRotateSpace(): 'world' | 'local' {
  return useStore(toolStore, (s) => s.rotateSpace)
}

export function setRotateSpace(rotateSpace: 'world' | 'local'): void {
  toolStore.setState({ rotateSpace })
}

/** Viewport calls the app drives directly. Optional: the 2D fallback has none of them. */
export interface CameraBus {
  view?(preset: 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'fit' | 'bed', opts?: { animate?: boolean }): void
  zoomToSelection?(opts?: { animate?: boolean }): void
  zoomToBed?(opts?: { animate?: boolean }): void
  /** Moves the camera closer by `factor` (below 1 moves away), keeping the angle. */
  zoomBy?(factor: number, opts?: { animate?: boolean }): void
  focusBedPoint?(x: number, y: number, z: number, opts?: { animate?: boolean }): void
  toggleProjection?(): unknown
  arrange?(opts?: { animate?: boolean; gapMm?: number }): Record<string, number[]>
  /** Modeling guides (lines, outlines, end points) in bed coordinates. */
  guides?(guides: Guides): void
  /** Highlight flat faces under the cursor while the probe tool is on. */
  probeFaces?(on: boolean): void
  /** The modeling layer: push and pull, sketches, kept dimensions. */
  cad?: CadView
}

/** The parts of the 3D view the modeling tools drive directly. */
export type CadView = Pick<Viewport, 'setPush' | 'setSketch' | 'setSketchCursor' | 'lookAtPlane' | 'setDimensions' | 'setProbeHover' | 'setEdgePreview' | 'on'>

let camera: CameraBus | null = null

export function setCameraBus(bus: CameraBus | null): void {
  camera = bus
}

export function cameraBus(): CameraBus | null {
  return camera
}

/** The viewport's paint brush, reached from the panel. Null while there is no GPU viewport. */
export interface PaintBus {
  set(settings: Partial<PaintSettings>): void
  get(): PaintSettings | undefined
}

let paintBus: PaintBus | null = null
const paintListeners = new Set<() => void>()

export function setPaintBus(bus: PaintBus | null): void {
  paintBus = bus
  paintBusChanged()
}

export function getPaintBus(): PaintBus | null {
  return paintBus
}

/** The brush settings changed (the wheel, or a call from the panel). */
export function paintBusChanged(): void {
  for (const l of paintListeners) l()
}

export function subscribePaintBus(cb: () => void): () => void {
  paintListeners.add(cb)
  return () => paintListeners.delete(cb)
}

/** Who hears clicks while the probe tool is on (measure, the shape tools). */
let probe: ((hit: PickEvent) => void) | null = null

export function setProbeHandler(fn: ((hit: PickEvent) => void) | null): void {
  probe = fn
}

export function probeHandler(): ((hit: PickEvent) => void) | null {
  return probe
}
