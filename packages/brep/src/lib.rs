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
//! | `primitive` | `type` (`box` with `sizeMm`; `cylinder` with `diameterMm`, `heightMm`; `cone` also `topDiameterMm`; `sphere` with `diameterMm`), `frame` (`origin`, `u`, `normal`; it stands on the origin) | `body` |
//! | `extrude` | `frame` (`origin`, `u`, `normal`), `polygons` (`outer`, `holes`: loops of `points` or `center` and `diameterMm`), `fromMm`, `toMm`; with `target` and `operation` (`join` or `cut`) it joins or cuts the target | `body`; with a target also `touches`, and no body when it misses, and `missed` (the polygons that left no face of their own in the result, by their place in `polygons`; empty when all did) |
//! | `boolean` | `op` (`union`, `difference`, `intersection`), `a`, `b` | `body` |
//! | `subtract` | `body`, `solids` (box or cylinder), `frame` (the body's, with the solids in world) | `body`, `missed` (the solids that left no face of their own in the result, by their place in `solids`; empty when all did) |
//! | `cut` | `body`, `plane` (`point`, `normal`) | `below`, `above` (a body, or null when empty) |
//! | `fillet` | `body`, `edges` (`a`, `b`, optional `center` for a round rim and `keys` of its two faces), `radiusMm` | `body` |
//! | `chamfer` | as `fillet`, with `distanceMm` (both faces set back by it; the faces must be flat and square) | `body` |
//! | `push` | `body`, `at` and `normal` (a flat face facing that way, under `at`; `faceKey` must name exactly one face), `distanceMm` (out joins, in cuts) | `body`, `faceKey`, `frame` and `polygons` (the face as `extrude` takes it), `reached` (a face is left where it moved to) |
//! | `hole` | `body`, `hole` (`entry`, `axis`, `diameterMm` as `hole.find` gives them; found again on the body), `spec` (`diameterMm`, optional `depthMm`, `counterbore` or `countersink`) | `body`, `hole` (as found: `entry`, `axis`, `diameterMm`, `depthMm`, `through`) |
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
//! later ops and saves where identity is unambiguous. Missing or split push references require repair;
//! unions clear keys on coplanar operand faces that may merge. A face's `surface` is sx-geom's: a plane facing out of
//! the solid, a cylinder, cone or sphere, or `other`.
//!
//! With the `typed` feature the kernel is also there as Rust values, beside the JSON call: a [`Body`] owns its solid
//! and frees it when dropped, a [`Face`] or an [`Edge`] borrows its body, and [`Body::tessellate`] gives a [`Mesh`]
//! with everything the kernel knows about its triangles. The calls go through a `cxx` bridge to the kernel's own
//! API. All of that feature's `unsafe` code is in one file, `src/kernel.rs`; the rest of it is safe Rust. Without
//! the kernel the types are still there and every way to make a body answers [`Error::NoKernel`].
//!
//! A typed body has its face keys too ([`Body::keys`], [`Body::set_keys`]), kept where the operations above keep
//! them. Until those operations are made over typed bodies, [`handover`] is how one of them works on a typed body:
//! the body is lent to the table for a call, and the body the call made is taken out of the table as a typed body.
//! `free` refuses a body that is only lent.

#[cfg(sx_brep_kernel)]
use std::ffi::c_char;
use std::ffi::{CStr, CString};
use std::sync::Mutex;

#[cfg(all(test, feature = "typed", sx_brep_kernel))]
mod against_json;
#[cfg(feature = "typed")]
mod body;
#[cfg(feature = "typed")]
mod error;
#[cfg(feature = "typed")]
pub mod handover;
#[cfg(all(feature = "typed", sx_brep_kernel))]
mod kernel;
#[cfg(all(feature = "typed", not(sx_brep_kernel)))]
#[path = "stand_in.rs"]
mod kernel;
#[cfg(feature = "typed")]
mod save;
#[cfg(all(test, feature = "typed"))]
mod saved;
#[cfg(feature = "typed")]
mod stitch;
#[cfg(feature = "typed")]
mod tess;
#[cfg(feature = "typed")]
mod values;

#[cfg(feature = "typed")]
pub use body::{Body, Curve, Edge, FLAT_KIND_MM, Face, Frame, Surface};
#[cfg(feature = "typed")]
pub use error::{Error, FailedFace, Stage};
#[cfg(feature = "typed")]
pub use stitch::{Path, Sheet, skin_ends};
#[cfg(feature = "typed")]
pub use tess::{Mesh, MeshEdge, Tessellation};

/// Whether this build has the kernel (its source was there when it was built).
pub const KERNEL: bool = cfg!(sx_brep_kernel);

#[cfg(sx_brep_kernel)]
unsafe extern "C" {
    fn sx_brep_call(op: *const c_char, request: *const c_char) -> *mut c_char;
    fn sx_brep_free(reply: *mut c_char);
}

// the kernel's bodies and context are one shared table
static LOCK: Mutex<()> = Mutex::new(());

/// Takes the kernel for one caller, the same lock `call` takes: the typed calls and the JSON ones never run in the
/// kernel at once.
#[cfg(all(feature = "typed", sx_brep_kernel))]
pub(crate) fn hold() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Runs one operation. `Ok` holds the JSON reply; `Err` the message of a failed one.
pub fn call(op: &str, request: &str) -> Result<String, String> {
    if op.len() > 128 {
        return Err("op: exceeds 128 bytes".into());
    }
    if request.len() > 32 * 1024 * 1024 {
        return Err("request: exceeds 32 MiB".into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    // one thread holds the kernel; a second that calls in, by JSON and by a typed call, gets nowhere until the first
    // lets go
    #[test]
    fn two_threads_cannot_be_in_the_kernel_at_once() {
        static THROUGH: AtomicBool = AtomicBool::new(false);
        let (held, is_held) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _kernel = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            held.send(()).expect("the test is waiting");
            released.recv().expect("the test lets go");
        });
        is_held.recv().expect("the holder took the kernel");
        let (done, is_done) = mpsc::channel();
        let caller = std::thread::spawn(move || {
            let counted = call("count", "{}");
            #[cfg(feature = "typed")]
            let made = Body::cuboid([0.0; 3], [1.0; 3]).map(|_| ());
            THROUGH.store(true, Ordering::SeqCst);
            #[cfg(feature = "typed")]
            assert_eq!(made.is_ok(), KERNEL, "{made:?}");
            assert_eq!(counted.is_ok(), KERNEL, "{counted:?}");
            done.send(()).expect("the test is waiting");
        });
        assert_eq!(
            is_done.recv_timeout(Duration::from_millis(500)),
            Err(mpsc::RecvTimeoutError::Timeout),
            "a call went into the kernel while another thread held it"
        );
        assert!(!THROUGH.load(Ordering::SeqCst));
        release.send(()).expect("the holder is waiting");
        is_done
            .recv_timeout(Duration::from_secs(60))
            .expect("the call goes through once the kernel is free");
        holder.join().expect("holder");
        caller.join().expect("caller");
    }
}
