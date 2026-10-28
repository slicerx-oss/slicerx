// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Applies packages/profiles/overlays/bbl-2.8.json (Bambu Studio 2.8's values for the settings the engine reads) to the
// shipped Bambu Lab data: filaments/BBL.json and resolved/bambu-lab.json. Run it after anything that writes either file
// again (gen-resolved.ts runs it on its own output). Applying it twice changes nothing.
// It also applies packages/profiles/overlays/prusa-mk4is.json (the MK4 IS lift and retraction for the stock MK4) to
// resolved/prusa.json and machine.json, so run it after machine.json is written again too. The list is MAKER_OVERLAYS in
// js/overlay.ts.
// Run: npx tsx scripts/apply-overlay.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { applyFilamentOverlay, applyMachineOverlay, applyResolvedOverlay, MAKER_OVERLAYS, type MachineFile, type MakerOverlay, type ResolvedBrand, type VendorData } from '../js/overlay'
import { printerProfile } from '../js/profiles'

const profiles = (path: string): URL => new URL(`../../profiles/${path}`, import.meta.url)
const nozzle = (model: string): number => printerProfile(model)?.defaultNozzle ?? 0.4

for (const o of MAKER_OVERLAYS) {
  const overlay = JSON.parse(readFileSync(profiles(o.path), 'utf8')) as MakerOverlay
  if (o.filaments) {
    const vendor = JSON.parse(readFileSync(profiles(o.filaments), 'utf8')) as VendorData
    applyFilamentOverlay(vendor, overlay)
    writeFileSync(profiles(o.filaments), JSON.stringify(vendor))
  }
  const brand = JSON.parse(readFileSync(profiles(`resolved/${o.brand}.json`), 'utf8')) as ResolvedBrand
  applyResolvedOverlay(brand, overlay, nozzle)
  writeFileSync(profiles(`resolved/${o.brand}.json`), JSON.stringify(brand) + '\n')
  if (o.machineJson) {
    const machine = JSON.parse(readFileSync(profiles('machine.json'), 'utf8')) as MachineFile
    applyMachineOverlay(machine, overlay, nozzle)
    writeFileSync(profiles('machine.json'), JSON.stringify(machine, null, 1) + '\n')
  }
  console.log(`overlay ${o.path}: ${Object.keys(overlay.filament).length} filament presets, ${Object.keys(overlay.machine).length} printers, ${Object.keys(overlay.process).length} process sets`)
}
