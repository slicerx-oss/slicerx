// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! exact bodies the engine holds by number, and their triangles out of the engine
//!
//! every exact body is in this table until it is freed: the ones the engine's own exact ops make, and the ones the
//! older solid operations make, which are taken out of their table as soon as they are made. the table is per
//! thread, as a body cannot leave the thread that made it.

use crate::error::{Error, Measure, Result, TooDetailed};
use crate::faces::Surface as Kind;
use crate::json::OutFile;
use crate::mesh::TriMesh;
use crate::normals;
use crate::vec3::{self, V3};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use sx_brep::{Body, Curve, Face, Frame, Mesh, Surface, Tessellation};

/// A body in the table, with the key of each of its faces in face order (none at all for a body without keys). The
/// keys are the ones on the kernel's faces, read once when the body is held; nothing changes a held body. `from` is
/// the key of the face each face came from when a join cleared its own (none at all when no face has one).
pub struct Held {
    pub body: Body,
    pub keys: Vec<u64>,
    pub from: Vec<u64>,
}

// the next number, for every thread's table: one is never given out twice in a process
static NEXT: AtomicU64 = AtomicU64::new(1);

/// A held body's mesh at one chord and angle, and which of its faces are sorted as flat; `tessellate` answers from it.
struct Shown {
    mesh: Mesh,
    flat: Vec<bool>,
}

impl Shown {
    /// the bytes its lists hold
    fn bytes(&self) -> usize {
        let m = &self.mesh;
        let points: usize = m.edges.iter().map(|e| size_of_val(e.points.as_slice())).sum();
        size_of_val(m.positions.as_slice())
            + size_of_val(m.triangles.as_slice())
            + size_of_val(m.faces.as_slice())
            + size_of_val(m.normals.as_slice())
            + size_of_val(m.surfaces.as_slice())
            + size_of_val(m.edges.as_slice())
            + points
            + size_of_val(self.flat.as_slice())
    }
}

/// The most bytes of meshes a thread keeps (256 MiB); past it the one asked for longest ago is dropped and made again.
pub const MESH_BYTES: usize = 256 << 20;

/// a kept mesh: the body's number, chord and angle bits, the mesh, and its bytes
type KeptMesh = ((u32, u64, u64), Rc<Shown>, usize);

thread_local! {
    static TABLE: RefCell<BTreeMap<u32, Rc<Held>>> = const { RefCell::new(BTreeMap::new()) };
    // the one asked for last at the end
    static MESHES: RefCell<Vec<KeptMesh>> = const { RefCell::new(Vec::new()) };
    static MESH_CAP: Cell<usize> = const { Cell::new(MESH_BYTES) };
    static TESSELLATED: Cell<u64> = const { Cell::new(0) };
}

/// How many meshes this thread's `tessellate` has asked the kernel for.
#[doc(hidden)]
#[must_use]
pub fn tessellated() -> u64 {
    TESSELLATED.get()
}

/// The triangles and bytes of the meshes this thread keeps.
#[doc(hidden)]
#[must_use]
pub fn kept_meshes() -> (usize, usize) {
    MESHES.with(|m| {
        m.borrow().iter().fold((0, 0), |(t, b), (_, shown, bytes)| {
            (t + shown.mesh.triangles.len(), b + bytes)
        })
    })
}

/// Sets the most bytes of meshes this thread keeps, [`MESH_BYTES`] until set, and drops what no longer fits.
#[doc(hidden)]
pub fn keep_mesh_bytes(cap: usize) {
    MESH_CAP.set(cap);
    MESHES.with(|m| trim(&mut m.borrow_mut(), 0));
}

/// drops the meshes asked for longest ago until `room` more bytes fit under the cap
fn trim(meshes: &mut Vec<KeptMesh>, room: usize) {
    let over = meshes
        .iter()
        .map(|kept| kept.2)
        .sum::<usize>()
        .saturating_add(room)
        .saturating_sub(MESH_CAP.get());
    let mut freed = 0;
    let n = meshes
        .iter()
        .take_while(|kept| {
            let take = freed < over;
            freed += kept.2;
            take
        })
        .count();
    meshes.drain(..n);
}

fn kernel(e: &sx_brep::Error) -> Error {
    Error::geometry("brep", e.to_string())
}

/// Puts a body in the table under the next number.
fn keep(body: Body, keys: Vec<u64>, from: Vec<u64>) -> Result<u32> {
    let n = u32::try_from(NEXT.fetch_add(1, Ordering::Relaxed))
        .map_err(|_| Error::geometry("brep", "no body numbers are left in this process"))?;
    TABLE.with(|t| t.borrow_mut().insert(n, Rc::new(Held { body, keys, from })));
    Ok(n)
}

/// Keeps a body and returns its number. `keys` are written on the kernel's faces, where the older operations read
/// them and carry them to what they make. Refused, and the body dropped, when `keys` is neither empty nor one per
/// face.
pub fn hold(mut body: Body, keys: Vec<u64>) -> Result<u32> {
    if !keys.is_empty() {
        if keys.len() != body.faces().map_err(|e| kernel(&e))?.len() {
            return Err(Error::invalid(
                "keys",
                "must be one for each face of the body, or none",
            ));
        }
        body.set_keys(&keys).map_err(|e| kernel(&e))?;
    }
    keep(body, keys, Vec::new())
}

fn get(handle: u32) -> Option<Rc<Held>> {
    TABLE.with(|t| t.borrow().get(&handle).cloned())
}

/// Runs `f` on a held body, or returns none for a number that is not held. `f` may hold and free bodies, this one
/// too: it stays alive until `f` returns.
pub fn with<R>(handle: u32, f: impl FnOnce(&Held) -> R) -> Option<R> {
    get(handle).map(|held| f(&held))
}

/// Drops a held body. False for a number that is not held.
pub fn free(handle: u32) -> bool {
    // dropped after the table is let go: freeing a body goes into the kernel
    let gone = TABLE.with(|t| t.borrow_mut().remove(&handle));
    MESHES.with(|m| m.borrow_mut().retain(|(key, ..)| key.0 != handle));
    gone.is_some()
}

/// How many bodies this thread holds.
#[must_use]
pub fn count() -> usize {
    TABLE.with(|t| t.borrow().len())
}

/// the request fields that name a body
const BODY_FIELDS: [&str; 4] = ["body", "target", "a", "b"];
/// the reply fields that name a body an operation made
const MADE_FIELDS: [&str; 3] = ["body", "below", "above"];

/// the number a field names a body by, when it names one by number
fn number(req: &Value, field: &str) -> Option<f64> {
    req.get(field).and_then(Value::as_f64)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole number from 0 to the largest u32"
)]
fn handle_of(n: f64) -> Option<u32> {
    (n.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&n)).then_some(n as u32)
}

fn held(n: f64) -> Option<Rc<Held>> {
    handle_of(n).and_then(get)
}

fn no_such_body(field: &str) -> Error {
    Error::geometry(
        "brep",
        format!("{field}: no such body (freed, or from an earlier session)"),
    )
}

/// One of the older operations, called as it is.
fn older(op: &str, req: &Value) -> Result<Value> {
    let reply = sx_brep::call(op, &req.to_string()).map_err(|e| Error::geometry("brep", e))?;
    serde_json::from_str(&reply).map_err(|e| Error::Json(e.to_string()))
}

/// A body a request carries as text, in the table for the one answer and freed when this goes.
struct Carried(u32);

impl Drop for Carried {
    fn drop(&mut self) {
        free(self.0);
    }
}

/// The body `tessellate`, `info` or `save` is sent as text, taken into the table as the older `load` gives it: read
/// back like every body, so what is answered for it is what a held body answers.
fn carried(req: &Value) -> Result<Option<Carried>> {
    let Some(sent) = req.get("body").filter(|body| body.get("smb").is_some()) else {
        return Ok(None);
    };
    let loaded = handed("load", &json!({ "body": sent }))?;
    number(&loaded, "body")
        .and_then(handle_of)
        .map(|handle| Some(Carried(handle)))
        .ok_or_else(|| Error::geometry("brep", "body: the text holds no body"))
}

