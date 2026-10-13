// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
fn main() {
    // the edition's mimir cloud registration key (llm.rs) is read at compile time
    println!("cargo:rerun-if-env-changed=SX_MIMIR_REGISTER_KEY");
    tauri_build::build();
    test_manifest();
}

/// Lets the integration tests (tests/*.rs) start on Windows. tauri's dialogs import TaskDialogIndirect, which only
/// Common Controls 6 has, and Windows loads Common Controls 6 only for an executable whose manifest asks for it.
/// tauri_build embeds that manifest in the app binary alone, so without this a test executable is refused before it
/// runs (STATUS_ENTRYPOINT_NOT_FOUND). The linker embeds the same dependency in the test executables only; the app
/// binary is linked as before.
fn test_manifest() {
    let var = |name| std::env::var(name).unwrap_or_default();
    if var("CARGO_CFG_TARGET_OS") != "windows" || var("CARGO_CFG_TARGET_ENV") != "msvc" {
        return;
    }
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' \
         version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
