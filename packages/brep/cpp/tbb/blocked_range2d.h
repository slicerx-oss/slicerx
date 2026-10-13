// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stands in for oneTBB's ranges, for the serial parallel_for in parallel_for.h.
#pragma once
#include <cstddef>
namespace tbb {
template <class T> struct blocked_range {
    T b, e;
    blocked_range(T b_, T e_, size_t = 1) : b(b_), e(e_) {}
    T begin() const { return b; }
    T end() const { return e; }
};
template <class R, class C = R> struct blocked_range2d {
    blocked_range<R> r;
    blocked_range<C> c;
    blocked_range2d(R rb, R re, C cb, C ce) : r(rb, re), c(cb, ce) {}
    blocked_range2d(R rb, R re, size_t, C cb, C ce, size_t) : r(rb, re), c(cb, ce) {}
    const blocked_range<R>& rows() const { return r; }
    const blocked_range<C>& cols() const { return c; }
};
}
