// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// kb.search on questions as people ask them: the entry that answers each one is in the top three.
import { describe, expect, it } from 'vitest'
import { evalKb } from '../evals/harness'

// question, then the kind/id that answers it (any one of them)
const CASES: [string, string[]][] = [
  ['what nozzle temp for pla', ['filament/pla']],
  ['does petg need an enclosure', ['filament/petg']],
  ['how often do I need to dry filament', ['workflow/filament_drying']],
  ['abs or asa for something left outside in the sun', ['filament/asa', 'intent/uv_resistance']],
  ['why are parts weaker in one direction, should I rotate them', ['intent/strength']],
  ['is it safe to run the printer overnight while I sleep', ['workflow/unattended_printing']],
  ['shelf bracket that has to carry a heavy load', ['intent/strength']],
  ['fastest possible draft print', ['intent/speed']],
  ['big overhang on one side, do I need supports', ['workflow/supports', 'troubleshoot/poor_overhangs']],
  ['watertight cup that holds water', ['intent/watertight']],
  ['clearance for a press fit between two printed parts', ['workflow/tolerance']],
  ['switching from pla to petg, what changes', ['filament/petg']],
  ['textured or smooth pei plate for pla', ['workflow/bambu_plates']],
  ['first layer not sticking and the corners lift', ['troubleshoot/bed_adhesion', 'troubleshoot/first_layer', 'troubleshoot/warping']],
  ['thin strings between parts', ['troubleshoot/stringing']],
  ['layers shifted sideways halfway up', ['troubleshoot/layer_shift']],
  ['gaps and weak thin layers in the walls', ['troubleshoot/under_extrusion']],
  ['top surface has holes and looks pillowed', ['troubleshoot/pillowing']],
  ['petg print covered in blobs and zits', ['troubleshoot/seam_zits']],
  ['bottom layers squished out, elephant foot', ['troubleshoot/elephant_foot']],
  ['brim or raft, which one', ['workflow/adhesion']],
  ['how do I paint different colors onto my model', ['workflow/slicerx_paint']],
  ['paint where the seam goes', ['workflow/slicerx_paint', 'workflow/seams']],
  ['print tpu on an a1 with the ams lite', ['filament/tpu_95a', 'printer/bambu_a1', 'accessory/bambu_ams_lite']],
]

describe('kb.search answers plain questions', () => {
  const kb = evalKb()
  for (const [q, want] of CASES) {
    it(q, () => {
      const top = kb.search(q, { limit: 3 }).map((h) => `${h.doc.kind}/${h.doc.id}`)
      expect(top.some((t) => want.includes(t)), `top three: ${top.join(', ')}`).toBe(true)
    })
  }
})