/// A brep op, answered. Every body is in this table: `tessellate`, `info`, `save`, `free` and `count` are answered
/// from it, and the older operations that take or make a body ([`sx_brep::handover::ROUTED`]) are lent the bodies
/// a request names and have what they make taken into the table. A body sent as text to `tessellate`, `info` or
/// `save` is loaded into the table for that one answer; sent to an older operation it is that operation's for the
/// call.
pub(crate) fn answer(op: &str, req: &Value, raw: bool) -> Result<Value> {
    let reply = answered(op, req, raw)?;
    // `save: true` sends each new body back as text, which is refused past either count; the bodies are freed then
    if op != "save" && req.get("save").and_then(Value::as_bool) == Some(true) {
        let within = MADE_FIELDS.iter().try_for_each(|field| {
            reply
                .get(format!("{field}Smb"))
                .and_then(Value::as_str)
                .map_or(Ok(()), sendable)
        });
        if let Err(e) = within {
            for field in MADE_FIELDS {
                if let Some(handle) = number(&reply, field).and_then(handle_of) {
                    free(handle);
                }
            }
            return Err(e);
        }
    }
    Ok(reply)
}

/// The most edges a body sent back as text may have. A body held by number has no such limit.
pub const MAX_EDGES: u64 = 3_300;
/// The most control points of spline curves and surfaces a body sent back as text may have.
pub const MAX_CONTROL_POINTS: u64 = 178_000;

/// The most a body sent back as text may have of each count, as `exact.ops` gives it (`maxSolid`).
pub(crate) fn max_solid() -> Value {
    json!({ "edges": MAX_EDGES, "controlPoints": MAX_CONTROL_POINTS })
}

/// Refuses a body's text (`smb`, as `save` writes it) past either count, naming the first it passed.
pub(crate) fn sendable(smb: &str) -> Result<()> {
    let d = sx_brep::detail(smb);
    for (size, limit, measure) in [
        (d.edges, MAX_EDGES, Measure::Edges),
        (d.control_points, MAX_CONTROL_POINTS, Measure::ControlPoints),
    ] {
        if size > limit {
            return Err(Error::TooDetailed(TooDetailed { size, limit, measure }));
        }
    }
    Ok(())
}

/// [`answer`], before a body sent back as text is counted.
fn answered(op: &str, req: &Value, raw: bool) -> Result<Value> {
    let sent = if matches!(op, "tessellate" | "info" | "save" | "shell") {
        carried(req)?
    } else {
        None
    };
    let named = sent
        .as_ref()
        .map(|text| f64::from(text.0))
        .or_else(|| number(req, "body"));
    match (op, named) {
        ("count", _) => Ok(json!({ "bodies": count() })),
        ("free", n) => Ok(json!({ "freed": n.and_then(handle_of).is_some_and(free) })),
        ("tessellate" | "info" | "save" | "shell", Some(n)) => {
            let (handle, held) = handle_of(n)
                .and_then(|handle| get(handle).map(|held| (handle, held)))
                .ok_or_else(|| no_such_body("body"))?;
            match op {
                "info" => info(&held),
                // the text the older `save` writes, keys line and checksum included, so `load` reads it
                "save" => held
                    .body
                    .saved_with_from(&held.keys, &held.from)
                    .map(|smb| json!({ "smb": smb }))
                    .map_err(|e| kernel(&e)),
                #[cfg(feature = "cad")]
                "shell" => shelled(handle, &held, req),
                _ => tessellate(handle, &held, req, raw),
            }
        }
        _ if sx_brep::handover::ROUTED.contains(&op) => handed(op, req),
        _ => older(op, req),
    }
}

/// The most faces one shell leaves open, as the mesh shell takes them.
#[cfg(feature = "cad")]
const MOST_OPEN: usize = 64;

/// A face to leave open as a shell request names it: a point on it and its outward normal, and its key when the step
/// kept one.
#[cfg(feature = "cad")]
struct Opening {
    at: V3,
    normal: V3,
    key: u64,
}

/// A face reference that does not hold, in the words the older operations use, so a replay asks for the face again
/// instead of running the step on the mesh.
#[cfg(feature = "cad")]
fn reference(why: &str) -> Error {
    Error::geometry("brep", format!("faceReference: {why}"))
}

#[cfg(feature = "cad")]
fn openings(req: &Value) -> Result<Vec<Opening>> {
    let bad = |why: &str| Error::invalid("open", why);
    let list = match req.get("open") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(bad("must be a list of faces")),
    };
    if list.len() > MOST_OPEN {
        return Err(bad(&format!("at most {MOST_OPEN} faces are left open")));
    }
    let v3 = |o: &Value, k: &str| -> Result<V3> {
        let p: Option<V3> = o.get(k).and_then(|v| serde_json::from_value(v.clone()).ok());
        p.filter(|p| p.iter().all(|c| c.is_finite()))
            .ok_or_else(|| bad(&format!("each face needs {k} as [x, y, z]")))
    };
    list.iter()
        .map(|o| {
            let key = match o.get("key") {
                None | Some(Value::Null) => 0,
                Some(k) => k
                    .as_u64()
                    .filter(|&k| k < 1 << 52)
                    .ok_or_else(|| reference("invalid face key; pick the face again to repair this step"))?,
            };
            Ok(Opening {
                at: v3(o, "at")?,
                normal: v3(o, "normal")?,
                key,
            })
        })
        .collect()
}

/// The face each opening names on a held body, and its key (0 when it has none): by its key when it has one, which
/// must name exactly one face, or else as the mesh shell finds it, the face of a triangle under the point that faces
/// the same way. The mesh is the body's own, so a point picked on its triangles is found again.
#[cfg(feature = "cad")]
fn opened(held: &Held, mesh: &Mesh, open: &[Opening]) -> Result<(Vec<usize>, Vec<u64>)> {
    let at = |i: u32| mesh.positions.get(i as usize).copied().unwrap_or_default();
    let size = held
        .body
        .bounds()
        .map_or(1.0, |(lo, hi)| vec3::len(vec3::sub(hi, lo)));
    let tol = (size * 1e-5).max(1e-3);
    let (mut faces, mut keys) = (Vec::new(), Vec::new());
    for o in open {
        let face = if o.key != 0 {
            let named: Vec<usize> = held
                .keys
                .iter()
                .enumerate()
                .filter_map(|(i, &k)| (k == o.key).then_some(i))
                .collect();
            match named[..] {
                [one] => one,
                [] => {
                    return Err(reference(
                        "the face reference is missing; repair the reference before editing",
                    ));
                }
                _ => {
                    return Err(reference(
                        "the face reference was split; repair the reference before editing",
                    ));
                }
            }
        } else {
            let n = vec3::normalize(o.normal)
                .ok_or_else(|| Error::invalid("open", "a face's normal must not be zero"))?;
            let hit = mesh.triangles.iter().position(|t| {
                let [a, b, c] = t.map(at);
                let Some(tn) = vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a))) else {
                    return false;
                };
                vec3::dot(tn, n) > 0.999
                    && vec3::dot(vec3::sub(o.at, a), tn).abs() <= tol
                    && [(a, b), (b, c), (c, a)].iter().all(|&(from, to)| {
                        let out = vec3::normalize(vec3::cross(vec3::sub(to, from), tn)).unwrap_or([0.0; 3]);
                        vec3::dot(vec3::sub(o.at, from), out) <= tol
                    })
            });
            let t = hit.ok_or_else(|| {
                Error::invalid(
                    "open",
                    "a face to open is not on a face of the body; pick it again",
                )
            })?;
            mesh.faces.get(t).copied().unwrap_or(0) as usize
        };
        keys.push(held.keys.get(face).copied().unwrap_or(0));
        if !faces.contains(&face) {
            faces.push(face);
        }
    }
    if !mesh.surfaces.is_empty() && faces.len() == mesh.surfaces.len() {
        return Err(Error::invalid(
            "open",
            "opening every face leaves no body; leave at least one face closed",
        ));
    }
    Ok((faces, keys))
}

