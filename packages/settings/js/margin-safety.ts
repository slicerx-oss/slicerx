// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One constant on its own, so the box packer's bed checks (box-pack.ts), which the web shell needs, do not bring the
// rest of arrange-room.ts and the settings defaults with them (apps/web bundle-size budget).

/** Room kept between two printed things beyond what is computed, mm: the engine rounds a brim up to whole lines. */
export const MARGIN_SAFETY_MM = 1
