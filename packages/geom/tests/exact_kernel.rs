// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine says which kernel this build holds, in every build: none without brep, the stand-in when the kernel's
// source was not there, and the real kernel, at its pinned commit, only when a call only the kernel answers goes
// through.
use serde_json::{Value, json};

fn kernel() -> Value {
    serde_json::from_str(&sx_geom::json::call("exact.kernel", "{}").expect("an answer in every build"))
        .expect("JSON")
}

#[test]
fn the_engine_says_which_kernel_it_holds() {
    assert!(sx_geom::json::operations().contains(&"exact.kernel"));
    let reply = kernel();
    #[cfg(not(feature = "brep"))]
    assert_eq!(reply, json!({ "kernel": "none" }));
    #[cfg(feature = "brep")]
    if sx_brep::KERNEL {
        assert_eq!(
            reply,
            json!({ "kernel": "real", "commit": sx_brep::KERNEL_COMMIT })
        );
    } else {
        assert_eq!(reply, json!({ "kernel": "stand-in" }));
    }
    if cfg!(feature = "brep") && std::env::var("SX_BREP_REQUIRE").as_deref() == Ok("1") {
        assert_eq!(
            reply["kernel"], "real",
            "SX_BREP_REQUIRE=1 must answer from the real kernel"
        );
    }
}

/// The commit a real kernel answers with is the one build.rs builds, not a copy of it.
#[cfg(feature = "brep")]
#[test]
fn the_commit_is_the_one_the_build_pins() {
    let build =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../brep/build.rs")).expect("build.rs");
    let pinned = build
        .lines()
        .find_map(|l| l.strip_prefix("const COMMIT: &str = \"")?.strip_suffix("\";"))
        .expect("the pinned commit in build.rs");
    assert_eq!(sx_brep::KERNEL_COMMIT, pinned);
    assert_eq!(pinned.len(), 40);
    assert!(pinned.bytes().all(|b| b.is_ascii_hexdigit()));
}
