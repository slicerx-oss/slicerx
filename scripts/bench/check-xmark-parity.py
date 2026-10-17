# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Check a real x-mark G-code fingerprint against the retained Bambu baseline.

Run the external benchmark model with the matching P1S profile, fingerprint its
G-code, then run: python3 -I scripts/bench/check-xmark-parity.py fingerprint.json
The benchmark model and machine-specific profile stay outside the repository.
"""
import argparse
import json
from pathlib import Path


def check(data):
    if data.get("layer_count") != 427:
        raise ValueError("expected the 427-layer x-mark benchmark")
    for key, baseline in (("retractions", 1158), ("travel_mm", 54920.905736673645)):
        value = data[key]
        if not baseline * 0.85 <= value <= baseline * 1.15:
            raise ValueError(f"{key}: {value} is outside 15% of {baseline}")
        print(f"{key}: {value} (baseline {baseline}, tolerance 15%)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fingerprint", type=Path)
    args = parser.parse_args()
    check(json.loads(args.fingerprint.read_text()))