/// `shell`: the held body hollowed to `wallMm` with the faces in `open` left open, at a true constant wall. A face of
/// the result on the body's own surface keeps the key it had; every face the wall made gets a key of the step
/// (`keySalt`), so it reads as made by it. The reply names the new body (`body`), each open face's key as found
/// (`openKeys`, 0 for one without), and with `withKeys` or `save` the new body's keys or text. With a face open, the
/// kernel is asked only for a body of planes, flat sides, cylinders and cones: on other curved faces it can leave the
/// wall open, or fail outright, so such a body is refused in words first and a replay shells it on the mesh. Where the
/// kernel's shell with the face open does not hold, the body is extended past each open face, shelled closed and cut
/// back ([`extended`]). Every shell is read back before it is held: its wall at points inside every face, measured to
/// the faces it keeps, and the volume its mesh holds against the body's, as the kernel passes walls that are not the
/// one asked.
#[cfg(feature = "cad")]
fn shelled(handle: u32, held: &Held, req: &Value) -> Result<Value> {
    let wall = req
        .get("wallMm")
        .and_then(Value::as_f64)
        .filter(|w| w.is_finite() && *w > 0.0 && *w <= 1000.0)
        .ok_or_else(|| Error::invalid("wallMm", "must be above 0 (at most 1000 mm)"))?;
    let open = openings(req)?;
    let shown = shown(handle, held, &Tessellation::default())?;
    let (faces, open_keys) = opened(held, &shown.mesh, &open)?;
    let all = held.body.faces().map_err(|e| kernel(&e))?;
    let picked: Vec<Face<'_>> = faces.iter().filter_map(|&i| all.get(i).copied()).collect();
    if !picked.is_empty() && !all.iter().all(|&f| shells_open(f)) {
        return Err(Error::geometry(
            "shell",
            format!(
                "a {wall} mm wall could not be made exact on this body (with a face open, only a body of flat faces, \
                 cylinders and cones is shelled exact)"
            ),
        ));
    }
    let kept: Vec<Face<'_>> = all.iter().copied().filter(|f| !picked.contains(f)).collect();
    let body = if picked.is_empty() {
        let body = held.body.shell(wall, &picked).map_err(|e| {
            Error::geometry(
                "shell",
                format!("a {wall} mm wall could not be made exact on this body ({e})"),
            )
        })?;
        // the kernel's own checks pass closed walls that are not the wall asked; the refusal is the step's own words
        // and what was read goes only to the log
        if let Err(why) = closed_holds(&held.body, &kept, &body, wall) {
            eprintln!("shell: a {wall} mm closed wall read back off: {why}");
            return Err(Error::geometry(
                "shell",
                format!("a {wall} mm wall could not be made exact on this body"),
            ));
        }
        body
    } else {
        // the kernel's shell with the faces left open, read back as a closed one is; where the side leans in to an
        // opening the kernel leaves the wall open, so the body is extended past each open face, shelled closed and cut
        // back
        // the kernel's refusal keeps its words in the step's; a wall read back off is the step's own words only
        let own = match held.body.shell(wall, &picked) {
            Ok(body) => match closed_holds(&held.body, &kept, &body, wall) {
                Ok(()) => Ok(body),
                Err(why) => Err((why, None)),
            },
            Err(e) => Err((e.to_string(), Some(e.to_string()))),
        };
        match own {
            Ok(body) => body,
            Err((why, words)) => extended(handle, &shown.mesh, &faces, wall)
                .map_err(|e| e.to_string())
                .and_then(|body| closed_holds(&held.body, &kept, &body, wall).map(|()| body))
                .map_err(|past| {
                    eprintln!("shell: a {wall} mm wall with a face open: {why}; extended past it: {past}");
                    Error::geometry(
                        "shell",
                        match words {
                            Some(e) => format!("a {wall} mm wall could not be made exact on this body ({e})"),
                            None => format!("a {wall} mm wall could not be made exact on this body"),
                        },
                    )
                })?,
        }
    };
    let keys = carried_keys(&held.body, &held.keys, &body, wall / 2.0)?;
    let number = hold(body, keys.clone())?;
    let mut out = json!({ "body": number, "openKeys": open_keys });
    made_extras(&mut out, number, &keys, req)?;
    Ok(out)
}

/// The farthest a closed shell's inner wall may be from the wall asked, and its outer side from the body, in mm.
#[cfg(feature = "cad")]
const WALL_MM: f64 = 0.01;
/// The chords a shell's wall is read at, finest first: the points of its mesh are on its surface at any chord, so a
/// coarser one serves where the kernel cannot reach a fine one.
#[cfg(feature = "cad")]
const WALL_CHORDS_MM: [f64; 4] = [0.05, 0.5, 5.0, 50.0];
/// The farthest apart, in mm, the points a shell's wall is read at inside each triangle of its mesh.
#[cfg(feature = "cad")]
const WALL_STEP_MM: f64 = 1.0;
/// The most points of one face the wall is read at.
#[cfg(feature = "cad")]
const WALL_POINTS: usize = 400;
/// How far a closed shell's mesh may hold a volume from the body's, as a share of the body's.
#[cfg(feature = "cad")]
const MESH_VOLUME_SHARE: f64 = 0.005;

