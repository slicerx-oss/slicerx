// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One object in the Objects card: a 36 px row with its thumbnail, name, part colors, a badge for settings of its own,
// one warning icon, lock and print toggles that show on hover (and stay while on), and a chevron that opens the tree
// of its parts and volumes. A click selects it, Cmd or Ctrl adds it, a double-click or F2 renames it in place.
import { Button, Icon, Menu, MenuItem, SwatchRing, tipAttrs, useContextMenu, type IconName } from '@slicerx/ui'
import { lazy, Suspense, useState, type KeyboardEvent } from 'react'
import { slotLabel } from '../../filament/rail'
import { effectiveSlot } from '../../filament/slots'
import { useResolvedSlots } from '../../filament/use-slots'
import { effectiveMode, useLayout } from '../../first-run/look'
import { partCount, triangles } from '../../lib/estimate-line'
import { MiddleName } from '../../lib/short-name'
import { Silhouette } from '../../parts'
import { selectObject } from '../../plate/edit'
import { moveObject, objectWarnings, renameObject, setPartSlot, toggleLock, togglePrintable, type ObjectMatch } from '../../plate/object-list'
import { removeVolume, ROLE_LABEL } from '../../plate/volumes'
import { get, selectedIds, set, useApp, type PlateEntry, type VolumeRole } from '../../state/store'
import { SelectionMenu } from './selection-bar'

const FitNotes = lazy(() => import('./fit-notes').then((m) => ({ default: m.FitNotes })))

const DRAG_TYPE = 'text/x-sx-object'

/** The icon for each volume role in the tree, instead of a colored dot. */
export const ROLE_ICON: Record<VolumeRole, IconName> = { negative: 'negative-part', support_blocker: 'support-blocker', support_enforcer: 'support-enforcer', modifier: 'modifier' }

/** How many settings an object has of its own, its parts' included. */
export function overrideCount(objectSettings: Readonly<Record<string, unknown>> | undefined, partSettings: PlateEntry['partSettings']): number {
  return Object.keys(objectSettings ?? {}).length + Object.values(partSettings ?? {}).reduce((n, s) => n + Object.keys(s).length, 0)
}

/** "2 settings differ from the plate". */
export function overrideText(n: number): string {
  return `${n} ${n === 1 ? 'setting differs' : 'settings differ'} from the plate`
}

/** Part colors on the row: up to four, then "+2". */
export function rowSwatches(colors: readonly string[]): { shown: string[]; more: number } {
  return colors.length <= 4 ? { shown: [...colors], more: 0 } : { shown: colors.slice(0, 3), more: colors.length - 3 }
}

