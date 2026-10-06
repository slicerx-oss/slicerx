// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-geom-wasm: `sx_geom::json::call` for a browser Web Worker.
//!
//! The same plain C ABI as `sx-wasm`, so the build needs only cargo. JS asks
//! for the input buffer with `geom_input(len)`, writes the operation name, a
//! zero byte and the request JSON into linear memory, then calls `geom_call`.
//! On success (0) the response JSON is at `geom_out_ptr` and `geom_out_len`;
//! otherwise (1) the message is at `geom_error_ptr` and `geom_error_len`. The
//! operation names are `sx_geom::json::operations()`, the ones this build has, listed by `geom_ops`.
//! Meshes travel in the flat form (`positions`, `indices`) or as base64 STL;
//! there is no file access, so `stlPath` requests fail. No unsafe code: the
//! only unsafe item is the `no_mangle` export attribute.

use std::cell::RefCell;

#[derive(Default)]
struct State {
    input: Vec<u8>,
    out: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn ptr(v: &[u8]) -> u32 {
    // wasm32 addresses are 32 bits.
    u32::try_from(v.as_ptr() as usize).unwrap_or(0)
}

fn len(v: &[u8]) -> u32 {
    u32::try_from(v.len()).unwrap_or(0)
}

/// Resizes the input buffer to `len` bytes and returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn geom_input(len: u32) -> u32 {
    with(|s| {
        s.input.clear();
        s.input.resize(len as usize, 0);
        ptr(&s.input)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn geom_out_ptr() -> u32 {
    with(|s| ptr(&s.out))
}

#[unsafe(no_mangle)]
pub extern "C" fn geom_out_len() -> u32 {
    with(|s| len(&s.out))
}

#[unsafe(no_mangle)]
pub extern "C" fn geom_error_ptr() -> u32 {
    with(|s| ptr(&s.error))
}

#[unsafe(no_mangle)]
pub extern "C" fn geom_error_len() -> u32 {
    with(|s| len(&s.error))
}

/// Runs the operation in the input buffer (name, a zero byte, request JSON).
/// Returns 0 on success, 1 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn geom_call() -> u32 {
    let result = with(|s| {
        let split = s
            .input
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| "missing operation name".to_owned())?;
        let op = String::from_utf8_lossy(s.input.get(..split).unwrap_or(&[])).into_owned();
        let req = String::from_utf8_lossy(s.input.get(split + 1..).unwrap_or(&[])).into_owned();
        sx_geom::json::call(&op, &req).map_err(|e| sx_geom::json::error_value(&e).to_string())
    });
    with(|s| match result {
        Ok(out) => {
            s.out = out.into_bytes();
            s.error.clear();
            0
        }
        Err(e) => {
            s.out.clear();
            s.error = e.into_bytes();
            1
        }
    })
}

/// Writes the operation names as a JSON array to the output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn geom_ops() -> u32 {
    with(|s| {
        s.out = format!(
            "[{}]",
            sx_geom::json::operations()
                .iter()
                .map(|o| format!("\"{o}\""))
                .collect::<Vec<_>>()
                .join(",")
        )
        .into_bytes();
        s.error.clear();
    });
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, req: &str) -> (u32, String) {
        let bytes = [op.as_bytes(), &[0], req.as_bytes()].concat();
        geom_input(u32::try_from(bytes.len()).unwrap());
        with(|s| s.input.copy_from_slice(&bytes));
        let code = geom_call();
        let text =
            with(|s| String::from_utf8(if code == 0 { s.out.clone() } else { s.error.clone() }).unwrap());
        (code, text)
    }

    #[test]
    fn calls_an_operation_and_reports_errors() {
        let cube = r#"{"positions":[0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1],
            "indices":[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]}"#;
        let (code, out) = call("info", &format!("{{\"mesh\":{cube}}}"));
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("\"watertight\":true"));
        let (code, out) = call(
            "build",
            r#"{"solids":[{"type":"box","min":[0,0,0],"max":[10,10,5]}]}"#,
        );
        assert_eq!(code, 0, "{out}");
        let (code, err) = call("nope", "{}");
        assert_eq!(code, 1);
        assert!(err.contains("unknown operation"), "{err}");
        assert_eq!(call("info", "{}").0, 1);
        assert_eq!(geom_call_missing_name(), 1);
        assert_eq!(geom_ops(), 0);
        assert!(with(|s| String::from_utf8(s.out.clone()).unwrap()).contains("\"subtract\""));
    }

    fn geom_call_missing_name() -> u32 {
        geom_input(3);
        with(|s| s.input.copy_from_slice(b"abc"));
        geom_call()
    }
}
