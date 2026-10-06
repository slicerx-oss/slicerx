// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's named values: a name and a sum for each (wall = 2, lip = wall * 1.5), with what each comes to.
// Any typed size takes a name; a step whose size was typed with one follows it, so changing a value here replays
// those steps (value-ops.ts). `clearance` and `nozzle` are built in and read only.
import { Button, Icon, Input } from '@slicerx/ui'
import { useState } from 'react'
import { useApp } from '../state/store'
import { close, errorText, Shell } from './panel-kit'
import { removeValue, setValue, stepsUsing } from './value-ops'
import { builtIns, valueTable } from './value-table'

const mm = (v: number) => `${Number(v.toFixed(3))} mm`

function Row({ name, expr }: { name: string; expr: string }) {
  const [text, setText] = useState(expr)
  const [note, setNote] = useState<string | null>(null)
  // A string from the store, so the selector is stable; the table is rebuilt from it.
  const table = JSON.parse(useApp((s) => JSON.stringify(valueTable(s)))) as ReturnType<typeof valueTable>
  const value = table.values[name]
  const used = stepsUsing(name)
  const apply = () => {
    if (text.trim() === expr) return
    try {
      setValue(name, text)
      setNote(null)
    } catch (e) {
      setNote(errorText(e))
    }
  }
  return (
    <li className="cad-value">
      <label>
        <span className="sx-mono">{name}</span>
        <Input id={`value-${name}`} mono aria-label={`${name} is`} value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
      </label>
      <span className="sx-small sx-muted" data-testid={`value-${name}`}>
        {table.errors[name] ? <><Icon name="alert" size={13} /> {table.errors[name]}</> : value !== undefined ? `= ${mm(value)}${used ? `, ${used} step${used === 1 ? '' : 's'}` : ''}` : null}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon="delete"
        aria-label={`Remove ${name}`}
        onClick={() => {
          try {
            removeValue(name)
          } catch (e) {
            setNote(errorText(e))
          }
        }}
      />
      {note ? <p className="cad-note"><Icon name="alert" size={13} /> {note}</p> : null}
    </li>
  )
}

export function ValuesPanel() {
  const values = useApp((s) => s.namedValues)
  const fixed = JSON.parse(useApp((s) => JSON.stringify(builtIns(s)))) as Record<string, number>
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const add = () => {
    try {
      setValue(name.trim(), expr.trim() || '0')
      setName('')
      setExpr('')
      setNote(null)
    } catch (e) {
      setNote(errorText(e))
    }
  }
  return (
    <Shell title="Named values" aside={values.length === 1 ? '1 value' : `${values.length} values`}>
      <p className="cad-hint">Type a name in any size, or a sum such as <span className="sx-mono">wall * 2 + clearance</span>. Steps typed with a name follow it when it changes.</p>
      <ul className="cad-values">
        {values.map((v) => (
          <Row key={`${v.name}=${v.expr}`} name={v.name} expr={v.expr} />
        ))}
        {Object.entries(fixed).map(([n, v]) => (
          <li key={n} className="cad-value" data-builtin>
            <span className="sx-mono">{n}</span>
            <span className="sx-small sx-muted">{`= ${mm(v)}, built in`}</span>
          </li>
        ))}
      </ul>
      <div className="cad-pair">
        <Input id="value-new-name" mono aria-label="New value's name" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Input id="value-new-expr" mono aria-label="New value" placeholder="2" value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      </div>
      {note ? <p className="cad-note" role="status"><Icon name="alert" size={14} /> {note}</p> : null}
      <div className="cad-actions">
        <Button variant="ghost" onClick={close}>Done</Button>
        <Button variant="primary" onClick={add} disabled={!name.trim()}>Add value</Button>
      </div>
    </Shell>
  )
}
