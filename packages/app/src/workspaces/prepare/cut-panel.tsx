// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The cut tool's panel in the settings sidebar, next to its gizmo in the 3D view. The plane lives
// in plate/cut-plane.ts: the view writes it when a drag ends, the fields write it on Enter or blur,
// and both read it from there. The outline the plane leaves on the object is drawn in the view as
// the section, computed again only when the plane settles. Pins and dowels go where the panel's
// placement says: automatically, or where clicks on the plane put them, drawn as circles of their
// size. Loaded the first time the tool opens.
import { Button, ScrubNumber, Select, VectorField } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { useHost } from '../../host'
import { clearanceFor } from '../../plate/clearance'
import { connectorRings, connectorTolerance, cutStore, normalOf, offsetOf, offsetRange, planeAt, tiltsOf, useCutConnectors, useCutKeep, useCutPlane, type ConnectorKind, type CutConnectors, type CutKeep } from '../../plate/cut-plane'
import { cutSelected, sectionLoops } from '../../plate/geom-ops'
import { cameraBus } from '../../plate/tools'
import { bounds, type Vec3 } from '../../plate/transform'
import { get, set, toast, useApp } from '../../state/store'
import { Actions, Choice, Note, num, PointerHint, Row, Shell, ToolFooter } from '../../cad/panel-kit'
import '../../cad/cad.css'

type Preset = 'z' | 'x' | 'y'
const PRESETS: Record<Preset, [number, number]> = { z: [0, 0], x: [0, 90], y: [-90, 0] }

function presetOf(tilts: [number, number]): Preset | '' {
  const hit = (Object.keys(PRESETS) as Preset[]).find((k) => Math.abs(PRESETS[k][0] - tilts[0]) < 1e-3 && Math.abs(PRESETS[k][1] - tilts[1]) < 1e-3)
  return hit ?? ''
}

