// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sweep tool: a profile sketch (one closed loop) carried along a path, a sketch with one open line or an edge of a
// body. The two slots fill in order; clicking a slot makes it the one the next pick fills. The profile has to sit on
// the path's start. The step keeps its own copy of the loops, and the sketches it was made from hide while it is live.
// Editing the step fills the slots from it, matched back to the sketches where they are still the same.
import type { PickEvent } from '@slicerx/viewport'
import { sweepParams, type LoftProfile, type SweepPath, type Vec3 } from '@slicerx/cad-history'
import { useEffect, useMemo, useState } from 'react'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { get, set, toast } from '../state/store'
import { applySweep } from './cad-ops'
import { pickEdge } from './edge-api'
import { editing, nowOf, saveStep } from './history/ops'
import { editingNumber } from './history/step-number'
import { edgePathOf, matchSketch, offPathWords, pathOf, profileMiddle, profileOf, sweepReason } from './loft-sweep'
import { errorText, Message, PointerHint, Row, Shell, ToolFooter } from './panel-kit'
import { useDraft } from './park'
import { sizeWords } from './op-preview'
import { frameShown } from './sketch-place'
import { profileNow, ResultChoice, useLiveSketches, useResult, useSketchPicks, type Result } from './solid-kit'
import { cameraBus } from '../plate/tools'

type Slot = 'profile' | 'path'
/** What fills the profile slot: a picked sketch, or the step's own profile when no sketch matches it now. */
export type ProfilePick = { id: string } | { kept: LoftProfile }
/** What fills the path slot: a sketch, an edge chain of a body (points on the bed), or the step's own path. */
export type PathPick = { id: string } | { edge: { name: string; path: SweepPath } } | { kept: SweepPath }

