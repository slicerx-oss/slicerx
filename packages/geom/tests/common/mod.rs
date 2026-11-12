// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the exact tests share.

/// Whether a volume the kernel computed is `want` to a millionth of it. The kernel integrates a solid's volume
/// itself, and its last digits differ between compilers and machines, so a volume from the kernel is held to a share
/// of itself, never to a fixed number of mm3.
pub fn volume_near(volume: f64, want: f64) -> bool {
    (volume - want).abs() <= 1e-6 * want.abs()
}
