// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Parallel map over layers: rayon with the `parallel` feature, a plain loop
//! without it (WASM). Output order always matches input order.
//!
//! Rule for values worked out once (`OnceLock` and the like): never run parallel work in the initializer of
//! a value that a parallel job can reach. A thread that waits for its own parallel jobs picks up other jobs
//! meanwhile; when one of them waits for the same value, further up that thread's own stack, the pool hangs.
//! So every `OnceLock` in the core is initialized through [`Init`] (clippy rejects a plain `get_or_init`):
//! - [`Init::plan`] is for the whole-object plans whose initializer runs parallel work. Work them out
//!   before the parallel loops that read them. Debug builds panic when one is first planned inside a
//!   parallel job.
//! - [`Init::once`] is for everything else. Inside a parallel job its initializer runs these helpers as
//!   plain loops, so it can never wait on the pool.
//!
//! Hold no `Mutex` or `RwLock` guard across a call into these helpers either. The entry points that start
//! a slice run under [`slice`], so a slice started on a busy pool counts its own jobs only.

use std::sync::OnceLock;

#[cfg(feature = "parallel")]
mod depth {
    use std::cell::Cell;

    thread_local! {
        /// How many parallel jobs this thread is running (nested when it picks up work while waiting).
        static JOBS: Cell<u32> = const { Cell::new(0) };
        /// Above zero while an initializer reached from a parallel job runs: the helpers run as plain loops.
        static SERIAL: Cell<u32> = const { Cell::new(0) };
    }

    struct Count(&'static std::thread::LocalKey<Cell<u32>>);

    impl Count {
        fn enter(key: &'static std::thread::LocalKey<Cell<u32>>) -> Self {
            key.with(|c| c.set(c.get() + 1));
            Self(key)
        }
    }

    impl Drop for Count {
        fn drop(&mut self) {
            self.0.with(|c| c.set(c.get().saturating_sub(1)));
        }
    }

    /// Runs one item of a parallel map, counted as a job of this thread.
    pub(super) fn job<R>(f: impl FnOnce() -> R) -> R {
        let _c = Count::enter(&JOBS);
        f()
    }

    pub(super) fn in_job() -> bool {
        JOBS.with(Cell::get) > 0
    }

    pub(super) fn serial() -> bool {
        SERIAL.with(Cell::get) > 0
    }

    /// The shortest piece a parallel map splits into: the whole input, run in order on this thread with no
    /// join, inside an initializer reached from a parallel job; else one item.
    pub(super) fn min_len() -> usize {
        if serial() { usize::MAX } else { 1 }
    }

    /// Runs `f` with the helpers as plain loops on this thread.
    pub(super) fn serially<R>(f: impl FnOnce() -> R) -> R {
        let _c = Count::enter(&SERIAL);
        f()
    }

    /// Puts both counts back when a slice started with [`super::slice`] ends.
    struct Saved(u32, u32);

    impl Drop for Saved {
        fn drop(&mut self) {
            JOBS.with(|c| c.set(self.0));
            SERIAL.with(|c| c.set(self.1));
        }
    }

    pub(super) fn fresh<R>(f: impl FnOnce() -> R) -> R {
        let _saved = Saved(JOBS.with(|c| c.replace(0)), SERIAL.with(|c| c.replace(0)));
        f()
    }
}

#[cfg(not(feature = "parallel"))]
mod depth {
    pub(super) fn in_job() -> bool {
        false
    }

    pub(super) fn serially<R>(f: impl FnOnce() -> R) -> R {
        f()
    }

