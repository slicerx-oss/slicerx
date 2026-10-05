// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fmtLeft, fmtTemp, svgFromDataUri } from './printer-bits'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'

it('reads SVG from utf8 and base64 data URIs and ignores other URIs', () => {
  expect(svgFromDataUri(`data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`)).toBe(SVG)
  expect(svgFromDataUri(`data:image/svg+xml,${encodeURIComponent(SVG)}`)).toBe(SVG)
  expect(svgFromDataUri(`data:image/svg+xml;base64,${btoa(SVG)}`)).toBe(SVG)
  expect(svgFromDataUri('https://printer.example/snap.jpg')).toBeNull()
  expect(svgFromDataUri('data:image/jpeg;base64,AAAA')).toBeNull()
  expect(svgFromDataUri('data:image/svg+xml,%E0%A4%A')).toBeNull()
})

it('formats time left and temperatures', () => {
  expect(fmtLeft(5040)).toBe('1h 24m')
  expect(fmtLeft(600)).toBe('10m')
  expect(fmtTemp({ current: 249.6, target: 250 })).toBe('250 / 250 °C')
  expect(fmtTemp({ current: 27, target: 0 })).toBe('27 °C')
  expect(fmtTemp(undefined)).toBe('--')
})
