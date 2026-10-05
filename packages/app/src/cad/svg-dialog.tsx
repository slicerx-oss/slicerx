// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Import an SVG as a raised relief: pick the file, say how tall it is and how wide, and each fill color becomes a part.
import { Button, Dialog, Field, Input } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { registerCommands } from '../commands/registry'
import { useHost } from '../host'
import { setWorkspace } from '../state/store'
import { addSvgRelief, svgOptions } from './svg-import'
import { SvgFileField } from './svg-file'
import { closeSvgImport, openSvgImport, useSvgImportOpen } from './svg-state'

const num = (v: string) => Number(v.replace(',', '.'))
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Body() {
  const host = useHost()
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [height, setHeight] = useState('2')
  const [base, setBase] = useState('0')
  const [width, setWidth] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const form = { heightMm: num(height), baseMm: num(base || '0'), widthMm: width.trim() ? num(width) : null }
  const problem = file ? (() => { const o = svgOptions(form); return typeof o === 'string' ? o : null })() : 'Choose an SVG file.'
  return (
    <div className="cad-body">
      <SvgFileField id="svg-file" file={file} onFile={(f) => { setFile(f); setNote(null) }} onError={setNote} />
      <div className="cad-pair">
        <Field htmlFor="svg-h" label="Relief height">
          <Input id="svg-h" mono unit="mm" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
        </Field>
        <Field htmlFor="svg-b" label="Base thickness">
          <Input id="svg-b" mono unit="mm" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
      </div>
      <Field htmlFor="svg-w" label="Width" hint="Leave empty to use the size in the file">
        <Input id="svg-w" mono unit="mm" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
      </Field>
      <p className="sx-small sx-muted">Each fill color becomes its own part and filament. Strokes, text and images in the file are skipped.</p>
      {note ?? problem ? <p className="cad-note" role="status">{note ?? problem}</p> : null}
      <Button
        variant="primary"
        disabled={busy || problem !== null}
        onClick={() => {
          if (!file) return
          setBusy(true)
          addSvgRelief(host, file.name, file.text, form).then(
            () => {
              setWorkspace('prepare')
              closeSvgImport()
            },
            (e: unknown) => setNote(errorText(e)),
          ).finally(() => setBusy(false))
        }}
      >
        Add to the plate
      </Button>
    </div>
  )
}

export function SvgImportDialog() {
  const open = useSvgImportOpen()
  useEffect(
    () =>
      registerCommands([
        { id: 'svg-import', title: 'Import an SVG as a relief', section: 'plate', keywords: ['logo', 'vector', 'artwork', 'extrude', 'svg', 'emboss', 'import'], workspace: 'prepare', run: () => openSvgImport() },
      ]),
    [],
  )
  return (
    <Dialog open={open} onClose={closeSvgImport} title="Import an SVG" size="md">
      {open ? <Body /> : null}
    </Dialog>
  )
}