/// Why a shell of `from` is not the one asked: its wall ([`wall_holds`]), then its mesh ([`mesh_holds`]). `kept` are
/// the faces of `from` the shell leaves closed: every face of a closed shell.
#[cfg(feature = "cad")]
fn closed_holds(from: &Body, kept: &[Face<'_>], made: &Body, wall: f64) -> std::result::Result<(), String> {
    wall_holds(from, kept, made, wall)?;
    mesh_holds(made)
}

/// A shell of `from` read back at points of each face of `made`: a face on `from`'s surface stays on it, and every
/// other face is `wall` from the faces of `from` it keeps, `kept`, each within [`WALL_MM`]. A face is read as on the
/// surface when most of its points are nearer to the faces kept than half the wall, or lie on an open face (the rim
/// the opening leaves, which must also be no wider than the wall). Why not, in words, otherwise. The points are
/// its mesh's corners, its edges included so a narrow face along a rim is read as well, and points inside each
/// triangle at most [`WALL_STEP_MM`] apart, each found on the face from its own parameters: the mesh is asked for no
/// largest edge, since the kernel's tessellator never finishes some bodies' meshes with one (a straight-lofted taper
/// with its top pushed).
#[cfg(feature = "cad")]
fn wall_holds(from: &Body, kept: &[Face<'_>], made: &Body, wall: f64) -> std::result::Result<(), String> {
    let unmeasured = || "its inner wall could not be measured".to_owned();
    let (chord_mm, mesh) = WALL_CHORDS_MM
        .iter()
        .find_map(|&chord_mm| {
            made.tessellate(&Tessellation {
                chord_mm,
                ..Tessellation::default()
            })
            .ok()
            .map(|mesh| (chord_mm, mesh))
        })
        .ok_or_else(unmeasured)?;
    let shown = made.faces().map_err(|_| unmeasured())?;
    let mut faces: Vec<Vec<V3>> = vec![Vec::new(); mesh.surfaces.len()];
    let mut seen = std::collections::HashSet::new();
    for (t, &f) in mesh.triangles.iter().zip(&mesh.faces) {
        for &v in t {
            if seen.insert((f, v))
                && let (Some(points), Some(&p)) = (faces.get_mut(f as usize), mesh.positions.get(v as usize))
            {
                points.push(p);
            }
        }
    }
    for ((t, &f), uv) in mesh.triangles.iter().zip(&mesh.faces).zip(&mesh.uvs) {
        if let (Some(points), Some(face)) = (faces.get_mut(f as usize), shown.get(f as usize)) {
            inside_triangle(
                points,
                *face,
                t.map(|i| mesh.positions.get(i as usize).copied().unwrap_or_default()),
                *uv,
                chord_mm,
            )
            .map_err(|()| unmeasured())?;
        }
    }
    let mut worst = 0.0f64;
    let on = |p: V3| from.distance_to(p).map_err(|_| unmeasured());
    // an open face is gone from the shell, so the wall is read to the faces it keeps
    let all = from.faces().map_err(|_| unmeasured())?;
    let open: Vec<Face<'_>> = all.iter().copied().filter(|f| !kept.contains(f)).collect();
    let nearest = |of: &[Face<'_>], p: V3| {
        of.iter()
            .map(|f| f.distance_to(p).map_err(|_| unmeasured()))
            .try_fold(f64::INFINITY, |near, d| d.map(|d| near.min(d)))
    };
    let most = |ds: &[f64], under: f64| 2 * ds.iter().filter(|&&d| d < under).count() > ds.len();
    for points in &faces {
        if points.is_empty() {
            continue;
        }
        let read: Vec<V3> = points
            .iter()
            .step_by(points.len().div_ceil(WALL_POINTS).max(1))
            .copied()
            .collect();
        let to_kept = read
            .iter()
            .map(|&p| nearest(kept, p))
            .collect::<std::result::Result<Vec<f64>, String>>()?;
        let to_open = read
            .iter()
            .map(|&p| nearest(&open, p))
            .collect::<std::result::Result<Vec<f64>, String>>()?;
        // the rim an opening leaves lies on the open face, a face the shell keeps lies on the body's surface, and
        // either stays on that surface; every other face, one the wall made, is the wall from the faces kept
        let rim = most(&to_open, WALL_MM);
        if rim || most(&to_kept, wall / 2.0) {
            for &p in &read {
                worst = worst.max(on(p)?);
            }
            // and the rim is no wider than the wall, so a face left across the opening is not read as one
            if rim {
                worst = to_kept.iter().fold(worst, |w, &d| w.max(d - wall));
            }
        } else {
            worst = to_kept.iter().fold(worst, |w, &d| w.max((d - wall).abs()));
        }
    }
    if worst > WALL_MM {
        return Err(format!("its inner wall is {worst:.3} mm off the wall asked"));
    }
    Ok(())
}

/// Points strictly inside one triangle of `face`'s mesh, at most [`WALL_STEP_MM`] apart, added to `points`: each found
/// on the face's surface at the triangle's corners' parameters `uv` blended, and kept only when it is within twice the
/// mesh's chord of the flat triangle, so a triangle whose parameters wrap around a seam adds no point off its own
/// stretch of the face. A plane's triangle, or one the kernel gave no parameters, adds its flat points only when the
/// face is a plane, where they are on it.
#[cfg(feature = "cad")]
fn inside_triangle(
    points: &mut Vec<V3>,
    face: Face<'_>,
    [a, b, c]: [V3; 3],
    uv: Option<[[f64; 2]; 3]>,
    chord_mm: f64,
) -> std::result::Result<(), ()> {
    let longest = vec3::len(vec3::sub(a, b))
        .max(vec3::len(vec3::sub(b, c)))
        .max(vec3::len(vec3::sub(c, a)));
    // a triangle split fewer than three times along its longest side has no point strictly inside the split
    let steps = (longest / WALL_STEP_MM).ceil();
    if !(3.0..=1e6).contains(&steps) {
        return Ok(());
    }
    let flat = matches!(face.surface(), Surface::Plane { .. });
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "steps is a whole number from 3 to a million"
    )]
    let n = steps as usize;
    for i in 1..n {
        for j in 1..n - i {
            #[allow(clippy::cast_precision_loss, reason = "i and j are at most a million")]
            let (s, r) = (i as f64 / steps, j as f64 / steps);
            let q = 1.0 - s - r;
            let at = vec3::add(vec3::add(vec3::scale(a, q), vec3::scale(b, s)), vec3::scale(c, r));
            if flat {
                points.push(at);
                continue;
            }
            let Some([ua, ub, uc]) = uv else { return Ok(()) };
            let p = face
                .point_at([
                    ua[0] * q + ub[0] * s + uc[0] * r,
                    ua[1] * q + ub[1] * s + uc[1] * r,
                ])
                .map_err(|_| ())?;
            if vec3::len(vec3::sub(p, at)) <= 2.0 * chord_mm {
                points.push(p);
            }
        }
    }
    Ok(())
}

/// A closed shell's mesh at the default chord read back: the volume its triangles hold is the body's to within
/// [`MESH_VOLUME_SHARE`]. Why not, in words, otherwise.
#[cfg(feature = "cad")]
fn mesh_holds(made: &Body) -> std::result::Result<(), String> {
    let mesh = made
        .tessellate(&Tessellation::default())
        .map_err(|e| e.to_string())?;
    let volume = made.volume().map_err(|e| e.to_string())?;
    volume_held(&mesh, volume)
}

/// Whether the volume `mesh`'s triangles hold is `volume` to within [`MESH_VOLUME_SHARE`]. Why not, in words,
/// otherwise.
#[cfg(feature = "cad")]
fn volume_held(mesh: &Mesh, volume: f64) -> std::result::Result<(), String> {
    let held: f64 = mesh
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| mesh.positions.get(i as usize).copied().unwrap_or_default());
            vec3::dot(a, vec3::cross(b, c)) / 6.0
        })
        .sum();
    if (held - volume).abs() > MESH_VOLUME_SHARE * volume.abs() {
        return Err(format!(
            "its mesh holds {held:.1} mm3 and the body {volume:.1} mm3"
        ));
    }
    Ok(())
}

/// Whether the kernel's shell is asked for a body with a face open when it has a face like this: a plane, the flat side
/// of a straight loft or a tapered extrude ([`sorted_flat`]), a cylinder or a cone.
#[cfg(feature = "cad")]
fn shells_open(face: Face<'_>) -> bool {
    matches!(
        face.surface(),
        Surface::Plane { .. } | Surface::Cylinder { .. } | Surface::Cone { .. }
    ) || sorted_flat(face)
}

/// The keys of `made`, a body cut from `from`: a face that lies on `from`'s surface keeps the key the kernel carried to
/// it, and every other face, one the operation made and so at least `apart` mm from that surface, gets a key of the
/// current step, or none outside one. None at all when neither has any.
#[cfg(feature = "cad")]
fn carried_keys(from: &Body, from_keys: &[u64], made: &Body, apart: f64) -> Result<Vec<u64>> {
    let had = made.keys().map_err(|e| kernel(&e))?;
    let mesh = made
        .tessellate(&Tessellation::default())
        .map_err(|e| kernel(&e))?;
    let (lo, hi) = from.bounds().map_err(|e| kernel(&e))?;
    let on = 1e-6 * vec3::len(vec3::sub(hi, lo)).max(1.0);
    // a point inside each face's triangles, away from its edges: the middle of its largest triangle
    let mut middle: Vec<Option<(f64, V3)>> = vec![None; mesh.surfaces.len()];
    for (t, &f) in mesh.triangles.iter().zip(&mesh.faces) {
        let [a, b, c] = t.map(|i| mesh.positions.get(i as usize).copied().unwrap_or_default());
        let area = vec3::len(vec3::cross(vec3::sub(b, a), vec3::sub(c, a)));
        let m = vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0);
        if let Some(slot) = middle.get_mut(f as usize)
            && slot.is_none_or(|(best, _)| area > best)
        {
            *slot = Some((area, m));
        }
    }
    let from_faces = from.faces().map_err(|e| kernel(&e))?;
    let mut fresh = Vec::new();
    let mut placed = Vec::new();
    for (slot, &k) in middle.iter().zip(&had) {
        // a face of the body's surface: its middle on that surface, to within the kernel's own tolerance
        let kept = match slot {
            Some((_, m)) => from.distance_to(*m).map_err(|e| kernel(&e))? <= (on + mesh_chord()).min(apart),
            None => false,
        };
        // one the kernel made anew there, as a cut makes the rim of an opening, takes the key of the face it lies on
        let mut key = k;
        if kept
            && !from_keys.contains(&k)
            && let Some((_, m)) = slot
        {
            let mut nearest = (f64::INFINITY, 0);
            for (face, &fk) in from_faces.iter().zip(from_keys) {
                let d = face.distance_to(*m).map_err(|e| kernel(&e))?;
                if d < nearest.0 {
                    nearest = (d, fk);
                }
            }
            key = nearest.1;
        }
        fresh.push(!kept);
        placed.push(key);
    }
    let new_keys = crate::faces::fresh_keys(fresh.iter().filter(|&&f| f).count());
    if new_keys.is_empty() && placed.iter().all(|&k| k == 0) {
        return Ok(Vec::new());
    }
    let mut next = new_keys.into_iter();
    Ok(placed
        .iter()
        .zip(&fresh)
        .map(|(&k, &is_new)| if is_new { next.next().unwrap_or(0) } else { k })
        .collect())
}

