// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A modeling tool still open when Design closes waits here with its fields, and opens again as it was when Design
// does. A history step being edited ends first, so the part is whole again before Slice can show or slice it; the
// edit comes back with the tool. Memory only: not saved, not in undo, dropped on discard, when its object goes,
// or when another tool or step opens instead.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { appStore, get, isCadTool, set, toast, type AppState, type CadTool, type Parked } from '../state/store'
import { opensDesign, SHELF_TOOLS, toolLabel } from '../workspaces/design/shelf-tools'
import { beginEdit, cancelEdit, nowOf, viewStep } from './history/ops'

type Loader = Parameters<typeof beginEdit>[0]
/** From the part's world when it was parked into its world now. */
export type Now = ReturnType<typeof nowOf>

interface Handback {
  tool: CadTool
  fields: Record<string, unknown>
  /** The part moved in Slice: world picks move with it. */
  now: Now | null
  /** The part got a new mesh in Slice: world picks are dropped. */
  remade: boolean
}

// The open tool's fields as they are, by name, and the object it works on.
const live = new Map<string, unknown>()
const OBJECT = ' object'
// Fields on their way back into the tool that is opening.
let handback: Handback | null = null

const inDesign = (s: Pick<AppState, 'workspace' | 'modelMode'>) => s.workspace === 'prepare' && s.modelMode === 'design'

/**
 * useState for a tool field that survives a trip out of Design. `world`: the field holds picks in world
 * coordinates; when the part moved (`now`) or got a new mesh (`remade`) in the meantime, it gives the field
 * as it is now, or undefined to start the field over.
 */
export function useDraft<T>(name: string, init: T | (() => T), world?: (v: T, now: Now | null, remade: boolean) => T | undefined): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const h = handback?.tool === get().objectTool ? handback : null
    let v: T | undefined
    if (h && name in h.fields) {
      v = h.fields[name] as T
      if (world && (h.now || h.remade)) v = world(v, h.now, h.remade)
    }
    return v !== undefined ? v : typeof init === 'function' ? (init as () => T)() : init
  })
  useEffect(() => {
    live.set(name, value)
  }, [name, value])
  useEffect(() => {
    // Every field of the tool read its value back in this render.
    handback = null
    return () => void live.delete(name)
  }, [name])
  return [value, setValue]
}

/** For a pick on the part: carried to where the part is now, and dropped when the part got a new mesh. */
export const follow =
  <T>(move: (v: T, now: Now) => T) =>
  (v: T, now: Now | null, remade: boolean): T | undefined =>
    remade ? undefined : now ? move(v, now) : v

/** The object the open tool works on: its draft goes when the object does. */
export function useDraftObject(objectId: string | null | undefined): void {
  useEffect(() => {
    live.set(OBJECT, objectId ?? null)
    return () => void live.delete(OBJECT)
  }, [objectId])
}

/** Whether this tool opened again with parked fields; call it next to the fields. */
export function useRestored(): boolean {
  return useState(() => handback !== null && handback.tool === get().objectTool)[0]
}

/** Parks the open modeling tool and ends a history step's rollback. Called as Design closes. */
export function park(): void {
  const s = get()
  const ed = s.historyEdit
  // Named values apply as they are typed, so their panel has nothing to keep.
  const tool = isCadTool(s.objectTool) && opensDesign(s.objectTool) && s.objectTool !== 'values' ? s.objectTool : null
  // Measure and Array keep nothing worth parking, and their probe would keep Slice from showing the toolpaths.
  const closes = s.objectTool === 'measure' || s.objectTool === 'array'
  if (!tool && !ed) return void (closes && set({ objectTool: null }))
  const step = ed?.original.history?.steps[ed.index]
  const objectId = ed?.objectId ?? (live.get(OBJECT) as string | null | undefined) ?? null
  const fields = tool ? Object.fromEntries([...live].filter(([k]) => k !== OBJECT)) : {}
  cancelEdit()
  const e = objectId ? get().plate.find((p) => p.id === objectId) : undefined
  const icon = SHELF_TOOLS.find((x) => x.tool === tool)?.icon
  const parked: Parked = {
    tool,
    ...(tool ? { label: toolLabel(tool), ...(icon ? { icon } : {}) } : {}),
    objectId,
    fields,
    ...(ed && step ? { historyEdit: { stepId: step.id, ...(ed.view ? { view: true } : {}) } } : {}),
    ...(e ? { basis: { transform: [...e.transform], parts: e.parts } } : {}),
  }
  set({ parked, ...(tool || closes ? { objectTool: null } : {}) })
}

const sameMatrix = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-9)

/** Opens the parked tool again, with its fields and its history step. Called as Design opens. */
export async function resume(host: Loader): Promise<void> {
  const s = get()
  const p = s.parked
  if (!p || !inDesign(s)) return
  set({ parked: null })
  // A tool or step chosen on the way in wins over the parked one.
  if (s.objectTool !== null || s.historyEdit) return
  const e = p.objectId ? s.plate.find((x) => x.id === p.objectId) : undefined
  if (p.objectId && !e) return void (p.tool && dropped(p, 'its object is no longer on the plate'))
  const remade = Boolean(p.basis && e && e.parts !== p.basis.parts)
  const now = p.basis && e && !remade && !sameMatrix(p.basis.transform, e.transform) ? nowOf({ transform: p.basis.transform }, e.transform) : null
  if (p.tool) handback = { tool: p.tool, fields: p.fields, now, remade }
  try {
    if (p.historyEdit && e) {
      const index = e.history?.steps.findIndex((x) => x.id === p.historyEdit!.stepId) ?? -1
      if (index < 0) {
        handback = null
        return dropped(p, 'its step is gone')
      }
      await (p.historyEdit.view ? viewStep(host, e.id, index) : beginEdit(host, e.id, index))
      // Design closed again while the step replayed: it goes back to waiting.
      if (!inDesign(get())) {
        cancelEdit()
        set({ parked: p, ...(p.tool ? { objectTool: null } : {}) })
      }
    } else if (p.tool) set({ objectTool: p.tool })
  } catch (err) {
    handback = null
    toast(err instanceof Error ? err.message : String(err), 'warn')
  }
}

/** Says what a park that cannot come back was. */
function dropped(p: Parked, why: string): void {
  toast(p.tool ? `${toolLabel(p.tool)} closed: ${why}.` : `The step view closed: ${why}.`, 'warn')
}

appStore.subscribe((s, prev) => {
  if (inDesign(prev) && !inDesign(s)) return park()
  // Its object left the plate (deleted, undone, another project or plate).
  const p = s.parked
  if (p?.objectId && s.plate !== prev.plate && !s.plate.some((e) => e.id === p.objectId)) {
    set({ parked: null })
    if (p.tool) dropped(p, 'its object is no longer on the plate')
  }
  if (handback && s.objectTool !== prev.objectTool && s.objectTool !== handback.tool) handback = null
})
