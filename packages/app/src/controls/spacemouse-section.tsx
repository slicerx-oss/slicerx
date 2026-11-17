// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Controls > 3D mouse: on or off, Connect (in the browser, where access is asked for once), how fast it
// moves the view, which directions are flipped, and dominant axis mode. Changes apply at once.
import { Button, Field, Range, SettingRow, Switch } from '@slicerx/ui'
import { DEFAULT_SPACE_MOUSE, SPACE_AXES, SPACE_SENSITIVITY, type SpaceAxis, type SpaceMouseSettings } from '@slicerx/viewport/space-settings'
import { useState, useSyncExternalStore } from 'react'
import { set, useApp } from '../state/store'
import { connectSpaceMouse, spaceMouseSource, spaceMouseStatus, subscribeSpaceMouseStatus, type SpaceMouseStatus } from '../viewport/spacemouse'

const AXIS_LABELS: Record<SpaceAxis, string> = {
  panX: 'Invert pan left and right',
  panY: 'Invert pan up and down',
  zoom: 'Invert zoom',
  tilt: 'Invert tilt',
  spin: 'Invert spin',
}

/** The status line under the switch, in plain words. */
export function spaceMouseStatusText(s: SpaceMouseStatus, kind: 'webhid' | 'desktop' | null): string {
  switch (s.state) {
    case 'unsupported':
      return "This browser can't reach a 3D mouse. Use a Chromium-based browser such as Chrome or Edge, or the desktop app."
    case 'off':
      return kind === 'webhid' ? 'Off. Connect asks the browser for the device once.' : 'Off.'
    case 'none':
      return kind === 'webhid' ? 'No 3D mouse connected. Press Connect 3D mouse and pick it from the list.' : 'Looking for a 3D mouse. Plug one in.'
    case 'connected':
      return `Connected: ${s.name}.`
    case 'busy':
      return `Can't open ${s.name || 'the 3D mouse'}. Another program may be keeping it to itself, often the maker's own driver. Quit that program to use the 3D mouse here, or turn this off and keep using the driver.`
    case 'error':
      return s.message
  }
}

export function SpaceMouseSection() {
  const settings = useApp((s) => s.spaceMouse)
  const status = useSyncExternalStore(subscribeSpaceMouseStatus, spaceMouseStatus, spaceMouseStatus)
  const source = spaceMouseSource()
  const [asking, setAsking] = useState(false)
  const update = (patch: Partial<SpaceMouseSettings>) => set({ spaceMouse: { ...settings, ...patch } })
  const setInvert = (a: SpaceAxis, v: boolean) => update({ invert: { ...settings.invert, [a]: v } })
  const unsupported = status.state === 'unsupported'
  const canConnect = Boolean(source?.connect) && status.state !== 'connected'
  const connect = () => {
    setAsking(true)
    void connectSpaceMouse().finally(() => setAsking(false))
  }
  const changed = settings.sensitivity !== DEFAULT_SPACE_MOUSE.sensitivity || settings.dominantAxis !== DEFAULT_SPACE_MOUSE.dominantAxis || SPACE_AXES.some((a) => settings.invert[a] !== DEFAULT_SPACE_MOUSE.invert[a])
  return (
    <section className="set-rows" aria-labelledby="ctl-3dmouse" data-testid="space-mouse-settings">
      <h4 id="ctl-3dmouse" className="set-sub">
        3D mouse
      </h4>
      <SettingRow
        bare
        className="ctl-row"
        label={
          <label htmlFor="sm-on">
            Use a 3D mouse
            <small>Pan, zoom and orbit the view with it. Its left button resets the view and its right button fits it.</small>
          </label>
        }
        control={<Switch id="sm-on" checked={settings.enabled && !unsupported} disabled={unsupported} onChange={(v) => update({ enabled: v })} />}
      />
      <div className="sm-status">
        <p className="sx-small sx-muted" role="status" data-testid="space-mouse-status">
          {spaceMouseStatusText(status, source?.kind ?? null)}
        </p>
        {canConnect ? (
          <Button size="sm" data-testid="space-mouse-connect" disabled={asking} onClick={connect}>
            Connect 3D mouse
          </Button>
        ) : null}
      </div>
      {settings.enabled && !unsupported ? (
        <>
          <Field htmlFor="sm-speed" label="Sensitivity" className="sm-speed" aside={`${settings.sensitivity.toFixed(2)}×`} hint="How fast the view moves for the same push.">
            <Range id="sm-speed" min={SPACE_SENSITIVITY.min} max={SPACE_SENSITIVITY.max} step={SPACE_SENSITIVITY.step} value={settings.sensitivity} unit="times" onChange={(v) => update({ sensitivity: v })} />
          </Field>
          {SPACE_AXES.map((a) => (
            <SettingRow key={a} bare className="ctl-row" label={<label htmlFor={`sm-inv-${a}`}>{AXIS_LABELS[a]}</label>} control={<Switch id={`sm-inv-${a}`} checked={settings.invert[a]} onChange={(v) => setInvert(a, v)} />} />
          ))}
          <SettingRow
            bare
            className="ctl-row"
            label={
              <label htmlFor="sm-dominant">
                Dominant axis
                <small>Only the strongest push or twist moves the view, so a pan never tilts it by accident.</small>
              </label>
            }
            control={<Switch id="sm-dominant" checked={settings.dominantAxis} onChange={(v) => update({ dominantAxis: v })} />}
          />
          {changed ? (
            <Button size="sm" variant="ghost" onClick={() => update({ sensitivity: DEFAULT_SPACE_MOUSE.sensitivity, invert: DEFAULT_SPACE_MOUSE.invert, dominantAxis: DEFAULT_SPACE_MOUSE.dominantAxis })}>
              3D mouse back to the defaults
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