/// How far past an open face a body is extended before it is shelled closed and cut back, beyond twice the wall, in
/// mm: far enough that the wall's inner side reaches past the face's plane.
#[cfg(feature = "cad")]
const PAST_OPEN_MM: f64 = 1.0;

/// The held body `handle` shelled to `wall` with the faces `open` (indices into its mesh `mesh`) left open, made
/// without asking the kernel's shell to leave them open: each open face pushed out past itself (a join with its
/// outline swept along its normal), the body shelled closed, and cut back at each face's plane. Every body made on the
/// way is freed again.
#[cfg(feature = "cad")]
fn extended(handle: u32, mesh: &Mesh, open: &[usize], wall: f64) -> Result<Body> {
    let at = |i: u32| mesh.positions.get(i as usize).copied().unwrap_or_default();
    // a point inside each open face and its outward normal: the middle and winding of its largest triangle
    let mut planes = Vec::new();
    for &face in open {
        let mut best: Option<(f64, V3, V3)> = None;
        for (t, &f) in mesh.triangles.iter().zip(&mesh.faces) {
            if f as usize != face {
                continue;
            }
            let [a, b, c] = t.map(at);
            let cross = vec3::cross(vec3::sub(b, a), vec3::sub(c, a));
            let area = vec3::len(cross);
            if best.is_none_or(|(most, ..)| area > most)
                && let Some(n) = vec3::normalize(cross)
            {
                best = Some((area, vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0), n));
            }
        }
        let (_, point, normal) =
            best.ok_or_else(|| Error::geometry("shell", "an open face has no triangles"))?;
        planes.push((point, normal));
    }
    let past = 2.0 * wall + PAST_OPEN_MM;
    let made = Made::default();
    let mut body = handle;
    for &(point, normal) in &planes {
        let reply = handed(
            "push",
            &json!({ "body": body, "at": point, "normal": normal, "distanceMm": past }),
        )?;
        body = made.take(reply.get("body"))?;
    }
    let shelled = with(body, |held| held.body.shell(wall, &[]))
        .ok_or_else(|| no_such_body("body"))?
        .map_err(|e| kernel(&e))?;
    body = made.keep(hold(shelled, Vec::new())?);
    for &(point, normal) in &planes {
        let reply = handed(
            "cut",
            &json!({ "body": body, "plane": { "point": point, "normal": normal } }),
        )?;
        made.take(reply.get("above")).ok();
        body = made.take(reply.get("below"))?;
    }
    made.out(body)
}

/// The bodies [`extended`] makes on its way, freed when it returns; the one it answers is taken out first.
#[cfg(feature = "cad")]
#[derive(Default)]
struct Made(RefCell<Vec<u32>>);

#[cfg(feature = "cad")]
impl Made {
    fn keep(&self, number: u32) -> u32 {
        self.0.borrow_mut().push(number);
        number
    }

    /// The body a reply field names, kept to be freed.
    fn take(&self, field: Option<&Value>) -> Result<u32> {
        let number =
            number_of(field).ok_or_else(|| Error::geometry("shell", "the extended body is missing"))?;
        Ok(self.keep(number))
    }

    /// The body `number` taken out of the table, as the one answered.
    fn out(self, number: u32) -> Result<Body> {
        self.0.borrow_mut().retain(|&n| n != number);
        let held = TABLE.with(|t| t.borrow_mut().remove(&number));
        MESHES.with(|m| m.borrow_mut().retain(|(key, ..)| key.0 != number));
        held.and_then(|h| Rc::try_unwrap(h).ok())
            .map(|h| h.body)
            .ok_or_else(|| Error::geometry("shell", "the extended body is still in use"))
    }
}

#[cfg(feature = "cad")]
impl Drop for Made {
    fn drop(&mut self) {
        for &number in self.0.borrow().iter() {
            free(number);
        }
    }
}

/// a body number as a reply gives it
#[cfg(feature = "cad")]
fn number_of(field: Option<&Value>) -> Option<u32> {
    field.and_then(Value::as_f64).and_then(handle_of)
}

/// the farthest a triangle's middle sits from its surface at the default chord
#[cfg(feature = "cad")]
fn mesh_chord() -> f64 {
    Tessellation::default().chord_mm
}

/// `bodyKeys` and `bodySmb` for a body an operation here made, as `withKeys` and `save` ask
#[cfg(feature = "cad")]
fn made_extras(out: &mut Value, number: u32, keys: &[u64], req: &Value) -> Result<()> {
    let asked = |k: &str| req.get(k).and_then(Value::as_bool) == Some(true);
    if asked("withKeys") {
        let faces = with(number, |h| h.body.faces().map(|f| f.len()))
            .transpose()
            .map_err(|e| kernel(&e))?
            .unwrap_or(0);
        out["bodyKeys"] = if keys.is_empty() {
            json!(vec![0; faces])
        } else {
            json!(keys)
        };
    }
    if asked("save") {
        let smb = with(number, |h| h.body.saved(&h.keys))
            .transpose()
            .map_err(|e| kernel(&e))?;
        out["bodySmb"] = json!(smb);
    }
    Ok(())
}

/// An older operation on the bodies this table holds: each body the request names by number is lent to it for the
/// call, and each body it makes is taken into the table, so the answer names bodies of this table only.
fn handed(op: &str, req: &Value) -> Result<Value> {
    let mut named = Vec::new();
    for field in BODY_FIELDS {
        if let Some(n) = number(req, field) {
            named.push((field, held(n).ok_or_else(|| no_such_body(field))?));
        }
    }
    let mut asked = req.clone();
    let mut lent = Vec::new();
    for (field, held) in &named {
        let lend = sx_brep::handover::lend(&held.body).map_err(|e| kernel(&e))?;
        // the field is there: its number was read from it
        if let Some(place) = asked.get_mut(*field) {
            *place = json!(lend.number());
        }
        lent.push(lend);
    }
    let reply = older(op, &asked);
    // the numbers leave the older table before anything is made of the answer
    drop(lent);
    let mut reply = reply?;
    take_over(&mut reply)?;
    Ok(reply)
}

/// Takes every body an older operation's reply names into this table and writes this table's numbers in their
/// place. A body that does not read back as a solid is refused: then nothing of the reply is kept, here or in the
/// older table.
fn take_over(reply: &mut Value) -> Result<()> {
    let made: Vec<(&str, i64)> = MADE_FIELDS
        .iter()
        .filter_map(|field| Some((*field, reply.get(*field)?.as_i64()?)))
        .collect();
    let mut kept = Vec::new();
    let mut refused = None;
    for &(field, older_number) in &made {
        if refused.is_some() {
            // freed where it is: nothing was made of it
            let _ = older("free", &json!({ "body": older_number }));
            continue;
        }
        let taken = sx_brep::handover::adopt(older_number)
            .and_then(|body| Ok((body.keys()?, body.came_from()?, body)))
            .map_err(|e| kernel(&e))
            .and_then(|(keys, from, body)| {
                // a body without keys has none in the table either, and one whose faces came from none no from
                let none = |v: Vec<u64>| {
                    if v.iter().all(|&key| key == 0) {
                        Vec::new()
                    } else {
                        v
                    }
                };
                keep(body, none(keys), none(from))
            });
        match taken {
            Ok(handle) => kept.push((field, handle)),
            Err(e) => refused = Some(e),
        }
    }
    if let Some(e) = refused {
        for (_, handle) in kept {
            free(handle);
        }
        return Err(e);
    }
    for (field, handle) in kept {
        reply[field] = json!(handle);
    }
    Ok(())
}

/// Whether a face on a spline surface is a plane where faces are sorted into kinds (`info`'s counts, `tessellate`'s
/// `type` and the five-kind table): one the kernel calls flat within [`sx_brep::FLAT_KIND_MM`], as the older
/// operations sort it. A tapered extrude's and a straight loft's flat sides are such faces. `surfaces` is not sorted.
fn sorted_flat(face: Face) -> bool {
    matches!(face.surface(), Surface::Spline) && face.flat_within(sx_brep::FLAT_KIND_MM)
}

