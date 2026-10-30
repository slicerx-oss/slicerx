// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
#[path = "build-checks/step_reader.rs"]
mod step_reader;

fn main() {
    // the edition's mimir cloud registration key (llm.rs) is read at compile time
    println!("cargo:rerun-if-env-changed=SX_MIMIR_REGISTER_KEY");
    step_reader_resource();
    tauri_build::build();
    test_manifest();
}

/// Stops a `tauri build` (an installer, a `--debug` build or the bridge build) whose resources lack the STEP
/// reader (build-checks/step_reader.rs). A dev run (`tauri dev`, `cargo test`) loads the page from the dev server,
/// which serves the reader's own wasm, so it builds without the folder.
fn step_reader_resource() {
    let dir =
        std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join(step_reader::DIR);
    for f in step_reader::FILES {
        println!("cargo:rerun-if-changed={}", dir.join(f).display());
    }
    if tauri_build::is_dev() {
        return;
    }
    if let Err(message) = step_reader::check(&dir) {
        eprintln!("{message}");
        std::process::exit(1);
    }
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
