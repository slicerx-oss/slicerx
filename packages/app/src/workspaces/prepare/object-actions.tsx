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
import { usePhoneLayout } from '../../lib/phone-layout'

export const SHAPES: { shape: PrimitiveShape; label: string; icon: IconName }[] = [
  { shape: 'box', label: 'Box', icon: 'cube' },
  { shape: 'cylinder', label: 'Cylinder', icon: 'cylinder' },
  { shape: 'sphere', label: 'Sphere', icon: 'sphere' },
  { shape: 'cone', label: 'Cone', icon: 'cone' },
]

type MenuProps = { open: boolean; onClose: () => void; align?: 'start' | 'end' }

/** Runs an action from a menu after closing it; a failure becomes a toast. */
function runner(onClose: () => void) {
  return (fn: () => Promise<unknown>) => {
    onClose()
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
}

/** Shapes as a new object or as a part of the selected one. */
export function ShapeMenu({ open, onClose, align = 'start' }: MenuProps) {
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  const run = runner(onClose)
  return (
    <Menu open={open} onClose={onClose} label="Add shape" align={align}>
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
  )
}

/** Saving the project and the files for the printer. */
export function ExportMenu({ open, onClose, align = 'start' }: MenuProps) {
  const host = useHost()
  // A plate with a strike in its slice is not exported; the item says why.
  const unsafe = useApp(printBlock)
  const plates = useApp((s) => s.plates.length)
  const run = runner(onClose)
  // a phone exports for the printer only; projects go to the desktop
  const phone = usePhoneLayout()
  return (
    <Menu open={open} onClose={onClose} label="Export" align={align}>
      {phone ? null : (
        <>
          <MenuItem icon="sx3mf" aside="sx3mf" data-testid="export-save-project" onClick={() => run(() => saveProject(host))}>
            Save project
          </MenuItem>
          <MenuItem icon="lock" aside="sxlock" data-testid="export-locked-project" onClick={() => run(() => import('../../export/locked').then((m) => m.exportLockedProject(host)))}>
            Locked {appName()} project (.sxlock)
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuHeading>For the printer</MenuHeading>
      <MenuItem icon="send-to-printer" data-testid="export-gcode-3mf" aria-disabled={unsafe ? true : undefined} {...(unsafe ? tipAttrs({ title: 'Sliced plate as .gcode.3mf', reason: unsafe }) : {})} onClick={() => run(() => exportGcode3mf(host))}>
        Sliced plate as .gcode.3mf
      </MenuItem>
      <MenuItem icon="plates" data-testid="export-all-plates" disabled={plates < 2} onClick={() => run(() => exportAllPlates(host))}>
        Every plate, sliced
      </MenuItem>
    </Menu>
  )
}

/** Splitting and merging the selected objects. */
export function ObjectMenu({ open, onClose, align = 'end' }: MenuProps) {
  const host = useHost()
  const multi = useApp((s) => s.selectedIds.length > 1 && s.selection !== null && s.selectedIds.includes(s.selection))
  const run = runner(onClose)
  return (
    <Menu open={open} onClose={onClose} label="Object actions" align={align}>
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
  )
}

/** `design`: only More (split and merge). Design's shelf has Add and the tools; Export belongs to Slice (Mod+S still saves). */
export function ObjectActions({ design }: { design?: boolean } = {}) {
  const hasSel = useApp((s) => s.selection !== null)
  const [menu, setMenu] = useState<'add' | 'object' | 'export' | null>(null)
  const cad = useApp((s) => s.cadTools)
  const more = useMore('object')
  const close = () => setMenu(null)
  return (
    <div className="obj-actions">
      {cad && !design ? (
        <MenuAnchor>
          <Button size="sm" variant="ghost" icon="shapes" data-testid="add-shape" aria-haspopup="menu" aria-expanded={menu === 'add'} onClick={() => setMenu(menu === 'add' ? null : 'add')}>
            Add shape
          </Button>
          <ShapeMenu open={menu === 'add'} onClose={close} />
        </MenuAnchor>
      ) : null}
      {design ? null : (
        <MenuAnchor>
          <Button size="sm" variant="ghost" icon="export" data-testid="export-menu" aria-haspopup="menu" aria-expanded={menu === 'export'} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
            Export
          </Button>
          <ExportMenu open={menu === 'export'} onClose={close} />
        </MenuAnchor>
      )}
      {more && !design ? <ObjectTools /> : null}
      {more ? (
        <MenuAnchor>
          <Button size="sm" variant="ghost" icon="more" data-testid="object-menu" aria-haspopup="menu" aria-expanded={menu === 'object'} disabled={!hasSel} onClick={() => setMenu(menu === 'object' ? null : 'object')}>
            Object
          </Button>
          <ObjectMenu open={menu === 'object'} onClose={close} />
        </MenuAnchor>
      ) : null}
    </div>
  )
}
