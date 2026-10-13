// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stands in for oneTBB's parallel_for and task_arena: the loops run in order on the calling thread.
#pragma once
namespace tbb {
struct task_arena {
    template <class F> void execute(F&& f) { f(); }
};
template <class I, class F> void parallel_for(I first, I last, const F& f)
{
    for (I i = first; i < last; ++i) f(i);
}
template <class R, class F> void parallel_for(const R& r, const F& f) { f(r); }
}
