// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Object actions under the object list: add a shape (as its own object or as a part), split to
// objects or parts, merge. Booleans and other mesh tools are under Tools; volumes are under the object list.
import { useMore } from '../../shell/more'
import { Button, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator, tipAttrs, type IconName } from '@slicerx/ui'
import { useState } from 'react'
import { useHost } from '../../host'
import { addPrimitive, mergeSelected, splitSelectedToObjects, splitSelectedToParts } from '../../plate/edit'
import type { PrimitiveShape } from '../../plate/mesh-ops'
import { toast, useApp } from '../../state/store'
import { ObjectTools } from './object-tools'
import { printBlock } from '../../plate/heimdall'
import { exportAllPlates, exportGcode3mf, saveProject } from '../../export/actions'
import { appName } from '../../edition'

const SHAPES: { shape: PrimitiveShape; label: string; icon: IconName }[] = [
  { shape: 'box', label: 'Box', icon: 'cube' },
  { shape: 'cylinder', label: 'Cylinder', icon: 'cylinder' },
  { shape: 'sphere', label: 'Sphere', icon: 'sphere' },
  { shape: 'cone', label: 'Cone', icon: 'cone' },
]

export function ObjectActions() {
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  // A plate with a strike in its slice is not exported; the item says why.
  const unsafe = useApp(printBlock)
  const multi = useApp((s) => s.selectedIds.length > 1 && s.selection !== null && s.selectedIds.includes(s.selection))
  const [menu, setMenu] = useState<'add' | 'object' | 'export' | null>(null)
  const plates = useApp((s) => s.plates.length)
  const cad = useApp((s) => s.cadTools)
  const more = useMore('object')
  const run = (fn: () => Promise<unknown>) => {
    setMenu(null)
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
  return (
    <div className="obj-actions">
      {cad ? (
      <MenuAnchor>
        <Button size="sm" variant="ghost" icon="shapes" aria-haspopup="menu" aria-expanded={menu === 'add'} onClick={() => setMenu(menu === 'add' ? null : 'add')}>
          Add shape
        </Button>
        <Menu open={menu === 'add'} onClose={() => setMenu(null)} label="Add shape">
          <MenuHeading>New object</MenuHeading>
          {SHAPES.map((s) => (
            <MenuItem key={`o-${s.shape}`} icon={s.icon} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'object'))}>
              {s.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuHeading>Part of the selected object</MenuHeading>
          {SHAPES.map((s) => (
            <MenuItem key={`p-${s.shape}`} icon={s.icon} disabled={!hasSel} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'part'))}>
              {s.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuAnchor>
      ) : null}
      <MenuAnchor>
        <Button size="sm" variant="ghost" icon="export" aria-haspopup="menu" aria-expanded={menu === 'export'} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
          Export
        </Button>
        <Menu open={menu === 'export'} onClose={() => setMenu(null)} label="Export">
          <MenuItem icon="sx3mf" aside="sx3mf" onClick={() => run(() => saveProject(host))}>
            Save project
          </MenuItem>
          <MenuItem icon="lock" aside="sxlock" onClick={() => run(() => import('../../export/locked').then((m) => m.exportLockedProject(host)))}>
            Locked {appName()} project (.sxlock)
          </MenuItem>
          <MenuSeparator />
          <MenuHeading>For the printer</MenuHeading>
          <MenuItem icon="send-to-printer" aria-disabled={unsafe ? true : undefined} {...(unsafe ? tipAttrs({ title: 'Sliced plate as .gcode.3mf', reason: unsafe }) : {})} onClick={() => run(() => exportGcode3mf(host))}>
            Sliced plate as .gcode.3mf
          </MenuItem>
          <MenuItem icon="plates" disabled={plates < 2} onClick={() => run(() => exportAllPlates(host))}>
            Every plate, sliced
          </MenuItem>
        </Menu>
      </MenuAnchor>
      {more ? <ObjectTools /> : null}
      {more ? <MenuAnchor>
        <Button size="sm" variant="ghost" icon="more" aria-haspopup="menu" aria-expanded={menu === 'object'} disabled={!hasSel} onClick={() => setMenu(menu === 'object' ? null : 'object')}>
          Object
        </Button>
        <Menu open={menu === 'object'} onClose={() => setMenu(null)} label="Object actions" align="end">
          <MenuItem icon="split" onClick={() => run(() => splitSelectedToObjects(host.slicer))}>
            Split to objects
          </MenuItem>
          <MenuItem icon="split" onClick={() => run(() => splitSelectedToParts(host.slicer))}>
            Split to parts
          </MenuItem>
          <MenuItem icon="merge" disabled={!multi} onClick={() => run(() => mergeSelected(host.slicer))}>
            Merge selected objects
          </MenuItem>
        </Menu>
      </MenuAnchor> : null}
    </div>
  )
}
