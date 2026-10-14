# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
import math
from pathlib import Path
import runpy
import tempfile
import unittest

fingerprint = runpy.run_path(str(Path(__file__).with_name("gcode-fingerprint.py")))["fingerprint"]


class FingerprintTests(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.gcode"
            path.write_text(text)
            return fingerprint(path)

    def test_extrusion_modes_retraction_groups_and_hop(self):
        result = self.parse("""G90
M83
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
G1 Z0.2
;TYPE:Outer wall
G1 X1 E1
;HEIGHT:0.4
G1 E-0.4
G1 E-0.4
G1 Z0.6
G1 X2
G1 Z0.2
G1 E0.8
G3 X3 Y1 I0 J1 E2
M82
G92 E0
G1 X4 E1
G1 E0.5
G1 E1
;LAYER_CHANGE
;Z:0.4
;HEIGHT:0.2
G1 Z0.4
;TYPE:Inner wall
G1 X5 E2
; estimated printing time (normal mode) = 1h 2m 3s
; filament used [mm] = 5, 7
""")
        self.assertEqual(result["layer_count"], 2)
        self.assertEqual(result["height_min_mm"], 0.2)
        self.assertEqual(result["height_max_mm"], 0.2)
        outer = result["features"]["outer_wall"]
        self.assertEqual(outer["extrusion_mm"], 4)
        self.assertEqual(outer["moves"], 3)
        self.assertAlmostEqual(outer["path_mm"], 2 + math.pi / 2)
        self.assertEqual(result["features"]["inner_wall"]["extrusion_mm"], 1)
        self.assertEqual(result["retractions"], 2)
        self.assertEqual(result["negative_e_moves"], 3)
        self.assertEqual(result["z_hops"], 1)
        self.assertEqual(result["seam_candidate_count"], 2)
        self.assertAlmostEqual(result["travel_mm"], 2.2)
        self.assertEqual(result["estimates"]["print_time_s"], 3723)
        self.assertEqual(result["estimates"]["filament_mm"], 12)

    def test_wipe_and_helical_arc_are_travel(self):
        result = self.parse("""G90
M83
G1 X1
G1 X2 E-0.5
G3 X3 Y1 Z2 I0 J1
""")
        self.assertEqual(result["travel_count"], 3)
        self.assertAlmostEqual(result["travel_mm"], 2 + math.hypot(math.pi / 2, 2))
        self.assertEqual(result["retractions"], 1)
        self.assertEqual(result["features"]["custom"]["extrusion_mm"], 0)

    def test_reference_feature_aliases_and_unknown(self):
        result = self.parse("""M83
;CHANGE_LAYER
;Z_HEIGHT:0.2
;LAYER_HEIGHT:0.2
; FEATURE: External perimeter
G1 X1 E1
; FEATURE: Support material interface
G1 X2 E2
; FEATURE: Future feature
G1 X3 E3
""")
        self.assertEqual(result["features"]["outer_wall"]["layer_count"], 1)
        self.assertEqual(result["features"]["support_interface"]["extrusion_mm"], 2)
        self.assertEqual(result["features"]["unknown"]["extrusion_mm"], 3)
        self.assertEqual(result["unmapped_labels"], {"Future feature": 1})

    def test_layer_raise_is_not_a_completed_hop(self):
        result = self.parse("""M83
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
G1 Z0.2
G1 Z0.6
;LAYER_CHANGE
;Z:0.4
;HEIGHT:0.2
G1 Z0.4
G1 X1 E1
""")
        self.assertEqual(result["z_hops"], 0)


if __name__ == "__main__":
    unittest.main()
