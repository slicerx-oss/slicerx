// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `libslicerx`: the C ABI over `sx_core::api` (header: `include/slicerx.h`).
//!
//! Everything crosses as UTF-8 JSON, byte buffers and opaque handles; no Rust
//! type is visible from C. Load meshes with `sx_mesh_load`, pass their ids as
//! the `mesh` values of a `SliceRequest` JSON to `sx_slice`, and read the
//! result JSON, G-code and SXPV preview from the returned handle. Every
//! buffer the library returns is freed with `sx_buffer_free`, every result
//! with `sx_result_free`. On failure a function returns 0 or NULL and
//! `sx_last_error` describes why. All functions are thread-safe.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use sx_core::api;

/// ABI version; bumped on any breaking change to this header.
pub const SX_ABI_VERSION: u32 = 1;

/// Bytes owned by the library. Free with `sx_buffer_free`.
#[repr(C)]
pub struct SxBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

/// A finished slice: result JSON, G-code and SXPV preview.
pub struct SxResult {
    json: Vec<u8>,
    gcode: Vec<u8>,
    preview: Vec<u8>,
}

#[allow(
    clippy::disallowed_methods,
    reason = "an empty map: no parallel work starts in it"
)]
fn meshes() -> &'static Mutex<HashMap<u64, Arc<api::Mesh>>> {
    static MESHES: OnceLock<Mutex<HashMap<u64, Arc<api::Mesh>>>> = OnceLock::new();
    MESHES.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_MESH: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static LAST_ERROR: RefCell<Option<CString>> = const { RefCell::new(None) };
}

fn set_error(msg: &str) {
    let clean = msg.replace('\0', " ");
    LAST_ERROR.with(|e| *e.borrow_mut() = CString::new(clean).ok());
}

fn clear_error() {
    LAST_ERROR.with(|e| *e.borrow_mut() = None);
}

fn to_buffer(bytes: &[u8]) -> SxBuffer {
    let boxed: Box<[u8]> = bytes.into();
    let len = boxed.len();
    let ptr = Box::into_raw(boxed).cast::<u8>();
    SxBuffer { ptr, len }
}

/// The ABI version this library implements (`SX_ABI_VERSION`).
#[unsafe(no_mangle)]
pub extern "C" fn sx_abi_version() -> u32 {
    SX_ABI_VERSION
}

/// Loads a model from `len` bytes at `data`; `file_name` (UTF-8, may be NULL)
/// picks the format by extension. Returns a mesh id, or 0 on error.
///
/// # Safety
///
/// `data` must point to `len` readable bytes, and `file_name` must be NULL or
/// a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_mesh_load(data: *const u8, len: usize, file_name: *const c_char) -> u64 {
    clear_error();
    if data.is_null() {
        set_error("sx_mesh_load: data is NULL");
        return 0;
    }
    // SAFETY: the caller guarantees `data` points to `len` readable bytes.
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let name = if file_name.is_null() {
        String::new()
    } else {
        // SAFETY: the caller guarantees a NUL-terminated string.
        unsafe { CStr::from_ptr(file_name) }
            .to_string_lossy()
            .into_owned()
    };
    match api::load_mesh(bytes, &name) {
        Ok(mesh) => {
            let id = NEXT_MESH.fetch_add(1, Ordering::Relaxed);
            match meshes().lock() {
                Ok(mut m) => {
                    m.insert(id, Arc::new(mesh));
                    id
                }
                Err(_) => {
                    set_error("mesh registry is poisoned");
                    0
                }
            }
        }
        Err(e) => {
            set_error(&e.to_string());
            0
        }
    }
}

/// Forgets a mesh. Results that used it stay valid.
#[unsafe(no_mangle)]
pub extern "C" fn sx_mesh_free(mesh: u64) {
    if let Ok(mut m) = meshes().lock() {
        m.remove(&mesh);
    }
}

