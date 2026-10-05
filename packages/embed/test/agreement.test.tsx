// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { AGREEMENT_VERSION as APP_VERSION } from '@slicerx/contracts'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { acceptAgreement, Agreement, AGREEMENT_KEY, AGREEMENT_VERSION, agreementNeeded, readAgreement, RELEASE, type AgreementStorage } from '../src/agreement'
import { createTheme, nocturne, nocturneLight } from '../src/index'
import { sceneFor } from '../src/theme'

function memory(): AgreementStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('the embedded agreement', () => {
  it('asks again exactly when the app does', () => {
    expect(AGREEMENT_VERSION).toBe(APP_VERSION)
    expect(RELEASE.stage).toBe('pre-alpha')
  })

  it('is needed in pre-alpha until this version is accepted, and records version and date', () => {
    const s = memory()
    expect(agreementNeeded(readAgreement(s))).toBe(true)
    const r = acceptAgreement(s, new Date('2026-10-04T12:00:00Z'))
    expect(r).toEqual({ version: AGREEMENT_VERSION, acceptedAt: '2026-10-04T12:00:00.000Z' })
    expect(JSON.parse(s.data.get(AGREEMENT_KEY) ?? '')).toEqual(r)
    expect(agreementNeeded(readAgreement(s))).toBe(false)
    expect(agreementNeeded({ version: AGREEMENT_VERSION - 1, acceptedAt: 'x' })).toBe(true)
    expect(agreementNeeded(null, { stage: 'beta' })).toBe(false)
  })

  it('reads nothing from a damaged record', () => {
    const s = memory()
    s.setItem(AGREEMENT_KEY, '{"version":"one"}')
    expect(readAgreement(s)).toBeNull()
    s.setItem(AGREEMENT_KEY, 'not json')
    expect(readAgreement(s)).toBeNull()
  })

  it('names the host app, the bug link and the version', () => {
    const html = renderToString(<Agreement appName="Spoolhouse" onAccept={() => {}} storage={null} />)
    for (const part of ['Spoolhouse', 'Watch your printer', RELEASE.bugReportsUrl.replace('https://', ''), `Agreement version ${AGREEMENT_VERSION}`]) expect(html).toContain(part)
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})

describe('scene colors follow the theme', () => {
  it('keeps the default studio for the dark theme, with its accent', () => {
    expect(sceneFor(nocturne)?.scene).toEqual({ selection: nocturne.colors.purple, liveLayer: nocturne.colors.cyan })
  })

  it('builds a light studio for a light theme and uses a brand accent', () => {
    const t = createTheme({ colors: { purple: '#1f9d55' } }, nocturneLight)
    const scene = sceneFor(t)?.scene ?? {}
    expect(scene.selection).toBe('#1f9d55')
    expect(scene.bgTop).toMatch(/^#[0-9a-f]{6}$/i)
    expect(scene.bgTop).not.toBe(sceneFor(nocturne)?.scene?.bgTop)
  })

  it('takes a theme scene block as is', () => {
    const t = createTheme({ scene: { top: '#0b1f14', bottom: '#06120b', glow: '#123d27', plate: '#1a4d33', grid: '#3f8f63', edge: '#020805' } })
    expect(sceneFor(t)?.scene).toMatchObject({ bgTop: '#0b1f14', bgBottom: '#06120b', floorGrid: '#3f8f63' })
  })
})
