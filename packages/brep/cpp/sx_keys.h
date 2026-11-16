// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the kernel keeps a face's key: two long attributes on the face, one for the low half of the key's 52 bits
// and one for the high half (a long is 32 bits wide on the web). cpp/sx_brep.cpp reads and writes them, and so does
// src/kernel.rs, which keeps the same numbers as constants that cpp/sx_kernel.h checks against these.
#pragma once

constexpr unsigned long kSxKeyLow = 20101, kSxKeyHigh = 20102;
constexpr unsigned kSxKeyHalfBits = 26;
// A face whose key a join cleared keeps the key it had, as the key of the face it came from, in two more attributes
// of the same halves: what made the face is still known, while a reference to it asks for repair.
constexpr unsigned long kSxFromLow = 20105, kSxFromHigh = 20106;

// How far from a plane a face may be, in mm, and still be a plane where faces are sorted into kinds: a tapered
// extrude makes its flat sides as ruled surfaces, flat to 1e-5 mm. A sorting only, never a check of what the kernel
// made. src/body.rs keeps the same number, which cpp/sx_kernel.h checks against this one.
constexpr double kSxFlatKindMm = 1e-4;
