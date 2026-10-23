// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Applies packages/profiles/overlays/bbl-2.8.json (Bambu Studio 2.8's values for the settings the engine reads) to the
// shipped Bambu Lab data: filaments/BBL.json and resolved/bambu-lab.json. Run it after anything that writes either file
// again (gen-resolved.ts runs it on its own output). Applying it twice changes nothing.
// Run: npx tsx scripts/apply-overlay.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { applyFilamentOverlay, applyResolvedOverlay, BBL_OVERLAY, type MakerOverlay, type ResolvedBrand, type VendorData } from '../js/overlay'
import { printerProfile } from '../js/profiles'

const overlay = JSON.parse(readFileSync(new URL(`../../profiles/${BBL_OVERLAY}`, import.meta.url), 'utf8')) as MakerOverlay
const filaments = new URL('../../profiles/filaments/BBL.json', import.meta.url)
const resolved = new URL('../../profiles/resolved/bambu-lab.json', import.meta.url)

const vendor = JSON.parse(readFileSync(filaments, 'utf8')) as VendorData
applyFilamentOverlay(vendor, overlay)
writeFileSync(filaments, JSON.stringify(vendor))

const brand = JSON.parse(readFileSync(resolved, 'utf8')) as ResolvedBrand
applyResolvedOverlay(brand, overlay, (model) => printerProfile(model)?.defaultNozzle ?? 0.4)
writeFileSync(resolved, JSON.stringify(brand) + '\n')
console.log(`overlay: ${Object.keys(overlay.filament).length} filament presets, ${Object.keys(overlay.machine).length} printers, ${Object.keys(overlay.process).length} process sets`)