/// a surface's kind as the kernel has it, and the name the old `tessellate` and `info` give that kind
fn names(s: &Surface) -> (&'static str, &'static str) {
    match s {
        Surface::Plane { .. } => ("plane", "plane"),
        Surface::Cylinder { .. } => ("cylinder", "cylinder"),
        Surface::Cone { .. } => ("cone", "cone"),
        Surface::Sphere { .. } => ("sphere", "sphere"),
        Surface::Torus { .. } => ("torus", "torus"),
        Surface::Spline => ("spline", "nurbs"),
        Surface::Revolved => ("revolved", "revolution"),
        Surface::Extruded => ("extruded", "extrusion"),
        Surface::Blend => ("blend", "blend"),
        Surface::Offset => ("offset", "offset"),
        Surface::Other { .. } => ("other", "other"),
    }
}

fn info(held: &Held) -> Result<Value> {
    let body = &held.body;
    let (min, max) = body.bounds().map_err(|e| kernel(&e))?;
    let volume = body.volume().map_err(|e| kernel(&e))?;
    let faces = body.faces().map_err(|e| kernel(&e))?;
    let mut types: BTreeMap<&str, u64> = BTreeMap::new();
    for face in &faces {
        let name = if sorted_flat(*face) {
            "plane"
        } else {
            names(&face.surface()).1
        };
        *types.entry(name).or_default() += 1;
    }
    // a body is in the table only after it read back as a solid
    Ok(json!({
        "manifold": true,
        "volumeMm3": volume,
        "bounds": { "min": min, "max": max },
        "faces": faces.len(),
        "faceTypes": types,
    }))
}

/// A face's surface as one of the five kinds mesh ops know. `side` is the sum of the area vectors of the face's
/// triangles, which says which way a plane faces out; the kernel's plane does not.
fn five(s: &Surface, side: V3) -> Kind {
    match *s {
        Surface::Plane { frame } => {
            let toward = vec3::dot(frame.z, side);
            let normal = if toward > 0.0 {
                frame.z
            } else if toward < 0.0 {
                // 0 - c, so a zero stays plus zero
                frame.z.map(|c| 0.0 - c)
            } else {
                // no triangles, or none with any area: nothing says which side is out
                return Kind::Other;
            };
            Kind::Plane {
                normal,
                offset: vec3::dot(normal, frame.origin),
            }
        }
        Surface::Cylinder { frame, radius } => Kind::Cylinder {
            origin: frame.origin,
            axis: frame.z,
            radius,
        },
        Surface::Cone {
            frame,
            radius,
            half_angle_deg,
            apex,
        } => {
            // the kernel keeps a cylinder as a cone that does not widen and has no tip
            if half_angle_deg.abs() < 1e-9 {
                return Kind::Cylinder {
                    origin: frame.origin,
                    axis: frame.z,
                    radius,
                };
            }
            let Some(apex) = apex else {
                return Kind::Other;
            };
            // a positive angle widens along the frame's z; the table's axis is the way the cone opens
            let axis = if half_angle_deg > 0.0 {
                frame.z
            } else {
                frame.z.map(|c| 0.0 - c)
            };
            Kind::Cone {
                apex,
                axis,
                half_angle: half_angle_deg.abs().to_radians(),
            }
        }
        Surface::Sphere { frame, radius } => Kind::Sphere {
            center: frame.origin,
            radius,
        },
        _ => Kind::Other,
    }
}

/// The plane of a face sorted as flat, from its triangles as the older operations take it: it faces the way the
/// triangles' area vectors sum (`side`), through their middle weighted by area (`middle` over `area`).
fn flat_plane(side: V3, middle: V3, area: f64) -> Kind {
    match vec3::normalize(side) {
        Some(normal) if area > 0.0 => Kind::Plane {
            normal,
            offset: vec3::dot(normal, vec3::scale(middle, 1.0 / area)),
        },
        _ => Kind::Other,
    }
}

/// the five-kind table of a mesh's faces, in face order; `flat` says which faces are sorted as planes whatever
/// their surface ([`sorted_flat`])
fn table(mesh: &Mesh, flat: &[bool]) -> Vec<Kind> {
    let mut sides = vec![([0.0; 3], [0.0; 3], 0.0); mesh.surfaces.len()];
    let at = |i: u32| mesh.positions.get(i as usize).copied().unwrap_or_default();
    for (t, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        if let Some((side, middle, area)) = sides.get_mut(face as usize) {
            let [a, b, c] = t.map(at);
            let twice = vec3::cross(vec3::sub(b, a), vec3::sub(c, a));
            let weight = vec3::len(twice);
            *side = vec3::add(*side, twice);
            *middle = vec3::add(*middle, vec3::scale(vec3::add(vec3::add(a, b), c), weight / 3.0));
            *area += weight;
        }
    }
    mesh.surfaces
        .iter()
        .zip(sides)
        .enumerate()
        .map(|(face, (s, (side, middle, area)))| {
            if flat.get(face) == Some(&true) {
                flat_plane(side, middle, area)
            } else {
                five(s, side)
            }
        })
        .collect()
}

/// a kind as the faces table has it in JSON (what serde writes for it in builds with the cad feature)
fn kind_json(k: &Kind) -> Value {
    match *k {
        Kind::Plane { normal, offset } => json!({ "kind": "plane", "normal": normal, "offset": offset }),
        Kind::Cylinder { origin, axis, radius } => {
            json!({ "kind": "cylinder", "origin": origin, "axis": axis, "radius": radius })
        }
        Kind::Cone {
            apex,
            axis,
            half_angle,
        } => json!({ "kind": "cone", "apex": apex, "axis": axis, "halfAngle": half_angle }),
        Kind::Sphere { center, radius } => json!({ "kind": "sphere", "center": center, "radius": radius }),
        Kind::Other => json!({ "kind": "other" }),
    }
}

fn frame_json(f: &Frame) -> Value {
    json!({ "origin": f.origin, "x": f.x, "y": f.y, "z": f.z })
}

/// a surface with the kernel's own kind and numbers
fn surface_json(s: &Surface) -> Value {
    let kind = names(s).0;
    match *s {
        Surface::Plane { frame } => json!({ "kind": kind, "frame": frame_json(&frame) }),
        Surface::Cylinder { frame, radius } | Surface::Sphere { frame, radius } => {
            json!({ "kind": kind, "frame": frame_json(&frame), "radius": radius })
        }
        Surface::Cone {
            frame,
            radius,
            half_angle_deg,
            apex,
        } => json!({
            "kind": kind,
            "frame": frame_json(&frame),
            "radius": radius,
            "halfAngleDeg": half_angle_deg,
            "apex": apex,
        }),
        Surface::Torus { frame, major, minor } => json!({
            "kind": kind,
            "frame": frame_json(&frame),
            "majorRadius": major,
            "minorRadius": minor,
        }),
        Surface::Other { kernel_type } => json!({ "kind": kind, "kernelType": kernel_type }),
        _ => json!({ "kind": kind }),
    }
}

fn curve_json(c: Curve, into: &mut Map<String, Value>) {
    let name = match c {
        Curve::Line => "line",
        Curve::Circle => "circle",
        Curve::Ellipse => "ellipse",
        Curve::Spline => "spline",
        Curve::Other { kernel_type } => {
            into.insert("kernelType".to_owned(), json!(kernel_type));
            "other"
        }
    };
    into.insert("curve".to_owned(), json!(name));
}

fn limit(req: &Value, field: &'static str, default: f64) -> Result<f64> {
    match req.get(field) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_f64()
            .ok_or_else(|| Error::invalid(field, "must be a number")),
    }
}

fn le_bytes<const N: usize, T: Copy>(values: &[T], bytes: impl Fn(T) -> [u8; N]) -> Vec<u8> {
    values.iter().flat_map(|&v| bytes(v)).collect()
}

