// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Exact solids for the modeling tools: the `SMLib` kernel (NVIDIA usd-brep, Apache-2.0) and our wrapper
//! (`cpp/sx_brep.cpp`) behind one JSON call. Bodies stay in the kernel, named by number, until freed; `tessellate`
//! turns one into the welded triangle mesh the rest of `SlicerX` uses, each triangle labeled with its face.
//!
//! Operations (requests and replies are JSON objects, sizes in millimeters):
//!
//! | op | request | reply |
//! | --- | --- | --- |
//! | `box` | `min`, `max` | `body` |
//! | `cylinder` | `origin`, `axis`, `diameterMm`, `heightMm` | `body` |
//! | `extrude` | `frame` (`origin`, `u`, `normal`), `polygons` (`outer`, `holes`: loops of `points` or `center` and `diameterMm`), `fromMm`, `toMm` | `body` |
//! | `boolean` | `op` (`union`, `difference`, `intersection`), `a`, `b` | `body` |
//! | `subtract` | `body`, `solids` (box or cylinder), `frame` (the body's, with the solids in world) | `body` |
//! | `cut` | `body`, `plane` (`point`, `normal`) | `below`, `above` (a body, or null when empty) |
//! | `fillet` | `body`, `edges` (`a`, `b`, optional `center` for a round rim and `keys` of its two faces), `radiusMm` | `body` |
//! | `chamfer` | as `fillet`, with `distanceMm` (both faces set back by it; the faces must be flat and square) | `body` |
//! | `info` | `body` | `manifold`, `volumeMm3`, `bounds`, `faces`, `faceTypes` |
//! | `tessellate` | `body`, `chordMm` (0.01), `angleDeg` (15) | `positions`, `indices`, `faceIds`, `faces` (`id`, `type`, `surface`, `key`) |
//! | `save` | `body` | `smb` (the body as `SMLib` text) |
//! | `load` | `body` (`{"smb"}`) | `body` |
//! | `free` | `body` | `freed` |
//! | `count` | | `bodies` |
//!
//! Ops that change a body make a new one and leave their inputs as they were. Wherever a request names a body it
//! can instead carry one, `{"smb": text}` from an earlier `save`, which lasts for that call only; and `"save": true`
//! adds each new body's text to the reply (`bodySmb`, `belowSmb`, `aboveSmb`). So a caller that starts a new
//! process per call keeps its bodies as text between calls, and a project can store them. The text ends in a hash
//! of itself; anything without a matching one is refused before the kernel reads it.
//! `"withKeys": true` adds each new body's face keys in face order (`bodyKeys`, `belowKeys`, `aboveKeys`), for a
//! caller that keeps bodies by number and tessellates only when it needs the mesh.
//!
//! A request with `keySalt` (a history step's, the same in every replay of it) gives each face of the bodies it makes
//! a key, numbered in the order the call makes them as sx-geom numbers a step's meshes. Faces keep their keys through
//! later ops and saves, so a replay finds the same face again. A face's `surface` is sx-geom's: a plane facing out of
//! the solid, a cylinder, cone or sphere, or `other`.

#[cfg(sx_brep_kernel)]
use std::ffi::c_char;
use std::ffi::{CStr, CString};
use std::sync::Mutex;

/// Whether this build has the kernel (its source was there when it was built).
pub const KERNEL: bool = cfg!(sx_brep_kernel);

#[cfg(sx_brep_kernel)]
unsafe extern "C" {
    fn sx_brep_call(op: *const c_char, request: *const c_char) -> *mut c_char;
    fn sx_brep_free(reply: *mut c_char);
}

// the kernel's bodies and context are one shared table
static LOCK: Mutex<()> = Mutex::new(());

/// Runs one operation. `Ok` holds the JSON reply; `Err` the message of a failed one.
pub fn call(op: &str, request: &str) -> Result<String, String> {
    let (Ok(op), Ok(request)) = (CString::new(op), CString::new(request)) else {
        return Err("request: contains a NUL byte".into());
    };
    let reply = raw_call(&op, &request)?;
    // replies sort their keys, so a failure starts with its error
    if reply.starts_with("{\"error\":") {
        let v: serde_json::Value =
            serde_json::from_str(&reply).map_err(|e| format!("kernel: bad reply: {e}"))?;
        return Err(v["error"]
            .as_str()
            .unwrap_or("kernel: the operation failed")
            .to_owned());
    }
    Ok(reply)
}

#[cfg(sx_brep_kernel)]
fn raw_call(op: &CStr, request: &CStr) -> Result<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // SAFETY: both pointers are valid NUL-terminated strings for the call; the lock keeps it to one caller.
    let p = unsafe { sx_brep_call(op.as_ptr(), request.as_ptr()) };
    if p.is_null() {
        return Err("kernel: out of memory".into());
    }
    // SAFETY: the wrapper returns a NUL-terminated string it allocated, freed below with its own free.
    let reply = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: p came from sx_brep_call and is freed once.
    unsafe { sx_brep_free(p) };
    Ok(reply)
}

#[cfg(all(sx_brep_kernel, feature = "routine-probe"))]
unsafe extern "C" {
    fn sx_brep_routine_probe() -> *mut c_char;
}

/// Runs the kernel routines `scripts/swap-routines.sh` replaced, and kernel code that calls them, on fixed inputs
/// (`cpp/routine_probe.cpp`). The JSON maps each case to its numbers.
#[cfg(all(sx_brep_kernel, feature = "routine-probe"))]
pub fn routine_probe() -> Result<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // SAFETY: no arguments; the lock keeps the kernel to one caller.
    let p = unsafe { sx_brep_routine_probe() };
    if p.is_null() {
        return Err("kernel: out of memory".into());
    }
    // SAFETY: a NUL-terminated string the wrapper allocated, freed below with its own free.
    let reply = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: p came from the probe and is freed once.
    unsafe { sx_brep_free(p) };
    Ok(reply)
}

#[cfg(all(not(sx_brep_kernel), feature = "routine-probe"))]
pub fn routine_probe() -> Result<String, String> {
    Err("this build has no B-rep kernel".into())
}

#[cfg(not(sx_brep_kernel))]
fn raw_call(_op: &CStr, _request: &CStr) -> Result<String, String> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Err("this build has no B-rep kernel (packages/brep/scripts/fetch-smlib.sh, then build again)".into())
}
