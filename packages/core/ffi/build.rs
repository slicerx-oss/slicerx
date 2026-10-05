// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Regenerates include/slicerx.h from the exported functions. CI diffs the
//! header so an ABI change never slips in unnoticed.

fn main() {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned());
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");
    let config = cbindgen::Config::from_file(format!("{dir}/cbindgen.toml")).unwrap_or_default();
    match cbindgen::Builder::new()
        .with_crate(&dir)
        .with_config(config)
        .generate()
    {
        Ok(bindings) => {
            bindings.write_to_file(format!("{dir}/include/slicerx.h"));
        }
        Err(e) => println!("cargo:warning=cbindgen: {e}"),
    }
}