/// Slices a `SliceRequest` JSON (`sx schema request`). Object `mesh` values
/// are ids from `sx_mesh_load`, as numbers or strings. Returns a result
/// handle, or NULL on error.
///
/// # Safety
///
/// `request_json` must be a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_slice(request_json: *const c_char) -> *mut SxResult {
    clear_error();
    if request_json.is_null() {
        set_error("sx_slice: request is NULL");
        return std::ptr::null_mut();
    }
    // SAFETY: the caller guarantees a NUL-terminated string.
    let text = unsafe { CStr::from_ptr(request_json) }.to_string_lossy();
    let req: api::SliceRequest = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(e) => {
            set_error(&format!("request: {e}"));
            return std::ptr::null_mut();
        }
    };
    let resolve = |id: &str| -> api::Result<Arc<api::Mesh>> {
        let key: u64 = id.trim().parse().map_err(|_| api::Error::Mesh {
            name: id.to_owned(),
            reason: "not a mesh id from sx_mesh_load".to_owned(),
        })?;
        meshes()
            .lock()
            .ok()
            .and_then(|m| m.get(&key).cloned())
            .ok_or_else(|| api::Error::Mesh {
                name: id.to_owned(),
                reason: "unknown mesh id".to_owned(),
            })
    };
    let run = match api::run_request(&req, &resolve) {
        Ok(r) => r,
        Err(e) => {
            set_error(&e.to_string());
            return std::ptr::null_mut();
        }
    };
    let json = match serde_json::to_vec(&run.report) {
        Ok(j) => j,
        Err(e) => {
            set_error(&e.to_string());
            return std::ptr::null_mut();
        }
    };
    Box::into_raw(Box::new(SxResult {
        json,
        gcode: run.gcode,
        preview: run.preview,
    }))
}

/// # Safety
///
/// `r` must be NULL or a live handle from `sx_slice`.
unsafe fn with_result(r: *const SxResult, f: impl Fn(&SxResult) -> &[u8]) -> SxBuffer {
    if r.is_null() {
        set_error("result is NULL");
        return SxBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        };
    }
    // SAFETY: non-NULL result pointers come from sx_slice and stay valid
    // until sx_result_free, which the caller has not called yet.
    let result = unsafe { &*r };
    to_buffer(f(result))
}

/// The result JSON (`sx schema result`), UTF-8, not NUL-terminated.
///
/// # Safety
///
/// `result` must be NULL or a live handle from `sx_slice`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_result_json(result: *const SxResult) -> SxBuffer {
    // SAFETY: forwarded from this function's contract.
    unsafe { with_result(result, |r| &r.json) }
}

/// The G-code.
///
/// # Safety
///
/// `result` must be NULL or a live handle from `sx_slice`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_result_gcode(result: *const SxResult) -> SxBuffer {
    // SAFETY: forwarded from this function's contract.
    unsafe { with_result(result, |r| &r.gcode) }
}

/// The SXPV preview buffers.
///
/// # Safety
///
/// `result` must be NULL or a live handle from `sx_slice`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_result_preview(result: *const SxResult) -> SxBuffer {
    // SAFETY: forwarded from this function's contract.
    unsafe { with_result(result, |r| &r.preview) }
}

/// Frees a buffer returned by this library. NULL buffers are ignored.
///
/// # Safety
///
/// `buffer` must come from this library and not be freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_buffer_free(buffer: SxBuffer) {
    if buffer.ptr.is_null() {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(buffer.ptr, buffer.len);
    // SAFETY: the pointer and length came from `to_buffer`, which leaked a
    // `Box<[u8]>` of exactly this length, and the caller frees it once.
    drop(unsafe { Box::from_raw(slice) });
}

/// Frees a result. NULL is ignored.
///
/// # Safety
///
/// `result` must be NULL or a handle from `sx_slice` not freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sx_result_free(result: *mut SxResult) {
    if result.is_null() {
        return;
    }
    // SAFETY: the pointer came from `Box::into_raw` in sx_slice and the
    // caller frees it once.
    drop(unsafe { Box::from_raw(result) });
}

/// The last error on this thread, or NULL. Valid until the next call into
/// the library on the same thread.
#[unsafe(no_mangle)]
pub extern "C" fn sx_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ref().map_or(std::ptr::null(), |s| s.as_ptr()))
}