    pub(super) fn fresh<R>(f: impl FnOnce() -> R) -> R {
        f()
    }
}

/// Runs the start of a slice (building a session, the plans before the layer loop) as if no parallel job
/// were under it on this thread. Slices started on a thread pool (`ThreadPool::install`) are jobs of that
/// pool too: a pool thread waiting inside one slice's job can pick up another slice, whose plans belong to
/// that slice alone and are not reached from the first one's jobs.
pub(crate) fn slice<R>(f: impl FnOnce() -> R) -> R {
    depth::fresh(f)
}

/// Results that parallel jobs share by key, each worked out once: a job asking for an entry that another
/// job is working out waits for it instead of working it out again. The work runs the parallel helpers as
/// plain loops (as [`Init::once`] does inside a job), so a thread working an entry out never picks up
/// another job meanwhile and cannot come to wait on itself; jobs only wait on entries their own entry
/// needs, which never lead back to it.
pub(crate) struct Memo<K, V> {
    map: std::sync::Mutex<std::collections::HashMap<K, Option<V>>>,
    ready: std::sync::Condvar,
}

impl<K, V> Default for Memo<K, V> {
    fn default() -> Self {
        Self {
            map: std::sync::Mutex::new(std::collections::HashMap::new()),
            ready: std::sync::Condvar::new(),
        }
    }
}

impl<K: std::hash::Hash + Eq + Clone, V: Clone> Memo<K, V> {
    /// The entry for `key`, from `work` the first time it is asked for.
    pub(crate) fn get_or(&self, key: K, work: impl FnOnce() -> V) -> V {
        /// Takes the claim back when the work panics, so jobs waiting for it work the entry out themselves.
        struct Claim<'a, K: std::hash::Hash + Eq, V> {
            memo: &'a Memo<K, V>,
            key: Option<K>,
        }
        impl<K: std::hash::Hash + Eq, V> Drop for Claim<'_, K, V> {
            fn drop(&mut self) {
                if let Some(k) = self.key.take() {
                    self.memo.lock().remove(&k);
                    self.memo.ready.notify_all();
                }
            }
        }
        let mut g = self.lock();
        loop {
            match g.get(&key) {
                Some(Some(v)) => return v.clone(),
                Some(None) => {
                    g = self
                        .ready
                        .wait(g)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                None => break,
            }
        }
        g.insert(key.clone(), None);
        drop(g);
        let mut claim = Claim {
            memo: self,
            key: Some(key),
        };
        let v = depth::serially(work);
        if let Some(k) = claim.key.take() {
            self.lock().insert(k, Some(v.clone()));
            self.ready.notify_all();
        }
        v
    }
}

impl<K: std::hash::Hash + Eq, V> Memo<K, V> {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<K, Option<V>>> {
        self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// How the core initializes a `OnceLock` (the rule at the top of this module).
pub(crate) trait Init<T> {
    /// `get_or_init`, safe to reach from a parallel job: there `f` runs the parallel helpers as plain loops.
    fn once(&self, f: impl FnOnce() -> T) -> &T;

    /// [`Init::once`] for a whole-object plan whose initializer runs parallel work: plan it before the
    /// parallel loops that read it. Debug builds panic when it is first planned inside a parallel job;
    /// release builds plan it there with plain loops, slower but safe.
    fn plan(&self, f: impl FnOnce() -> T) -> &T;
}

impl<T> Init<T> for OnceLock<T> {
    #[allow(
        clippy::disallowed_methods,
        reason = "the one place that initializes a OnceLock"
    )]
    fn once(&self, f: impl FnOnce() -> T) -> &T {
        if let Some(v) = self.get() {
            return v;
        }
        if depth::in_job() {
            self.get_or_init(|| depth::serially(f))
        } else {
            self.get_or_init(f)
        }
    }

    fn plan(&self, f: impl FnOnce() -> T) -> &T {
        debug_assert!(
            self.get().is_some() || !depth::in_job(),
            "a whole-object plan was first worked out inside a parallel job; plan it before the parallel loop"
        );
        self.once(f)
    }
}

#[cfg(feature = "parallel")]
pub(crate) fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    items
        .par_iter()
        .with_min_len(depth::min_len())
        .with_max_len(1)
        .map(|x| depth::job(|| f(x)))
        .collect()
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    items.iter().map(f).collect()
}

/// [`map`] for many small items of even cost (triangles, vertices): the pool splits them into runs of at
/// least `FINE` items instead of one job per item.
#[cfg(feature = "parallel")]
pub(crate) fn map_fine<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    if depth::serial() || items.len() <= FINE {
        return items.iter().map(f).collect();
    }
    items
        .par_iter()
        .with_min_len(FINE)
        .map(|x| depth::job(|| f(x)))
        .collect()
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn map_fine<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    items.iter().map(f).collect()
}

/// The shortest run [`map_fine`] hands to one thread.
#[cfg(feature = "parallel")]
const FINE: usize = 4096;

