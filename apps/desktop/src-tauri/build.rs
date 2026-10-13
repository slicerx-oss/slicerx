// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
fn main() {
    // the edition's mimir cloud registration key (llm.rs) is read at compile time
    println!("cargo:rerun-if-env-changed=SX_MIMIR_REGISTER_KEY");
    tauri_build::build();
}