/// A held body as triangles: the kernel's own vertices, never welded again, with a face for each triangle, packed
/// corner normals (`normals.rs`), the faces as the five kinds mesh ops know and as the kernel has them, and the
/// body's edges as runs of vertices.
///
/// With `raw` the mesh leaves as the raw buffer every mesh uses (positions as f32) and three more buffers beside it,
/// named in the answer by number: `normalsOut` (i16, six per triangle), `faceIdsOut` (u32 per triangle) and
/// `edgePointsOut` (u32 vertex numbers, each edge's run after the last); `meshForm` is 2 and `faces` is the table
/// and keys alone. Without it the answer is the old `tessellate`'s JSON, positions as f64, with `normals`,
/// `surfaces` and `edges` added.
fn tessellate(handle: u32, held: &Held, req: &Value, raw: bool) -> Result<Value> {
    // the old tessellate's own limits, in its words, so a caller hears the same whichever table holds the body.
    // the typed call takes an angle of 0 when a chord is given; this operation never has
    let refuse = |field: &str, why: &str| Err(Error::geometry("brep", format!("{field}: {why}")));
    let chord = limit(req, "chordMm", 0.01)?;
    if chord.is_nan() || chord < 0.0 {
        return refuse("chordMm", "must be 0 or more");
    }
    let angle = limit(req, "angleDeg", 15.0)?;
    if angle.is_nan() || angle <= 0.0 || angle > 90.0 {
        return refuse("angleDeg", "must be more than 0 and at most 90");
    }
    let how = Tessellation {
        chord_mm: chord,
        curve_angle_deg: angle,
        surface_angle_deg: angle,
        ..Tessellation::default()
    };
    // the answer is built anew on every call: each call's raw buffers are its own
    let shown = shown(handle, held, &how)?;
    let (mesh, flat) = (&shown.mesh, &shown.flat);
    let kinds: Vec<Value> = table(mesh, flat).iter().map(kind_json).collect();
    let surfaces: Vec<Value> = mesh.surfaces.iter().map(surface_json).collect();
    let packed = normals::pack_triangles(&mesh.normals);
    let edges = |points: &dyn Fn(&[u32]) -> Value| -> Vec<Value> {
        mesh.edges
            .iter()
            .map(|e| {
                let mut o = Map::new();
                o.insert("faces".to_owned(), json!(e.faces));
                curve_json(e.curve, &mut o);
                o.insert("tangent".to_owned(), json!(e.tangent));
                o.insert("points".to_owned(), points(&e.points));
                Value::Object(o)
            })
            .collect()
    };
    if !raw {
        let entries: Vec<Value> = mesh
            .surfaces
            .iter()
            .zip(&kinds)
            .enumerate()
            .map(|(i, (s, kind))| {
                let mut entry = json!({
                    "id": i,
                    "type": if flat.get(i) == Some(&true) { "plane" } else { names(s).1 },
                    "surface": kind,
                    "key": held.keys.get(i).copied().unwrap_or(0),
                });
                // where the face came from only for one that has it, so other answers stay as they were
                if let (Some(&k), Some(o)) = (held.from.get(i).filter(|&&k| k != 0), entry.as_object_mut()) {
                    o.insert("from".to_owned(), json!(k));
                }
                entry
            })
            .collect();
        return Ok(json!({
            "positions": mesh.positions.iter().flatten().collect::<Vec<_>>(),
            "indices": mesh.triangles.iter().flatten().collect::<Vec<_>>(),
            "faceIds": mesh.faces,
            "faces": entries,
            "normals": packed,
            "surfaces": surfaces,
            "edges": edges(&|points| json!(points)),
        }));
    }
    let edges = edges(&|points| json!(points.len()));
    let runs: Vec<u32> = mesh.edges.iter().flat_map(|e| e.points.iter().copied()).collect();
    let mut table = Map::new();
    table.insert("table".to_owned(), Value::Array(kinds));
    if !held.from.is_empty() {
        table.insert("from".to_owned(), json!(held.from));
    }
    if !held.keys.is_empty() {
        table.insert("keys".to_owned(), json!(held.keys));
    }
    let face_ids = le_bytes(&mesh.faces, u32::to_le_bytes);
    let out = |bytes: Vec<u8>| crate::json::push_out_file(OutFile::Bytes(bytes));
    Ok(json!({
        "meshForm": 2,
        "rawOut": out(TriMesh::new(mesh.positions.clone(), mesh.triangles.clone()).to_raw()),
        "normalsOut": out(le_bytes(&packed, i16::to_le_bytes)),
        "faceIdsOut": out(face_ids),
        "edgePointsOut": out(le_bytes(&runs, u32::to_le_bytes)),
        "faces": table,
        "surfaces": surfaces,
        "edges": edges,
    }))
}