#[cfg(feature = "parallel")]
pub(crate) fn map_range<R: Send>(range: std::ops::Range<u32>, f: impl Fn(u32) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    range
        .into_par_iter()
        .with_min_len(depth::min_len())
        .with_max_len(1)
        .map(|x| depth::job(|| f(x)))
        .collect()
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn map_range<R: Send>(range: std::ops::Range<u32>, f: impl Fn(u32) -> R + Sync + Send) -> Vec<R> {
    range.map(f).collect()
}

/// Runs `a` and `b`, in parallel when the pool has a free thread, and returns both results. Each side
/// counts as a parallel job, so a value first worked out inside one is worked out with plain loops.
#[cfg(feature = "parallel")]
pub(crate) fn join<A: Send, B: Send>(a: impl FnOnce() -> A + Send, b: impl FnOnce() -> B + Send) -> (A, B) {
    if depth::serial() {
        return (a(), b());
    }
    rayon::join(|| depth::job(a), || depth::job(b))
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn join<A: Send, B: Send>(a: impl FnOnce() -> A + Send, b: impl FnOnce() -> B + Send) -> (A, B) {
    (a(), b())
}

/// Runs two whole-object passes side by side, each as the start of a slice ([`slice`]): unlike [`join`],
/// either may plan values with parallel work. They must share no value worked out once that either of them
/// works out (a thread waiting in one pass picks up jobs of the other), so shared values are worked out
/// before the call.
#[cfg(feature = "parallel")]
pub(crate) fn join_plans<A: Send, B: Send>(
    a: impl FnOnce() -> A + Send,
    b: impl FnOnce() -> B + Send,
) -> (A, B) {
    if depth::serial() {
        return (a(), b());
    }
    rayon::join(|| depth::fresh(a), || depth::fresh(b))
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn join_plans<A: Send, B: Send>(
    a: impl FnOnce() -> A + Send,
    b: impl FnOnce() -> B + Send,
) -> (A, B) {
    (a(), b())
}

#[cfg(feature = "parallel")]
pub(crate) fn sort<T: Ord + Send>(v: &mut [T]) {
    use rayon::prelude::*;
    if depth::serial() {
        v.sort_unstable();
    } else {
        v.par_sort_unstable();
    }
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn sort<T: Ord + Send>(v: &mut [T]) {
    // The shared sort keeps one copy of the sorting code in the module; for a total order the result is the same.
    crate::sorting::sort_by(v, Ord::cmp);
}

#[cfg(feature = "parallel")]
pub(crate) fn map_owned<T: Send, R: Send>(items: Vec<T>, f: impl Fn(T) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    items
        .into_par_iter()
        .with_min_len(depth::min_len())
        .with_max_len(1)
        .map(|x| depth::job(|| f(x)))
        .collect()
}

#[cfg(not(feature = "parallel"))]
pub(crate) fn map_owned<T: Send, R: Send>(items: Vec<T>, f: impl Fn(T) -> R + Sync + Send) -> Vec<R> {
    items.into_iter().map(f).collect()
}

#[cfg(all(test, feature = "parallel"))]
mod tests {
    use super::Init as _;
    use std::sync::OnceLock;

    /// An initializer reached from a parallel job runs its parallel maps on its own thread, in order, so it
    /// never waits for pieces other threads took (while waiting, a thread takes other jobs, and one of
    /// them may wait for the same value further up its stack). With a plain `get_or_init` the other threads
    /// take pieces of this map.
    #[test]
    fn once_inside_a_job_runs_its_maps_on_its_own_thread() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .expect("pool");
        // Each item takes a little work and notes the thread it ran on.
        let item = |i: u32| {
            std::hint::black_box((0..5000u32).fold(0u32, |a, k| {
                a.wrapping_mul(31).wrapping_add(std::hint::black_box(k))
            }));
            (std::thread::current().id(), i)
        };
        let threads = |v: &[(std::thread::ThreadId, u32)]| {
            v.iter()
                .map(|t| t.0)
                .collect::<std::collections::HashSet<_>>()
                .len()
        };
        for _ in 0..20 {
            let shared: OnceLock<(std::thread::ThreadId, Vec<(std::thread::ThreadId, u32)>)> =
                OnceLock::new();
            let _ = pool.install(|| {
                // One job, so the other threads are free to take pieces of a parallel map.
                super::map_range(0..1, |_| {
                    shared
                        .once(|| (std::thread::current().id(), super::map_range(0..512, item)))
                        .1
                        .len()
                })
            });
            let (own, ran) = shared.get().expect("initialized");
            assert_eq!(threads(ran), 1);
            assert!(ran.iter().all(|t| t.0 == *own));
            assert!(ran.iter().enumerate().all(|(k, t)| t.1 as usize == k));
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "plan it before the parallel loop")]
    fn plan_first_worked_out_inside_a_job_panics_in_debug_builds() {
        let shared: OnceLock<u32> = OnceLock::new();
        let _ = super::map_range(0..4, |_| *shared.plan(|| 1));
    }
}
