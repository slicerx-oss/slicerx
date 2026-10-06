// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one confirm card after a passing test: what the printer reported (model, firmware, each nozzle,
// each filament unit and what its slots hold) and what the catalog adds (bed, toolhead). Each row says
// where its value came from; a nozzle the printer did not report stays editable.
import type { ExtruderInfo, FilamentUnit, PrinterHardware } from '@slicerx/contracts'
import { listPrinterProfiles } from '@slicerx/settings'
import { Chip, Icon, Input, Seg } from '@slicerx/ui'
import { bambuFamily, bambuGuide } from './bambu-lan'
import type { ReactNode } from 'react'
import { buildVolumeText, currentModel, EMPTY_FORM, filamentText, modelLabel, NOZZLE_SIZES, NOZZLE_TYPE_LABELS, nozzleText, type NozzleType, type PrinterForm } from './printer-form'
import { appName } from '../edition'

const UNIT_LABELS: Record<FilamentUnit['kind'], string> = {
  ams: 'AMS',
  'ams-lite': 'AMS lite',
  'ams-2-pro': 'AMS 2 Pro',
  'ams-ht': 'AMS HT',
  mmu: 'MMU',
  'qidi-box': 'QIDI Box',
  cfs: 'CFS',
  toolchanger: 'Toolheads',
  ace: 'ACE',
  external: 'External spool',
}

const KINEMATICS: Record<string, string> = {
  'bed-slinger': 'Bed slinger',
  cartesian: 'Cartesian',
  corexy: 'CoreXY',
  corexz: 'CoreXZ',
  delta: 'Delta',
  idex: 'IDEX',
  toolchanger: 'Toolchanger',
}

/** "Left nozzle", "Right nozzle", or "Nozzle 2" on printers that do not name sides. */
export function extruderName(e: ExtruderInfo, count: number): string {
  if (e.position) return `${e.position === 'left' ? 'Left' : 'Right'} nozzle`
  return count > 1 ? `Nozzle ${e.tool + 1}` : 'Nozzle'
}

/** "0.6 mm, hardened steel, high flow": one nozzle as the printer reported it. */
export function nozzleLine(e: ExtruderInfo): string {
  const parts: string[] = []
  if (e.nozzleDiameterMm !== undefined) parts.push(`${e.nozzleDiameterMm} mm`)
  if (e.nozzleType) parts.push(NOZZLE_TYPE_LABELS[e.nozzleType as NozzleType].toLowerCase())
  if (e.highFlow) parts.push('high flow')
  return parts.join(', ') || 'not reported'
}

/** "AMS 2 Pro, right nozzle": a filament unit and, on two nozzle printers, the nozzle it feeds. */
export function unitName(u: FilamentUnit, hw: PrinterHardware): string {
  const ex = hw.extruders ?? []
  const feeds = u.tool === undefined ? undefined : ex.find((e) => e.tool === u.tool)
  const where = feeds && ex.length > 1 ? `, ${extruderName(feeds, ex.length).toLowerCase()}` : ''
  return `${UNIT_LABELS[u.kind] ?? u.kind}${where}`
}