/// A held body's mesh at a chord and angle, kept until the body is freed or newer meshes pass [`MESH_BYTES`].
fn shown(handle: u32, held: &Held, how: &Tessellation) -> Result<Rc<Shown>> {
    let key = (handle, how.chord_mm.to_bits(), how.curve_angle_deg.to_bits());
    let found = MESHES.with(|m| {
        let mut m = m.borrow_mut();
        let at = m.iter().position(|kept| kept.0 == key)?;
        let kept = m.remove(at);
        let shown = Rc::clone(&kept.1);
        m.push(kept);
        Some(shown)
    });
    if let Some(shown) = found {
        return Ok(shown);
    }
    TESSELLATED.set(TESSELLATED.get() + 1);
    let mut mesh = held.body.tessellate(how).map_err(|e| kernel(&e))?;
    // no answer reads them
    mesh.uvs = Vec::new();
    let flat: Vec<bool> = held
        .body
        .faces()
        .map_err(|e| kernel(&e))?
        .iter()
        .map(|&face| sorted_flat(face))
        .collect();
    let triangles = mesh.triangles.len();
    let faces = mesh.surfaces.len();
    if mesh.faces.len() != triangles
        || mesh.normals.len() != triangles
        || mesh.faces.iter().any(|&f| f as usize >= faces)
        || (!held.keys.is_empty() && held.keys.len() != faces)
        || (!held.from.is_empty() && held.from.len() != faces)
        || flat.len() != faces
    {
        return Err(Error::geometry(
            "brep",
            "tessellate: the mesh does not match the body's faces",
        ));
    }
    let shown = Rc::new(Shown { mesh, flat });
    let bytes = shown.bytes();
    if bytes <= MESH_CAP.get() {
        MESHES.with(|m| {
            let mut m = m.borrow_mut();
            trim(&mut m, bytes);
            m.push((key, Rc::clone(&shown), bytes));
        });
    }
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: Frame = Frame {
        origin: [1.0, 2.0, 3.0],
        x: [1.0, 0.0, 0.0],
        y: [0.0, 1.0, 0.0],
        z: [0.0, 0.0, 1.0],
    };

    /// a saved body's text with `edges` edges and one spline surface of `across` by `along` control points
    fn text(edges: u64, across: u64, along: u64) -> String {
        format!("{edges} Edges In Brep\nObject Type 15002\n{across} {along}\n")
    }

    #[test]
    fn a_body_sent_back_as_text_is_refused_past_either_count() {
        assert!(sendable(&text(MAX_EDGES, 400, 445)).is_ok());
        let refused = |t: &str| match sendable(t) {
            Err(Error::TooDetailed(t)) => t,
            other => panic!("{other:?}"),
        };
        let edges = refused(&text(MAX_EDGES + 1, 1, 1));
        assert_eq!(
            (edges.size, edges.limit, edges.measure),
            (3301, 3300, Measure::Edges)
        );
        let points = refused(&text(10, 445, 401));
        assert_eq!(
            (points.size, points.limit, points.measure),
            (178_445, 178_000, Measure::ControlPoints)
        );
        // past both, the edges are named
        assert_eq!(refused(&text(4000, 500, 500)).measure, Measure::Edges);
        assert_eq!(
            crate::json::error_value(&Error::TooDetailed(edges)),
            json!({
                "error": "brep: the body is too detailed to save as text (3,301 edges, limit 3,300)",
                "tooBig": { "size": 3301, "limit": 3300, "measure": "edges" },
            })
        );
    }

    #[test]
    fn a_number_names_a_body_only_when_it_is_whole_and_held() {
        assert_eq!(handle_of(0.0), Some(0));
        assert_eq!(handle_of(1.0), Some(1));
        assert_eq!(handle_of(4_294_967_295.0), Some(u32::MAX));
        for not_one in [-1.0, 1.5, 4_294_967_296.0, f64::NAN, f64::INFINITY] {
            assert_eq!(handle_of(not_one), None, "{not_one}");
        }
        assert_eq!(number(&json!({ "body": 7 }), "body"), Some(7.0));
        assert_eq!(number(&json!({ "body": { "smb": "text" } }), "body"), None);
        assert_eq!(number(&json!({ "body": "7" }), "body"), None);
        assert_eq!(number(&json!({}), "body"), None);
        // nothing is held in a test that made no body
        assert!(held(1.0).is_none() && held(2_147_483_648.0).is_none());
        assert_eq!(count(), 0);
        assert!(!free(1));
        assert_eq!(with(1, |_| ()), None);
    }

    #[test]
    fn a_number_nothing_is_held_under_is_refused_before_any_older_operation_is_asked() {
        assert_eq!(
            answer("count", &json!({}), false).unwrap(),
            json!({ "bodies": 0 })
        );
        for body in [json!(7), json!(1.5), json!({ "smb": "text" }), json!(null)] {
            let free = answer("free", &json!({ "body": body }), false);
            assert_eq!(free.unwrap(), json!({ "freed": false }), "{body}");
        }
        for (op, req, field) in [
            ("tessellate", json!({ "body": 7 }), "body"),
            ("info", json!({ "body": 2_147_483_648.5 }), "body"),
            ("save", json!({ "body": 4_294_967_296_u64 }), "body"),
            ("boolean", json!({ "op": "union", "a": 1, "b": 2 }), "a"),
            (
                "boolean",
                json!({ "op": "union", "a": { "smb": "text" }, "b": 2 }),
                "b",
            ),
            ("extrude", json!({ "target": u32::MAX }), "target"),
            ("cut", json!({ "body": 4_294_967_296_u64 }), "body"),
        ] {
            let refused = answer(op, &req, false).unwrap_err().to_string();
            assert_eq!(
                refused,
                format!("brep: {field}: no such body (freed, or from an earlier session)"),
                "{op}"
            );
        }
    }

    #[test]
    fn a_plane_faces_the_way_its_triangles_do() {
        let plane = Surface::Plane { frame: FRAME };
        assert_eq!(
            five(&plane, [0.0, 0.0, 2.0]),
            Kind::Plane {
                normal: [0.0, 0.0, 1.0],
                offset: 3.0
            }
        );
        let down = five(&plane, [0.1, 0.0, -2.0]);
        assert_eq!(
            down,
            Kind::Plane {
                normal: [0.0, 0.0, -1.0],
                offset: -3.0
            }
        );
        // a flipped zero is still plus zero, so it prints as 0
        assert_eq!(kind_json(&down)["normal"].to_string(), "[0.0,0.0,-1.0]");
        assert_eq!(five(&plane, [0.0; 3]), Kind::Other);
        assert_eq!(five(&plane, [1.0, 1.0, 0.0]), Kind::Other);
    }

    #[test]
    fn round_faces_become_the_kinds_mesh_ops_know() {
        let none = [0.0; 3];
        let cylinder = Kind::Cylinder {
            origin: FRAME.origin,
            axis: FRAME.z,
            radius: 4.0,
        };
        assert_eq!(
            five(
                &Surface::Cylinder {
                    frame: FRAME,
                    radius: 4.0
                },
                none
            ),
            cylinder
        );
        // a cylinder as the kernel makes one: a cone that does not widen, with no tip
        let straight = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: 0.0,
            apex: None,
        };
        assert_eq!(five(&straight, none), cylinder);
        // narrowing along z to a tip above: the table's cone opens downward from it
        let narrowing = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: -45.0,
            apex: Some([1.0, 2.0, 7.0]),
        };
        assert_eq!(
            five(&narrowing, none),
            Kind::Cone {
                apex: [1.0, 2.0, 7.0],
                axis: [0.0, 0.0, -1.0],
                half_angle: 45.0_f64.to_radians(),
            }
        );
        let no_tip = Surface::Cone {
            frame: FRAME,
            radius: 4.0,
            half_angle_deg: 30.0,
            apex: None,
        };
        assert_eq!(five(&no_tip, none), Kind::Other);
        assert_eq!(
            five(
                &Surface::Sphere {
                    frame: FRAME,
                    radius: 2.5
                },
                none
            ),
            Kind::Sphere {
                center: FRAME.origin,
                radius: 2.5
            }
        );
        let torus = Surface::Torus {
            frame: FRAME,
            major: 5.0,
            minor: 1.0,
        };
        for other in [
            torus,
            Surface::Spline,
            Surface::Revolved,
            Surface::Extruded,
            Surface::Blend,
            Surface::Offset,
            Surface::Other { kernel_type: 15999 },
        ] {
            assert_eq!(five(&other, [0.0, 0.0, 1.0]), Kind::Other, "{other:?}");
        }
    }

    /// A box's own mesh holds its volume. The same mesh with one face's triangles turned the other way, as a cavity
    /// wound the wrong way is, holds another, and the shell's read-back refuses it.
    #[cfg(feature = "cad")]
    #[test]
    fn a_mesh_that_holds_another_volume_than_its_body_is_refused() {
        if !sx_brep::KERNEL {
            return;
        }
        // off the origin, so every face's triangles add to the volume
        let body = Body::cuboid([5.0, 6.0, 7.0], [20.0, 10.0, 4.0]).expect("a box");
        let mesh = body.tessellate(&Tessellation::default()).expect("a mesh");
        let volume = body.volume().expect("a volume");
        assert_eq!(volume_held(&mesh, volume), Ok(()));
        let mut turned = mesh.clone();
        for (t, &f) in turned.triangles.iter_mut().zip(&mesh.faces) {
            if f == 0 {
                t.swap(1, 2);
            }
        }
        let why = volume_held(&turned, volume).expect_err("another volume");
        assert!(why.starts_with("its mesh holds"), "{why}");
    }

    #[cfg(feature = "cad")]
    #[test]
    fn the_table_is_written_as_the_faces_type_reads_it() {
        for kind in [
            Kind::Plane {
                normal: [0.0, 0.0, -1.0],
                offset: -3.0,
            },
            Kind::Cylinder {
                origin: [1.0, 2.0, 3.0],
                axis: [0.0, 1.0, 0.0],
                radius: 4.0,
            },
            Kind::Cone {
                apex: [1.0, 2.0, 7.0],
                axis: [0.0, 0.0, -1.0],
                half_angle: 0.5,
            },
            Kind::Sphere {
                center: [1.0, 2.0, 3.0],
                radius: 2.5,
            },
            Kind::Other,
        ] {
            let written = kind_json(&kind);
            assert_eq!(written, serde_json::to_value(kind).unwrap());
            assert_eq!(serde_json::from_value::<Kind>(written).unwrap(), kind);
        }
    }

    #[test]
    fn exact_surfaces_keep_the_kernel_s_kind_and_numbers() {
        let frame = json!({ "origin": [1.0, 2.0, 3.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0] });
        assert_eq!(
            surface_json(&Surface::Plane { frame: FRAME }),
            json!({ "kind": "plane", "frame": frame })
        );
        assert_eq!(
            surface_json(&Surface::Cone {
                frame: FRAME,
                radius: 4.0,
                half_angle_deg: 0.0,
                apex: None
            }),
            json!({ "kind": "cone", "frame": frame, "radius": 4.0, "halfAngleDeg": 0.0, "apex": null })
        );
        assert_eq!(
            surface_json(&Surface::Torus {
                frame: FRAME,
                major: 5.0,
                minor: 1.0
            }),
            json!({ "kind": "torus", "frame": frame, "majorRadius": 5.0, "minorRadius": 1.0 })
        );
        assert_eq!(surface_json(&Surface::Spline), json!({ "kind": "spline" }));
        assert_eq!(
            surface_json(&Surface::Other { kernel_type: 15999 }),
            json!({ "kind": "other", "kernelType": 15999 })
        );
        // the old ops' names for the same kinds, which `info` and the JSON form's `type` keep
        assert_eq!(names(&Surface::Spline), ("spline", "nurbs"));
        assert_eq!(names(&Surface::Revolved), ("revolved", "revolution"));
        assert_eq!(names(&Surface::Extruded), ("extruded", "extrusion"));
    }
}
