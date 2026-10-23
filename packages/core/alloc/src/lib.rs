// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The memory allocator of the sx command line tool and the cloud service: jemalloc wherever it builds (not MSVC, not
//! wasm32), with its page decay set per operating system. A binary links it with `use sx_alloc as _;`. Elsewhere the
//! crate is empty and the system allocator stays.
#![cfg(all(not(target_env = "msvc"), not(target_arch = "wasm32")))]

use std::ffi::{CStr, c_char};

#[global_allocator]
static ALLOC: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// The page decay: how long freed pages stay mapped before jemalloc returns them to the system. 0 returns them at once,
/// which gives the lowest peak memory. On macOS that costs no clear time (-1.9% to +3.0% wall against the system
/// allocator). On Linux `x86_64` it cost 16% to 19% wall, all of it system time spent returning pages, so Linux waits
/// 100 ms, which still holds far less than the system allocator.
#[cfg(target_os = "linux")]
const CONF: &CStr = c"dirty_decay_ms:100,muzzy_decay_ms:0";
#[cfg(not(target_os = "linux"))]
const CONF: &CStr = c"dirty_decay_ms:0,muzzy_decay_ms:0";

/// jemalloc reads its options from this C string once, when it starts (before `main`). It reads the
/// `_RJEM_MALLOC_CONF` environment variable after it, so an option set there wins. tikv-jemalloc-sys builds jemalloc
/// with the `_rjem_` prefix, hence the name; jemalloc's own definition is weak, so this one takes its place.
#[allow(unsafe_code)]
// SAFETY: the symbol has the type jemalloc declares (`const char *`, nullable) and points at a NUL-terminated string
// with a static lifetime that nothing writes to.
#[unsafe(export_name = "_rjem_malloc_conf")]
static MALLOC_CONF: Option<&c_char> = Some(
    // SAFETY: a C string literal is a valid, static, NUL-terminated string, so its first byte can be borrowed.
    unsafe { &*CONF.as_ptr() },
);