function Source({ printer }: { printer: boolean }) {
  return printer ? <Chip tone="green">From the printer</Chip> : <span className="fr-src">From the catalog</span>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The units worth a line: empty external spools are left out; a unit with nothing loaded still shows its slots. */
function shownUnits(hw: PrinterHardware | undefined): FilamentUnit[] {
  return (hw?.filamentUnits ?? []).filter((u) => u.kind !== 'external' || u.slots.some((s) => s.material))
}

function Units({ hw }: { hw: PrinterHardware }) {
  const units = shownUnits(hw)
  return (
    <div className="fr-units">
      {units.map((u) => (
        <div className="fr-unit" key={u.id}>
          <span className="fr-unit-h">
            {unitName(u, hw)}
            {u.kind !== 'external' ? <span className="sx-dim">{u.slots.length} {u.slots.length === 1 ? 'slot' : 'slots'}</span> : null}
          </span>
          <ul className="fr-slots" aria-label={unitName(u, hw)}>
            {u.slots.map((s) =>
              s.material ? (
                <li className="fr-slot" key={s.id}>
                  <span className="fr-swatch" style={{ background: s.color ?? 'transparent' }} aria-hidden="true" />
                  {u.kind !== 'external' ? <span className="sx-mono sx-dim">{s.id}</span> : null}
                  {s.material}
                </li>
              ) : (
                <li className="fr-slot" key={s.id} data-empty="">
                  {u.kind !== 'external' ? <span className="sx-mono">{s.id}</span> : null} Empty
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function ConfirmCard({ form, setForm, hardware, reportedNozzle, reportedFilament = false, firmware }: { form: PrinterForm; setForm: (f: (f: PrinterForm) => PrinterForm) => void; hardware?: PrinterHardware | undefined; reportedNozzle: boolean; reportedFilament?: boolean; firmware?: string | undefined }) {
  const model = currentModel(form)
  const listed = model ? listPrinterProfiles().find((x) => x.id === model.id)?.nozzles : undefined
  const sizes: number[] = listed && listed.length ? [...listed].sort((a, b) => a - b) : [...NOZZLE_SIZES]
  const n = form.nozzles[0] ?? EMPTY_FORM.nozzles[0]!
  const { brand, model: modelName } = modelLabel(form)
  const extruders = (hardware?.extruders ?? []).filter((e) => e.nozzleDiameterMm !== undefined || e.nozzleType)
  const units = shownUnits(hardware)
  const family = bambuFamily(model?.name ?? hardware?.model)
  const devOff = hardware?.developerMode === false
  const noCard = family === 'x1' && hardware?.sdCard === false
  return (
    <>
    {devOff ? (
      <p className="fr-warn fr-warn-box" role="alert">
        <Icon name="warning" size={16} />
        <span>
          <b>Turn on Developer Mode.</b> The printer answered, but it will refuse prints from {appName()} until Developer Mode is on.{' '}
          {family ? `${bambuGuide(family).developerWhere} ${bambuGuide(family).developer}` : 'It is on the LAN Only page of the printer\'s settings.'}
        </span>
      </p>
    ) : null}
    {noCard ? (
      <p className="fr-warn fr-warn-box" role="alert">
        <Icon name="warning" size={16} />
        <span>
          <b>Put a micro SD card in the printer.</b> An X1 needs one to start a print sent over the network.
        </span>
      </p>
    ) : null}
    <dl className="fr-read" aria-label={`What ${appName()} will use`}>
      <Row label="Printer">
        {brand} {modelName}
        {hardware?.model ? <Source printer /> : null}
      </Row>
      {model ? (
        <Row label="Build plate">
          <span className="sx-mono">{buildVolumeText(model)}</span>
          {model.enclosed ? <Chip>Enclosed</Chip> : null}
          <span className="sx-dim">{KINEMATICS[model.kinematics] ?? model.kinematics}</span>
          <Source printer={false} />
        </Row>
      ) : null}
      {firmware ? (
        <Row label="Firmware">
          <span className="sx-mono">{firmware}</span>
          <Source printer />
        </Row>
      ) : null}
      <Row label={extruders.length > 1 ? 'Nozzles' : 'Nozzle'}>
        {extruders.length ? (
          <span className="fr-nozzles">
            {extruders.map((e) => (
              <span key={e.tool}>
                {extruders.length > 1 ? `${extruderName(e, extruders.length)}: ` : ''}
                {nozzleLine(e)}
              </span>
            ))}
          </span>
        ) : reportedNozzle ? (
          nozzleText(form)
        ) : (
          <>
            <Seg
              label="Nozzle diameter"
              size="sm"
              mono
              value={n.size === null ? 'other' : String(n.size)}
              options={[...sizes.map((s) => ({ value: String(s), label: `${s} mm` })), { value: 'other', label: 'Other' }]}
              onChange={(v) => setForm((f) => ({ ...f, nozzleUnsure: false, nozzles: f.nozzles.map((x) => (v === 'other' ? { ...x, size: null } : { ...x, size: Number(v), other: '' })) }))}
            />
            {n.size === null ? (
              <Input id="fr-read-noz" aria-label="Nozzle diameter" mono unit="mm" inputMode="decimal" placeholder="0.1 to 2.0" value={n.other} onChange={(e) => setForm((f) => ({ ...f, nozzles: f.nozzles.map((x) => ({ ...x, other: e.target.value })) }))} />
            ) : null}
          </>
        )}
        {extruders.length || reportedNozzle ? <Source printer /> : null}
      </Row>
      <Row label="Toolhead">
        {form.toolhead === 'direct' ? 'Direct drive' : 'Bowden'}
        {model && model.nozzleCount > 1 ? <span className="sx-dim">{model.nozzleCount} nozzles</span> : null}
        <Source printer={false} />
      </Row>
      <Row label="Filament">
        {units.length ? <Units hw={hardware!} /> : filamentText(form)}
        <Source printer={units.length > 0 || reportedFilament} />
      </Row>
      {hardware?.sdCard !== undefined ? (
        <Row label="Storage">
          {hardware.sdCard ? 'Micro SD card in' : 'No micro SD card'}
          <Source printer />
        </Row>
      ) : null}
    </dl>
    </>
  )
}
