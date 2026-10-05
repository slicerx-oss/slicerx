// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// <SettingsPanel>: Easy mode and Advanced settings over @slicerx/settings. It
// reports a full Orca-keyed config on every change; saving is the caller's job.
import type { EasySettings, PrintConfig, SettingDef, SettingValue, SpeedPreset, SupportMode } from '@slicerx/contracts'
import { EASY_DEFAULTS } from '@slicerx/contracts'
import { applyEasy, defaultConfig, formatValue, SETTINGS } from '@slicerx/settings'
import { useId, useMemo, useState, type CSSProperties } from 'react'

export interface SettingsChange {
  easy: EasySettings
  overrides: Record<string, SettingValue>
  config: PrintConfig
}

export interface SettingsPanelProps {
  /** Base config (a printer and filament profile); schema defaults when omitted. */
  config?: PrintConfig
  easy?: EasySettings
  mode?: 'easy' | 'advanced'
  onChange?: (change: SettingsChange) => void
  className?: string
  style?: CSSProperties
}

const SPEEDS: SpeedPreset[] = ['quality', 'balanced', 'fast', 'fastest']
const SPEED_LABELS: Record<SpeedPreset, string> = { quality: 'Quality', balanced: 'Balanced', fast: 'Fast', fastest: 'Fastest' }
// Saved settings may carry the old names; they read as the new ones (packages/settings/easy-map.json, controls.speed.aliases).
const LEGACY_SPEED: Record<string, SpeedPreset> = { silent: 'quality', gentle: 'quality', standard: 'balanced', sport: 'fast', ludicrous: 'fastest', maximum: 'fastest' }
const speedOf = (s: EasySettings['speed']): SpeedPreset => LEGACY_SPEED[s] ?? (s as SpeedPreset)
const SUPPORTS: SupportMode[] = ['off', 'auto', 'painted']
const SUPPORT_LABELS: Record<SupportMode, string> = { off: 'Off', auto: 'Auto, tree from the build plate', painted: 'Only where painted' }
const supportOf = (s: EasySettings['supports']): SupportMode => (s === 'everywhere' ? 'auto' : s)
const ADVANCED = new Set(['float', 'int', 'percent', 'bool', 'enum'])

function Row({ id, label, value, children }: { id: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="sxe-row">
      <div className="sxe-row-h">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{value}</output>
      </div>
      {children}
    </div>
  )
}

export function SettingsPanel({ config, easy: easyIn, mode: modeIn = 'easy', onChange, className, style }: SettingsPanelProps) {
  const uid = useId().replace(/:/g, '')
  const [easy, setEasy] = useState<EasySettings>(easyIn ?? EASY_DEFAULTS)
  const [overrides, setOverrides] = useState<Record<string, SettingValue>>({})
  const [mode, setMode] = useState(modeIn)
  const base = useMemo(() => config ?? (defaultConfig() as PrintConfig), [config])
  const resolved = useMemo(() => {
    const out = applyEasy(easy, base)
    for (const [k, v] of Object.entries(overrides)) out[k] = v
    return out
  }, [easy, overrides, base])

  const emit = (e: EasySettings, o: Record<string, SettingValue>) => {
    const out = applyEasy(e, base)
    for (const [k, v] of Object.entries(o)) out[k] = v
    onChange?.({ easy: e, overrides: o, config: out })
  }
  const setE = (patch: Partial<EasySettings>) => {
    const next = { ...easy, ...patch }
    setEasy(next)
    emit(next, overrides)
  }
  const setO = (key: string, v: SettingValue) => {
    const next = { ...overrides, [key]: v }
    setOverrides(next)
    emit(easy, next)
  }
  const show = (key: string) => formatValue(SETTINGS.find((d) => d.key === key), resolved[key])

  return (
    <div className={className ? `sxe-settings ${className}` : 'sxe-settings'} style={style}>
      <div className="sxe-tabs" role="tablist" aria-label="Settings mode">
        {(['easy', 'advanced'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
            {m === 'easy' ? 'Easy' : 'Advanced'}
          </button>
        ))}
      </div>
      {mode === 'easy' ? (
        <div role="tabpanel">
          <Row id={`${uid}-detail`} label="Detail" value={`${show('layer_height')} layers`}>
            <input id={`${uid}-detail`} type="range" min={0} max={100} step={5} value={easy.detail} onChange={(e) => setE({ detail: Number(e.currentTarget.value) })} />
          </Row>
          <Row id={`${uid}-strength`} label="Strength" value={`${show('wall_loops')} walls, ${show('sparse_infill_density')} infill`}>
            <input id={`${uid}-strength`} type="range" min={0} max={100} step={5} value={easy.strength} onChange={(e) => setE({ strength: Number(e.currentTarget.value) })} />
          </Row>
          <Row id={`${uid}-speed`} label="Speed" value={SPEED_LABELS[speedOf(easy.speed)]}>
            <input id={`${uid}-speed`} type="range" min={0} max={3} step={1} value={SPEEDS.indexOf(speedOf(easy.speed))} onChange={(e) => setE({ speed: SPEEDS[Number(e.currentTarget.value)] ?? 'balanced' })} />
          </Row>
          <Row id={`${uid}-supports`} label="Supports" value={SUPPORT_LABELS[supportOf(easy.supports)]}>
            <select id={`${uid}-supports`} value={supportOf(easy.supports)} onChange={(e) => setE({ supports: e.currentTarget.value as SupportMode })}>
              {SUPPORTS.map((s) => (
                <option key={s} value={s}>
                  {SUPPORT_LABELS[s]}
                </option>
              ))}
            </select>
          </Row>
          <label className="sxe-check" htmlFor={`${uid}-brim`}>
            <input id={`${uid}-brim`} type="checkbox" checked={easy.brim} onChange={(e) => setE({ brim: e.currentTarget.checked })} />
            Brim
          </label>
        </div>
      ) : (
        <ul className="sxe-list" role="tabpanel">
          {SETTINGS.filter((d: SettingDef) => d.section === 'process' && d.mode === 'simple' && ADVANCED.has(d.type)).map((d) => {
            const id = `${uid}-${d.key}`
            const v = resolved[d.key]
            return (
              <li key={d.key}>
                <label htmlFor={id}>{d.label}</label>
                {d.type === 'bool' ? (
                  <input id={id} type="checkbox" checked={v === true} onChange={(e) => setO(d.key, e.currentTarget.checked)} />
                ) : d.type === 'enum' ? (
                  <select id={id} value={String(v ?? '')} onChange={(e) => setO(d.key, e.currentTarget.value)}>
                    {(d.enumValues ?? []).map((x, i) => (
                      <option key={x} value={x}>
                        {d.enumLabels?.[i] ?? x}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    key={String(v)}
                    inputMode="decimal"
                    defaultValue={String(v ?? '')}
                    onBlur={(e) => {
                      const n = Number(e.currentTarget.value)
                      if (Number.isFinite(n)) setO(d.key, Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, n)))
                    }}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
