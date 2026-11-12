// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the kernel keeps a face's key: two long attributes on the face, one for the low half of the key's 52 bits
// and one for the high half (a long is 32 bits wide on the web). cpp/sx_brep.cpp reads and writes them, and so does
// src/kernel.rs, which keeps the same numbers as constants that cpp/sx_kernel.h checks against these.
#pragma once

constexpr unsigned long kSxKeyLow = 20101, kSxKeyHigh = 20102;
constexpr unsigned kSxKeyHalfBits = 26;