export function SweepTool() {
  const host = useHost()
  const sketches = useLiveSketches()
  const byId = useMemo(() => new Map(sketches.map((k) => [k.id, k])), [sketches])
  const edit = (() => {
    const ed = editing()
    const p = ed?.step.params
    return ed && p?.op === 'sketch.sweep' ? { index: ed.index, step: ed.step, entry: ed.entry, params: p, target: { objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part) }, operation: (p.operation ?? 'new') as Result } : null
  })()
  const [profile, setProfile] = useDraft<ProfilePick | null>('profile', () => {
    if (!edit) return null
    const now = profileNow(edit.params.profile, edit.step, edit.entry.transform)
    const k = matchSketch(now, sketches, frameShown)
    return k ? { id: k.id } : { kept: now }
  })
  const [path, setPath] = useDraft<PathPick | null>('path', () => {
    if (!edit) return null
    const p = edit.params.path
    if (p.points) {
      const to = nowOf(edit.step, edit.entry.transform)
      return { kept: { points: p.points.map((q) => to.point(q as Vec3)) } }
    }
    const now = profileNow(p, edit.step, edit.entry.transform)
    const k = matchSketch(now, sketches, frameShown)
    return k ? { id: k.id } : { kept: now }
  })
  const [active, setActive] = useState<Slot>(edit ? 'path' : 'profile')
  const [chosen, setChosen] = useDraft<Result | null>('operation', null)
  // a refused pick is known before the press and keeps Sweep off until the next pick; `note` is what the engine said after one
  const [pickNote, setPickNote] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // a picked sketch that left the timeline leaves its slot
  const prof = profile && 'id' in profile && !byId.has(profile.id) ? null : profile
  const pth = path && 'id' in path && !byId.has(path.id) ? null : path
  const first = prof && 'id' in prof ? (byId.get(prof.id) ?? null) : null
  const result = useResult(first, chosen, edit)
  const marks = useMemo(() => {
    const m = new Map<string, string>()
    if (prof && 'id' in prof) m.set(prof.id, 'Profile')
    if (pth && 'id' in pth) m.set(pth.id, 'Path')
    return m
  }, [prof, pth])

  /** The profile as the step takes it, where its sketch stands now; throws why it cannot be one. */
  const profileNowOf = (p: ProfilePick): LoftProfile => {
    if (!('id' in p)) return p.kept
    const k = byId.get(p.id)
    if (!k) throw new Error('That sketch is no longer in the timeline.')
    const r = profileOf(k, frameShown(k), 'sweep')
    if ('why' in r) throw new Error(r.why)
    return r.profile
  }
  const pathNowOf = (p: PathPick): SweepPath => {
    if ('kept' in p) return p.kept
    if ('edge' in p) return p.edge.path
    const k = byId.get(p.id)
    if (!k) throw new Error('That sketch is no longer in the timeline.')
    const r = pathOf(k, frameShown(k))
    if ('why' in r) throw new Error(r.why)
    return r.path
  }

  const onSketch = (id: string) => {
    const k = byId.get(id)
    if (!k) return
    setNote(null)
    setPickNote(null)
    if (active === 'profile') {
      const r = profileOf(k, frameShown(k), 'sweep')
      if ('why' in r) return setPickNote(r.why)
      setProfile({ id })
      if (pth && 'id' in pth && pth.id === id) setPath(null)
      if (!pth || ('id' in pth && pth.id === id)) setActive('path')
      return
    }
    const r = pathOf(k, frameShown(k))
    if ('why' in r) return setPickNote(r.why)
    setPath({ id })
    if (prof && 'id' in prof && prof.id === id) setProfile(null)
    if (!prof) setActive('profile')
  }
  const onOther = (hit: PickEvent) => {
    const at = hit.objectId && hit.triangle !== null && hit.point ? { objectId: hit.objectId, partIndex: hit.partIndex ?? 0, triangle: hit.triangle, point: hit.point } : hit.near
    if (!at || at.triangle < 0) return
    if (active === 'profile') return setPickNote('Click a sketch for the profile. An edge can be the path.')
    const e = get().plate.find((p) => p.id === at.objectId)
    const part = e?.parts[at.partIndex]
    if (!e || !part) return
    setNote(null)
    setPickNote(null)
    pickEdge({ mesh: toGeom(part), transform: e.transform }, { triangle: at.triangle, at: at.point }).then(
      (p) => {
        let near: Vec3 | undefined
        try {
          near = prof ? profileMiddle(profileNowOf(prof)) : undefined
        } catch {
          near = undefined
        }
        const r = edgePathOf(p.chain.length ? p.chain : [p.edge], near)
        if ('why' in r) return setPickNote(r.why)
        setPath({ edge: { name: `An edge of ${e.name}`, path: r.path } })
        if (!prof) setActive('profile')
      },
      (err: unknown) => setPickNote(errorText(err)),
    )
  }
  useSketchPicks(marks, onSketch, onOther)

  // an edge path shows as a line along the body while it is picked
  const edgePoints = pth && 'edge' in pth ? pth.edge.path.points : pth && 'kept' in pth ? pth.kept.points : undefined
  useEffect(() => {
    const pts = edgePoints ?? []
    cameraBus()?.guides?.(pts.length > 1 ? { lines: pts.slice(1).map((to, i) => ({ from: pts[i]!, to })), points: [pts[0]!, pts[pts.length - 1]!] } : {})
    return () => cameraBus()?.guides?.({})
  }, [edgePoints])

  // what is wrong with the picks as they stand, before the press: a sketch that changed since it was picked, or a
  // profile that sits away from the path's start
  const known = useMemo(() => {
    if (!prof || !pth) return null
    try {
      return offPathWords(profileNowOf(prof), pathNowOf(pth))
    } catch (e) {
      return errorText(e)
    }
  }, [prof, pth, byId])
  const shown = pickNote ?? known
  const reason = sweepReason(prof !== null, pth !== null) ?? shown

  const apply = async () => {
    if (reason !== null || busy || !prof || !pth) return
    setBusy(true)
    setNote(null)
    try {
      const profileStep = profileNowOf(prof)
      const pathStep = pathNowOf(pth)
      const away = offPathWords(profileStep, pathStep)
      if (away) throw new Error(away)
      const uses = [prof, pth].flatMap((x) => ('id' in x ? [x.id] : []))
      const into = result.op !== 'new' && result.target ? { target: result.target } : {}
      const input = { profile: profileStep, path: pathStep, operation: result.op, ...into, name: edit?.params.name ?? 'Sweep body' }
      if (edit) {
        const said = await saveStep(host.slicer, sweepParams(input), { uses })
        toast(said.message, said.warn ? 'warn' : 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applySweep(host.slicer, input, { uses })
      if (r.missed) return setNote(r.message)
      toast(r.message, r.warn ? 'warn' : 'ok')
      return true
    } catch (e) {
      setNote(sizeWords(errorText(e)))
    } finally {
      setBusy(false)
    }
  }

  const profileName = !prof ? null : 'id' in prof ? (byId.get(prof.id)?.name ?? null) : 'Kept in the step'
  const pathName = !pth ? null : 'id' in pth ? (byId.get(pth.id)?.name ?? null) : 'edge' in pth ? pth.edge.name : 'Kept in the step'
  return (
    <Shell title="Sweep" aside={edit ? `Editing step ${editingNumber(edit.index)}` : prof && pth ? 'Profile and path' : prof ? 'Profile picked' : 'Nothing picked yet'}>
      <PointerHint text="Click the profile sketch, then a sketch or an edge for the path." />
      <ResultChoice id="sweep-result" value={result.op} onChange={setChosen} options={result.options} canInto={result.canInto} editing={edit !== null} />
      <PickSlot id="sweep-profile" label="Profile" empty="Click a sketch." name={profileName} active={active === 'profile'} onActivate={() => {
          setPickNote(null)
          setActive('profile')
        }} />
      <PickSlot id="sweep-path" label="Path" empty="Click a sketch or an edge." name={pathName} active={active === 'path'} onActivate={() => {
          setPickNote(null)
          setActive('path')
        }} />
      {/* the path's options (scale, twist, how the change runs) go here, under Path */}
      {shown ?? note ? <Message id="sweep-message" text={(shown ?? note)!} testId="sweep-message" /> : null}
      <ToolFooter verb="Sweep" onApply={apply} busy={busy} disabled={reason !== null} reason={reason} reasonShownAt={shown && reason === shown ? 'sweep-message' : undefined} />
    </Shell>
  )
}

/** One slot the next pick fills: its label, then what fills it or what to click. Pressing it makes it the active one. */
function PickSlot({ id, label, empty, name, active, onActivate }: { id: string; label: string; empty: string; name: string | null; active: boolean; onActivate: () => void }) {
  return (
    <Row label={label} labelId={`${id}-label`} testId={`${id}-row`}>
      <button type="button" id={id} className="solid-slot" aria-labelledby={`${id}-label ${id}`} aria-pressed={active} data-filled={name !== null ? '' : undefined} data-testid={id} onClick={onActivate}>
        <span className="min0">{name ?? empty}</span>
      </button>
    </Row>
  )
}