export function ObjectRow({ entry: p, index, count, instanceOf, match, searching }: { entry: PlateEntry; index: number; count: number; instanceOf: string | undefined; match: ObjectMatch; searching: boolean }) {
  const selection = useApp((s) => s.selection)
  const multi = useApp((s) => s.selectedIds)
  const selected = selectedIds({ selection, selectedIds: multi }).includes(p.id)
  const bed = useApp((s) => s.bed)
  const printerSlots = useApp((s) => s.printerSlots)
  const own = useApp((s) => s.objectSettings[p.id])
  const developer = effectiveMode(useApp((s) => s.settingsMode), useLayout()) === 'developer'
  const slots = useResolvedSlots()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [drop, setDrop] = useState(false)
  const [slotMenu, setSlotMenu] = useState<{ part: string; at: { x: number; y: number } } | null>(null)
  const warnings = objectWarnings(p, { bed, printerSlots })
  const overrides = overrideCount(own, p.partSettings)
  const colors = p.handle.parts.map((part, i) => slots[effectiveSlot(p, part) - 1]?.color ?? p.colors[i] ?? 'var(--dim)')
  const sw = rowSwatches(colors)
  // A search that finds a part or a volume opens the tree to show it.
  const treeOpen = open || (searching && !match.self)
  const commit = (value: string) => {
    renameObject(p.id, value)
    setRenaming(false)
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'F2') {
      e.preventDefault()
      setRenaming(true)
    }
  }
  const slotCount = Math.max(4, slots.length)
  const scopePart = useApp((s) => s.scopePart)
  // A right click, a long press or Shift+F10 on a row outside the selection selects it first, as Finder does.
  const ctx = useContextMenu(() => {
    if (!selectedIds(get()).includes(p.id)) selectObject(p.id, 'set')
  })
  const order = `Position ${index + 1} of ${count}. Drag a row to reorder.`

  return (
    <li
      data-testid="object-row"
      data-object-id={p.id}
      className={`${selected ? 'obj sel' : 'obj'}${p.printable === false ? ' off' : ''}${drop ? ' drop' : ''}`}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, p.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDrop(false)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        setDrop(true)
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrop(false)
        const id = e.dataTransfer.getData(DRAG_TYPE)
        if (id) moveObject(id, index)
      }}
    >
      <div className="obj-row" data-pinned={p.locked || p.printable === false ? true : undefined} {...(renaming ? {} : ctx.bind)}>
        {renaming ? (
          <span className="obj-h obj-renaming">
            <span className="obj-thumb">{p.thumb ? <img src={p.thumb} alt="" /> : p.parts.length ? <Silhouette parts={p.parts} /> : null}</span>
            <input
              className="sx-input obj-rename-input"
              data-testid="object-rename"
              aria-label={`Name of ${p.name}`}
              defaultValue={p.name}
              maxLength={100}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commit(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenaming(false)
                }
              }}
            />
          </span>
        ) : (
          <button
            type="button"
            className="obj-h"
            data-testid="object-select"
            aria-pressed={selected}
            {...tipAttrs({ title: p.name, body: `${instanceOf ? `Instance of ${instanceOf}` : partCount(p.handle.parts.length)}, ${triangles(p.handle.triangles)}. Double-click or F2 to rename.` })}
            onClick={(e) => selectObject(p.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'set')}
            onDoubleClick={() => setRenaming(true)}
            onKeyDown={onKey}
          >
            <span className="obj-thumb">{p.thumb ? <img src={p.thumb} alt="" /> : p.parts.length ? <Silhouette parts={p.parts} /> : null}</span>
            <span className="obj-text">
              <span className="obj-name" data-testid="object-name" {...tipAttrs({ title: p.name })}>
                <MiddleName name={p.name} />
              </span>
              <span className="obj-meta" {...tipAttrs({ title: triangles(p.handle.triangles) })}>
                {instanceOf ? `Instance of ${instanceOf}` : partCount(p.handle.parts.length)}
                {developer ? `, ${triangles(p.handle.triangles)}` : null}
              </span>
            </span>
            <span className="obj-swatches" aria-hidden="true">
              {sw.shown.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
              {sw.more ? <b>+{sw.more}</b> : null}
            </span>
          </button>
        )}
        {overrides > 0 ? (
          <span className="obj-badge" data-testid="slice-object-override-badge" tabIndex={0} {...tipAttrs({ title: overrideText(overrides) })} aria-label={overrideText(overrides)}>
            <i aria-hidden="true" />
            {overrides}
          </span>
        ) : null}
        {warnings.length ? (
          <span className="obj-warn-ic" data-testid="object-warning" data-kind={warnings[0]!.kind} tabIndex={0} {...tipAttrs({ title: warnings.length === 1 ? warnings[0]!.text : `${warnings.length} warnings`, body: warnings.map((w) => w.text).join('. ') })} aria-label={warnings.map((w) => w.text).join('. ')}>
            <Icon name="alert" size={14} />
          </span>
        ) : null}
        <span className="obj-cluster">
          <Button size="sm" variant="ghost" icon={p.locked ? 'lock' : 'unlock'} data-testid="object-lock" aria-label={`${p.locked ? 'Unlock' : 'Lock'} ${p.name}`} tip={{ title: p.locked ? 'Locked' : 'Lock', body: p.locked ? 'Click to let it move again.' : 'Keep it from moving, scaling or arranging.' }} pressed={Boolean(p.locked)} onClick={() => toggleLock([p.id])} />
          <Button size="sm" variant="ghost" icon={p.printable === false ? 'hide' : 'show'} data-testid="object-printable" aria-label={`${p.printable === false ? 'Print' : 'Do not print'} ${p.name}`} tip={{ title: p.printable === false ? 'Not printed' : 'Printed', body: p.printable === false ? 'Click to print it again.' : 'Click to leave it out of the print.', key: 'V' }} pressed={p.printable === false} onClick={() => togglePrintable([p.id])} />
        </span>
        <Button size="sm" variant="ghost" icon="chevron-down" className="obj-chev" data-testid="slice-object-expand" aria-expanded={treeOpen} aria-label={`${treeOpen ? 'Hide' : 'Show'} the parts of ${p.name}`} tip={{ title: treeOpen ? 'Hide parts' : 'Parts', body: 'Its parts and volumes, and a filament for each part.' }} onClick={() => setOpen(!treeOpen)} />
      </div>
      <Suspense fallback={null}>
        <FitNotes id={p.id} />
      </Suspense>
      {treeOpen ? (
        <div className="obj-tree">
          <ul className="parts" aria-label={`Parts of ${p.name}`}>
            {p.handle.parts.map((part, i) =>
              !match.parts.includes(i) ? null : (
                <li key={`${part.name}-${i}`} className="part">
                  <Icon name="part" size={14} className="part-role" />
                  <button
                    type="button"
                    className="n part-pick"
                    data-testid="slice-object-part"
                    aria-pressed={scopePart?.id === p.id && scopePart.part === part.name}
                    {...tipAttrs({ title: part.name, body: 'Pick this part to give it settings of its own.' })}
                    onClick={() => set({ selection: p.id, selectedIds: [p.id], scopePart: { id: p.id, part: part.name }, settingsScope: 'objects' })}
                  >
                    {part.name}
                  </button>
                  <button
                    type="button"
                    className="part-slot"
                    data-testid="object-part-slot"
                    data-slot={effectiveSlot(p, part)}
                    aria-haspopup="menu"
                    aria-label={`Filament for ${part.name}: ${slots[effectiveSlot(p, part) - 1] ? slotLabel(slots[effectiveSlot(p, part) - 1]!) : effectiveSlot(p, part)}`}
                    {...tipAttrs({ title: `Filament for ${part.name}`, body: slots[effectiveSlot(p, part) - 1] ? slotLabel(slots[effectiveSlot(p, part) - 1]!) : `Slot ${effectiveSlot(p, part)}` })}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setSlotMenu({ part: part.name, at: { x: r.left, y: r.bottom + 4 } })
                    }}
                  >
                    <SwatchRing color={colors[i] ?? 'var(--dim)'} size={20} />
                  </button>
                </li>
              ),
            )}
            {(p.volumes ?? []).map((v) =>
              !match.volumes.includes(v.id) ? null : (
                <li key={v.id} className="part vol" data-testid="slice-object-volume" data-role={v.role}>
                  <Icon name={ROLE_ICON[v.role]} size={14} className="part-role" />
                  <span className="n">{v.name}</span>
                  <span className="sx-small sx-dim">{ROLE_LABEL[v.role]}</span>
                  <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove ${v.name} from ${p.name}`} onClick={() => removeVolume(p.id, v.id)} />
                </li>
              ),
            )}
          </ul>
          <div className="obj-order">
            <Button size="sm" variant="ghost" icon="arrow-up" aria-label={`Move ${p.name} up`} disabled={index === 0} onClick={() => moveObject(p.id, index - 1)} tip={{ title: 'Move up', body: order }} />
            <Button size="sm" variant="ghost" icon="arrow-down" aria-label={`Move ${p.name} down`} disabled={index === count - 1} onClick={() => moveObject(p.id, index + 1)} tip={{ title: 'Move down', body: order }} />
          </div>
        </div>
      ) : null}
      <SelectionMenu at={ctx.at} onClose={ctx.close} label={p.name} />
      <Menu open={slotMenu !== null} onClose={() => setSlotMenu(null)} label="Filament" at={slotMenu?.at}>
        {Array.from({ length: slotCount }, (_, k) => {
          const s = slots[k]
          const part = slotMenu ? p.handle.parts.find((x) => x.name === slotMenu.part) : undefined
          return (
            <MenuItem
              key={k + 1}
              checked={part ? effectiveSlot(p, part) === k + 1 : false}
              onClick={() => {
                if (slotMenu) setPartSlot(p.id, slotMenu.part, k + 1)
                setSlotMenu(null)
              }}
            >
              {s ? slotLabel(s) : `${k + 1}, not set up`}
            </MenuItem>
          )
        })}
      </Menu>
    </li>
  )
}