export function CutPanel() {
  const host = useHost()
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const plane = useCutPlane()
  const keep = useCutKeep()
  const conn = useCutConnectors()
  const setConn = (patch: Partial<CutConnectors>) => cutStore.setState((st) => ({ connectors: { ...st.connectors, ...patch } }))
  // The fit clearance stands in for the tolerance until one is typed, and says where it came from.
  const clearanceMm = useApp((s) => clearanceFor(s).mm)
  const clearanceWords = useApp((s) => clearanceFor(s).words)
  const clearanceMeasured = useApp((s) => clearanceFor(s).measured)
  const toleranceMm = conn.toleranceSet ? conn.toleranceMm : clearanceMm
  const [section, setSection] = useState<Vec3[][]>([])
  const [busy, setBusy] = useState(false)
  const box = useMemo(() => (entry ? bounds(entry.parts, entry.transform) : null), [entry])
  const center = useMemo<Vec3>(() => (box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : [0, 0, 0]), [box])
  const id = entry?.id ?? null

  // The sidebar opens with the tool, and a new object starts with a level plane through its middle.
  useEffect(() => {
    set((s) => (s.rails['prepare']?.left === false ? { rails: { ...s.rails, prepare: { ...s.rails['prepare'], left: true } } } : {}))
    return () => {
      cutStore.setState((st) => ({ plane: null, connectors: { ...st.connectors, points: [], placing: false } }))
      cameraBus()?.guides?.({})
    }
  }, [])
  useEffect(() => {
    if (!id) return void cutStore.setState({ plane: null })
    if (cutStore.getState().plane?.objectId !== id) cutStore.setState({ plane: planeAt(id, center, [0, 0, 1], 0) })
  }, [id, center])

  // Section view: the outline where the plane meets the object.
  useEffect(() => {
    if (!entry || !plane || plane.objectId !== entry.id) return void setSection([])
    const ac = new AbortController()
    sectionLoops(entry, plane, ac.signal).then(
      (loops) => !ac.signal.aborted && setSection(loops),
      () => undefined,
    )
    return () => ac.abort()
  }, [entry, plane])
  // The section and the placed connectors, drawn through the model.
  useEffect(() => {
    if (!plane) return void cameraBus()?.guides?.({})
    const rings = conn.kind === 'pin' || conn.kind === 'dowel' ? connectorRings(plane, conn) : []
    cameraBus()?.guides?.({ loops: [...section.map((points) => ({ points })), ...rings.map((points) => ({ points }))], points: conn.kind === 'pin' || conn.kind === 'dowel' ? conn.points : [] })
  }, [plane, section, conn])

  const close = () => set({ objectTool: null })
  if (!entry || !plane || !box) {
    return (
      <Shell title="Cut" section="cut-tool" aside="Nothing selected">
        <Note>Select an object to cut.</Note>
        <Actions quiet={<Button variant="ghost" onClick={close}>Close</Button>} />
      </Shell>
    )
  }
  const tilts = tiltsOf(plane.normal)
  const offset = offsetOf(plane, center)
  const [lo, hi] = offsetRange(box, center, plane.normal)
  const put = (normal: Vec3, at: number) => {
    const [a, b] = offsetRange(box, center, normal)
    cutStore.setState({ plane: planeAt(entry.id, center, normal, Math.max(a, Math.min(b, at))) })
  }
  const tilt = (axis: number, v: number) => put(axis === 0 ? normalOf(Math.max(-90, Math.min(90, v)), tilts[1]) : normalOf(tilts[0], v), offset)
  const cut = async () => {
    setBusy(true)
    try {
      const placed = conn.kind !== 'dovetail' && conn.points.length > 0
      const n = await cutSelected(host.slicer, {
        axis: 'z',
        atMm: 0,
        plane: { point: plane.point, normal: plane.normal },
        keep,
        ...(conn.kind === 'none' ? {} : { connector: { kind: conn.kind, diameterMm: conn.diameterMm, depthMm: conn.depthMm, toleranceMm: connectorTolerance(conn, get()), ...(placed ? { positions: conn.points } : {}) } }),
      })
      if (n > 0) close()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Shell title="Cut" section="cut-tool" aside={entry.name}>
      <PointerHint text="Drag the plane or its handle to move it and the rings to tilt it; hold Shift to snap." />
      <Choice id="cut-plane" label="Plane" value={presetOf(tilts)} onChange={(v: Preset | '') => v && put(normalOf(...PRESETS[v]), 0)} options={[{ value: 'z', label: 'Level' }, { value: 'x', label: 'Across X' }, { value: 'y', label: 'Across Y' }]} />
      <VectorField id="cut-tilt" className="tp-vec" label="Tilt" unit="°" axes={['x', 'y']} digits={1} values={tilts} onCommit={tilt} onPreview={tilt} />
      <Row label="Offset" unit="mm" labelId="cut-offset-label">
        <ScrubNumber parse={num} id="cut-offset" handle ariaLabel="Distance from the center, millimeters" unit="mm" value={offset} onCommit={(v) => put(plane.normal, v)} onPreview={(v) => put(plane.normal, v)} />
      </Row>
      <Note>Distance from the object's center, {lo.toFixed(1)} to {hi.toFixed(1)} mm.</Note>
      <Choice id="cut-keep" label="Keep" value={keep} onChange={(v: CutKeep) => cutStore.setState({ keep: v })} options={[{ value: 'both', label: 'Both' }, { value: 'below', label: 'Lower' }, { value: 'above', label: 'Upper' }]} />
      <Row label="Connectors" htmlFor="cut-conn">
        <Select id="cut-conn" size="sm" value={conn.kind} onChange={(ev) => setConn({ kind: ev.target.value as ConnectorKind, placing: false })}>
          <option value="none">None</option>
          <option value="pin">Pins</option>
          <option value="dowel">Dowels (printed separately)</option>
          <option value="dovetail">Dovetail</option>
        </Select>
      </Row>
      {conn.kind !== 'none' ? (
        <>
          <Row label={conn.kind === 'dovetail' ? 'Width' : 'Diameter'} unit="mm">
            <ScrubNumber parse={num} id="cut-conn-d" handle ariaLabel={`Connector ${conn.kind === 'dovetail' ? 'width' : 'diameter'}, millimeters`} unit="mm" digits={1} min={1} value={conn.diameterMm} onCommit={(v) => setConn({ diameterMm: v })} />
          </Row>
          <Row label="Depth" unit="mm">
            <ScrubNumber parse={num} id="cut-conn-depth" handle ariaLabel="Connector depth, millimeters" unit="mm" digits={1} min={0.5} value={conn.depthMm} onCommit={(v) => setConn({ depthMm: v })} />
          </Row>
          <Row label="Tolerance" unit="mm">
            <ScrubNumber parse={num} id="cut-conn-tol" handle ariaLabel="Connector tolerance, millimeters" unit="mm" step={0.01} digits={2} min={0} value={toleranceMm} onCommit={(v) => setConn({ toleranceMm: v, toleranceSet: true })} />
          </Row>
          <Row label={conn.toleranceSet ? `Typed. The fit clearance is ${clearanceWords.charAt(0).toLowerCase()}${clearanceWords.slice(1)}` : clearanceWords} className="tp-row-note" testId="cut-conn-tol-source">
            {conn.toleranceSet ? (
              <Button size="sm" variant="ghost" onClick={() => setConn({ toleranceSet: false })}>
                Use it
              </Button>
            ) : !clearanceMeasured ? (
              <Button size="sm" variant="ghost" onClick={() => set({ calibrationOpen: true })}>
                Print the test
              </Button>
            ) : null}
          </Row>
          {conn.kind !== 'dovetail' ? (
            <>
              <Choice id="cut-place" label="Place" ariaLabel="Place connectors" value={conn.placing ? 'view' : 'auto'} onChange={(v: 'auto' | 'view') => setConn(v === 'auto' ? { placing: false, points: [] } : { placing: true })} options={[{ value: 'auto', label: 'Automatically' }, { value: 'view', label: 'By clicking' }]} />
              {conn.placing ? (
                <Row label={conn.points.length === 0 ? 'Click the cut face to add a connector there; click one to take it away. With none placed they go in automatically.' : `${conn.points.length === 1 ? '1 connector' : `${conn.points.length} connectors`} placed. Click the cut face to add one, or click one to take it away.`} className="tp-row-note">
                  {conn.points.length ? (
                    <Button size="sm" variant="ghost" onClick={() => setConn({ points: [] })}>
                      Clear
                    </Button>
                  ) : null}
                </Row>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {entry.history?.steps.length ? <Note>Cutting ends this object's CAD history: the pieces start without one.</Note> : null}
      <ToolFooter verb="Cut" onApply={cut} busy={busy} />
    </Shell>
  )
}
