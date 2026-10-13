// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the SMLib kernel and our wrapper when the kernel's source is there (scripts/fetch-smlib.sh puts it in a
// cache and prints the directory; SX_SMLIB_DIR points at it). Without it the crate builds a stand-in whose every
// call says so, which keeps `cargo build --workspace` free of the 980k line kernel. SX_BREP_REQUIRE=1 turns a
// missing kernel into a build error, for the jobs that test it.
use std::path::{Path, PathBuf};

const COMMIT: &str = "c9c5979f04cea8c38213004d4f04df0dcfb40d05";
// written by scripts/fetch-smlib.sh once swap-routines.sh has put our routines in the source
const READY: &str = ".ready-3";

fn kernel_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("SX_SMLIB_DIR") {
        let d = PathBuf::from(d);
        assert!(
            d.join(READY).exists(),
            "SX_SMLIB_DIR has no {READY}: use the directory packages/brep/scripts/fetch-smlib.sh prints"
        );
        return Some(d);
    }
    let cache = std::env::var_os("SX_SMLIB_CACHE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".cache")))
                .map(|c| c.join("slicerx").join("smlib"))
        })?;
    let d = cache.join(COMMIT);
    d.join(READY).exists().then_some(d)
}

fn main() {
    println!("cargo:rerun-if-env-changed=SX_SMLIB_DIR");
    println!("cargo:rerun-if-env-changed=SX_SMLIB_CACHE");
    println!("cargo:rerun-if-env-changed=SX_BREP_REQUIRE");
    println!("cargo:rerun-if-changed=cpp");
    println!("cargo:rerun-if-changed=scripts/swap-routines.sh");
    println!("cargo::rustc-check-cfg=cfg(sx_brep_kernel)");
    let dir = kernel_dir().filter(|d| d.join("source/SMLib/inc").is_dir());
    let Some(dir) = dir else {
        assert!(
            std::env::var("SX_BREP_REQUIRE").as_deref() != Ok("1"),
            "SX_BREP_REQUIRE=1 but the SMLib source is missing: run packages/brep/scripts/fetch-smlib.sh"
        );
        return;
    };
    let sm = dir.join("source/SMLib");
    let api = dir.join("source/SM_API");
    let sources = |d: &Path| {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d.join("src"))
            .expect("kernel sources")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "cpp"))
            // precompiled header stub, MSVC only
            .filter(|p| p.file_name().is_some_and(|n| n != "StdAfx.cpp"))
            .collect();
        v.sort();
        v
    };
    // two libraries, since the kernel and its C API each have a StdAfx.h that must come first on the include path;
    // the C API and our wrapper first, so the linker finds the kernel after them
    let build = |inc: [&Path; 2]| {
        let mut b = cc::Build::new();
        b.cpp(true)
            .std("c++17")
            .warnings(false)
            .opt_level(2)
            .include("cpp")
            .include(inc[0])
            .include(inc[1])
            .define("NDEBUG", None)
            .define("NOMINMAX", None)
            .define("SM_NO_DEBUG_CODE", None)
            .define("SM_NO_GFX_OUTPUT_CODE", None);
        if b.get_compiler().is_like_msvc() {
            b.flag("/bigobj")
                .flag("/utf-8")
                .define("_CRT_SECURE_NO_WARNINGS", None);
        }
        b
    };
    let (sm_inc, api_inc) = (sm.join("inc"), api.join("inc"));
    let mut api_build = build([&api_inc, &sm_inc]);
    api_build
        .define("SM_API_EXPORTS", None)
        .files(sources(&api))
        .file("cpp/sx_brep.cpp");
    // tests/routines.rs, with the routine-probe feature
    if std::env::var_os("CARGO_FEATURE_ROUTINE_PROBE").is_some() {
        api_build.file("cpp/routine_probe.cpp");
    }
    api_build.compile("sx_brep");
    // our versions of the routines swap-routines.sh takes out build with the kernel; integrator.cpp replaces the
    // kernel's SmIntegrator.cpp, which an unswapped kernel (as for recording the golden file) still has
    let mut smlib = build([&sm_inc, &api_inc]);
    // no debug info for the kernel: in a debug build its objects pass 4 GB, past MSVC's archive limit (LNK1248)
    smlib.debug(false).files(sources(&sm)).file("cpp/routines.cpp");
    if !sm.join("src/SmIntegrator.cpp").exists() {
        smlib.file("cpp/integrator.cpp");
    }
    smlib.compile("smlib");
    println!("cargo:rustc-cfg=sx_brep_kernel");
}
