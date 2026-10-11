// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A small headless picture of models: an orthographic view with a z-buffer and flat shading, each object in its
//! filament color and painted pieces in theirs, as a PNG. Meant for a client to check what it made or painted, so it is
//! small by default and the same bytes on every machine.

use std::collections::BTreeMap;

use crate::mesh::{Aabb, TriMesh};
use crate::paint_tree;
use crate::vec3::{self, V3};
use crate::xform::{self, Mat4};
use crate::{Error, Result};

/// The long side of a picture when none is asked for, px.
pub const DEFAULT_SIZE: u32 = 384;
/// The smallest and largest long side, px.
pub const MIN_SIZE: u32 = 64;
pub const MAX_SIZE: u32 = 2048;

/// Colors of filament slots 1 to 8 when the request names none: the app's default palette order.
const PALETTE: [[u8; 3]; 8] = [
    [0xE8, 0xE8, 0xE8],
    [0x1F, 0x1F, 0x1F],
    [0xD9, 0x3B, 0x2B],
    [0x2E, 0x6F, 0xD8],
    [0x3C, 0xA5, 0x4A],
    [0xF2, 0xC2, 0x1B],
    [0xE0, 0x7A, 0x1F],
    [0x8E, 0x4F, 0xC9],
];
const BACKGROUND: [u8; 3] = [0xF4, 0xF4, 0xF2];

/// One model in the picture.
#[derive(Debug, Clone, Default)]
pub struct Object {
    pub mesh: TriMesh,
    /// Where the mesh sits, column-major; none for where it is.
    pub transform: Option<Mat4>,
    /// Its filament slot (1-based): the color of what is not painted.
    pub slot: u8,
    /// Its color, when given, over the slot's.
    pub color: Option<[u8; 3]>,
    /// Paint texts by triangle index (color paint: state n is filament slot n).
    pub paint: BTreeMap<u32, String>,
}

/// Where the picture looks from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// From the front left, above (the slicers' default view).
    Iso,
    /// Straight down.
    Top,
    /// From the front (minus y), level.
    Front,
    /// Framed on a box (the given focus, else the painted pieces, else everything), looking at the painted pieces
    /// against their average facing, so paint on an underside is seen from below; as `Iso` with nothing painted.
    Fit,
}

impl View {
    /// The view of a name: `iso`, `top`, `front` or `fit`.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "iso" => Some(Self::Iso),
            "top" => Some(Self::Top),
            "front" => Some(Self::Front),
            "fit" => Some(Self::Fit),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Iso => "iso",
            Self::Top => "top",
            Self::Front => "front",
            Self::Fit => "fit",
        }
    }

    /// The direction the camera looks along, and the world direction that is up in the picture.
    fn camera(self) -> (V3, V3) {
        match self {
            Self::Top => ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
            Self::Front => ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            Self::Iso | Self::Fit => ([1.0, 1.0, -1.0], [0.0, 0.0, 1.0]),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub view: View,
    /// The long side, px.
    pub size: u32,
    /// Filament colors by slot (1-based: entry 0 is slot 1); the default palette past the end.
    pub colors: Vec<[u8; 3]>,
    /// The box a `Fit` view frames.
    pub focus: Option<Aabb>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            view: View::Iso,
            size: DEFAULT_SIZE,
            colors: Vec::new(),
            focus: None,
        }
    }
}

/// An RGB picture, rows from the top.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// What the picture holds, for a client that does not ask for the image itself.
#[derive(Debug, Clone)]
pub struct Summary {
    pub view: View,
    pub width: u32,
    pub height: u32,
    /// Everything in the picture, mm.
    pub bounds: Aabb,
    /// The box the picture is framed on, mm.
    pub framed: Aabb,
    pub objects: usize,
    pub triangles: usize,
    /// Painted surface by state (filament slot for color), mm2.
    pub painted_mm2: BTreeMap<u8, f64>,
    /// Paint texts that did not parse (drawn unpainted).
    pub bad_paint: usize,
}

struct Piece {
    v: [V3; 3],
    color: [u8; 3],
}

fn slot_color(colors: &[[u8; 3]], slot: u8) -> [u8; 3] {
    let i = usize::from(slot.max(1)) - 1;
    colors
        .get(i)
        .or_else(|| PALETTE.get(i % PALETTE.len()))
        .copied()
        .unwrap_or(PALETTE[0])
}

fn tri_area(v: &[V3; 3]) -> f64 {
    vec3::len(vec3::tri_normal(v[0], v[1], v[2])) * 0.5
}

fn grow(b: &mut Option<Aabb>, p: V3) {
    match b {
        Some(bb) => {
            for ((lo, hi), v) in bb.min.iter_mut().zip(bb.max.iter_mut()).zip(p) {
                *lo = lo.min(v);
                *hi = hi.max(v);
            }
        }
        None => *b = Some(Aabb { min: p, max: p }),
    }
}

/// What the drawing reads off the objects: colored pieces in world space, the bounds of everything and of the paint,
/// the painted area by state, the area-weighted facing of the paint, and the counts.
struct Scene {
    pieces: Vec<Piece>,
    all: Option<Aabb>,
    painted_box: Option<Aabb>,
    painted: BTreeMap<u8, f64>,
    painted_facing: V3,
    bad: usize,
    tris: usize,
}

fn pieces(objects: &[Object], colors: &[[u8; 3]]) -> Scene {
    let mut out = Vec::new();
    let (mut all, mut painted_box) = (None, None);
    let mut painted: BTreeMap<u8, f64> = BTreeMap::new();
    let mut painted_facing = [0.0; 3];
    let (mut bad, mut tris) = (0usize, 0usize);
    for o in objects {
        let base = o.color.unwrap_or_else(|| slot_color(colors, o.slot));
        let place = |p: V3| o.transform.as_ref().map_or(p, |m| xform::apply(m, p));
        for (i, t) in o.mesh.triangles.iter().enumerate() {
            let Some(v) = t
                .iter()
                .map(|&k| o.mesh.positions.get(k as usize).copied().map(place))
                .collect::<Option<Vec<V3>>>()
                .and_then(|v| <[V3; 3]>::try_from(v).ok())
            else {
                continue;
            };
            tris += 1;
            for p in v {
                grow(&mut all, p);
            }
            let text = u32::try_from(i).ok().and_then(|i| o.paint.get(&i));
            let leaves = match text.map(|t| paint_tree::leaves(t, v)) {
                Some(Some(l)) => l,
                Some(None) => {
                    bad += 1;
                    vec![(v, 0)]
                }
                None => vec![(v, 0)],
            };
            for (lv, state) in leaves {
                if state > 0 {
                    *painted.entry(state).or_default() += tri_area(&lv);
                    // Half the cross product is the area-weighted normal.
                    let n = vec3::tri_normal(lv[0], lv[1], lv[2]);
                    painted_facing = [
                        painted_facing[0] + n[0] * 0.5,
                        painted_facing[1] + n[1] * 0.5,
                        painted_facing[2] + n[2] * 0.5,
                    ];
                    for p in lv {
                        grow(&mut painted_box, p);
                    }
                }
                let color = if state == 0 {
                    base
                } else {
                    slot_color(colors, state)
                };
                out.push(Piece { v: lv, color });
            }
        }
    }
    Scene {
        pieces: out,
        all,
        painted_box,
        painted,
        painted_facing,
        bad,
        tris,
    }
}

/// The picture plane: its axes, and how world points land on pixels.
struct Camera {
    right: V3,
    up: V3,
    d: V3,
    center: (f64, f64),
    scale: f64,
    width: u32,
    height: u32,
}

impl Camera {
    /// A world point as (x px, y px, depth), y down.
    fn to_px(&self, p: V3) -> (f64, f64, f64) {
        let (x, y, z) = (
            vec3::dot(p, self.right),
            vec3::dot(p, self.up),
            vec3::dot(p, self.d),
        );
        (
            (x - self.center.0) * self.scale + f64::from(self.width) / 2.0,
            f64::from(self.height) / 2.0 - (y - self.center.1) * self.scale,
            z,
        )
    }

    /// The camera of `view` framed on `framed`, `size` px on the long side; `fit` looks against `facing`.
    fn new(view: View, framed: &Aabb, facing: V3, size: u32) -> Self {
        let (mut dir, mut world_up) = view.camera();
        // Fit looks at the paint against its average facing (a little from the iso side, so flat paint keeps depth).
        if view == View::Fit
            && let Some(f) = vec3::normalize(facing)
        {
            let iso = vec3::normalize([1.0, 1.0, -1.0]).unwrap_or([0.0, 0.0, -1.0]);
            dir = vec3::normalize([iso[0] * 0.3 - f[0], iso[1] * 0.3 - f[1], iso[2] * 0.3 - f[2]])
                .unwrap_or(iso);
            // Looking nearly straight up or down, up in the picture is +y.
            if dir[2].abs() > 0.95 {
                world_up = [0.0, 1.0, 0.0];
            }
        }
        let d = vec3::normalize(dir).unwrap_or([0.0, 0.0, -1.0]);
        let right = vec3::normalize(vec3::cross(d, world_up)).unwrap_or([1.0, 0.0, 0.0]);
        let up = vec3::cross(right, d);
        // The framed box's corners on the picture plane.
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for k in 0..8 {
            let c = [
                if k & 1 == 0 { framed.min[0] } else { framed.max[0] },
                if k & 2 == 0 { framed.min[1] } else { framed.max[1] },
                if k & 4 == 0 { framed.min[2] } else { framed.max[2] },
            ];
            let (x, y) = (vec3::dot(c, right), vec3::dot(c, up));
            lo = [lo[0].min(x), lo[1].min(y)];
            hi = [hi[0].max(x), hi[1].max(y)];
        }
        let (w_mm, h_mm) = ((hi[0] - lo[0]).max(1e-6), (hi[1] - lo[1]).max(1e-6));
        let size = size.clamp(MIN_SIZE, MAX_SIZE);
        let long = f64::from(size);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a picture side between 16 and 2048 px"
        )]
        let (width, height) = if w_mm >= h_mm {
            (size, ((long * h_mm / w_mm).round() as u32).max(16))
        } else {
            (((long * w_mm / h_mm).round() as u32).max(16), size)
        };
        let margin = 0.06;
        let scale = (f64::from(width) * (1.0 - 2.0 * margin) / w_mm)
            .min(f64::from(height) * (1.0 - 2.0 * margin) / h_mm);
        Self {
            right,
            up,
            d,
            center: (f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])),
            scale,
            width,
            height,
        }
    }
}

/// The pieces drawn with a z-buffer and flat shading: the depth and the colors of each pixel.
fn draw(pieces: &[Piece], cam: &Camera) -> (Vec<f64>, Vec<u8>) {
    let (wu, hu) = (cam.width as usize, cam.height as usize);
    let mut depth = vec![f64::INFINITY; wu * hu];
    let mut rgb: Vec<u8> = BACKGROUND.iter().copied().cycle().take(wu * hu * 3).collect();
    let d = cam.d;
    // Light from above the camera's left shoulder; both sides of a face are lit alike.
    let light = vec3::normalize([-0.4 - d[0], 0.5 - d[1], 0.8 - d[2]]).unwrap_or([0.0, 0.0, 1.0]);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to the picture"
    )]
    let span = |lo: f64, hi: f64, max: usize| -> (usize, usize) {
        let l = lo.floor().max(0.0) as usize;
        let h = (hi.ceil().max(0.0) as usize).min(max);
        (l, h)
    };
    for piece in pieces {
        let n = vec3::normalize(vec3::tri_normal(piece.v[0], piece.v[1], piece.v[2]));
        let Some(n) = n else { continue };
        let shade = 0.35 + 0.65 * vec3::dot(n, light).abs();
        let col = piece.color.map(|c| {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "0 to 255")]
            let v = (f64::from(c) * shade).round().clamp(0.0, 255.0) as u8;
            v
        });
        let [a, b, c] = piece.v.map(|p| cam.to_px(p));
        let area = (b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1);
        if area.abs() < 1e-12 {
            continue;
        }
        let (x0, x1) = span(a.0.min(b.0).min(c.0), a.0.max(b.0).max(c.0), wu);
        let (y0, y1) = span(a.1.min(b.1).min(c.1), a.1.max(b.1).max(c.1), hu);
        for py in y0..y1 {
            let yc = py as f64 + 0.5;
            for px in x0..x1 {
                let xc = px as f64 + 0.5;
                let w0 = ((b.0 - xc) * (c.1 - yc) - (c.0 - xc) * (b.1 - yc)) / area;
                let w1 = ((c.0 - xc) * (a.1 - yc) - (a.0 - xc) * (c.1 - yc)) / area;
                let w2 = 1.0 - w0 - w1;
                if w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9 {
                    continue;
                }
                let z = w0 * a.2 + w1 * b.2 + w2 * c.2;
                let k = py * wu + px;
                if let Some(slot) = depth.get_mut(k)
                    && z < *slot
                {
                    *slot = z;
                    if let Some(px3) = rgb.get_mut(k * 3..k * 3 + 3) {
                        px3.copy_from_slice(&col);
                    }
                }
            }
        }
    }
    (depth, rgb)
}

/// Darkens each pixel next to background or to a depth jump of more than a millimetre, so shapes read in a small
/// picture.
fn darken_edges(depth: &[f64], rgb: &mut [u8], wu: usize, hu: usize) {
    let jump = 1.0;
    let mut edge = vec![false; wu * hu];
    for py in 0..hu {
        for px in 0..wu {
            let k = py * wu + px;
            let Some(&z) = depth.get(k) else { continue };
            if !z.is_finite() {
                continue;
            }
            let near = [
                (px > 0).then(|| k - 1),
                (px + 1 < wu).then(|| k + 1),
                (py > 0).then(|| k - wu),
                (py + 1 < hu).then(|| k + wu),
            ];
            if near.iter().flatten().any(|&j| {
                depth
                    .get(j)
                    .is_some_and(|&o| !o.is_finite() || (o - z).abs() > jump)
            }) && let Some(e) = edge.get_mut(k)
            {
                *e = true;
            }
        }
    }
    for (k, e) in edge.iter().enumerate() {
        if *e && let Some(px3) = rgb.get_mut(k * 3..k * 3 + 3) {
            for c in px3 {
                *c = c.saturating_sub(*c / 3);
            }
        }
    }
}

/// Draws the objects. Fails when there is nothing to draw.
pub fn render(objects: &[Object], opts: &Options) -> Result<(Image, Summary)> {
    let scene = pieces(objects, &opts.colors);
    let bounds = scene
        .all
        .ok_or_else(|| Error::invalid("objects", "nothing to draw"))?;
    let framed = match opts.view {
        View::Fit => opts.focus.or(scene.painted_box).unwrap_or(bounds),
        _ => bounds,
    };
    let cam = Camera::new(opts.view, &framed, scene.painted_facing, opts.size);
    let (depth, mut rgb) = draw(&scene.pieces, &cam);
    darken_edges(&depth, &mut rgb, cam.width as usize, cam.height as usize);
    let summary = Summary {
        view: opts.view,
        width: cam.width,
        height: cam.height,
        bounds,
        framed,
        objects: objects.len(),
        triangles: scene.tris,
        painted_mm2: scene.painted,
        bad_paint: scene.bad,
    };
    Ok((
        Image {
            width: cam.width,
            height: cam.height,
            rgb,
        },
        summary,
    ))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    let len = u32::try_from(data.len()).unwrap_or(u32::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    let start = out.len();
    out.extend_from_slice(&kind);
    out.extend_from_slice(data);
    let crc = crc32(out.get(start..).unwrap_or_default());
    out.extend_from_slice(&crc.to_be_bytes());
}

/// The picture as a PNG file (8-bit RGB, no filtering).
#[must_use]
pub fn png(img: &Image) -> Vec<u8> {
    let row = img.width as usize * 3;
    let mut raw = Vec::with_capacity((row + 1) * img.height as usize);
    for r in img.rgb.chunks(row.max(1)) {
        raw.push(0);
        raw.extend_from_slice(r);
    }
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&img.width.to_be_bytes());
    ihdr.extend_from_slice(&img.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, *b"IHDR", &ihdr);
    chunk(
        &mut out,
        *b"IDAT",
        &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6),
    );
    chunk(&mut out, *b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20 mm cube with its top painted slot 2 and, on one side, a split triangle half slot 3.
    fn painted_cube() -> Object {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
            [0.0, 0.0, 20.0],
            [20.0, 0.0, 20.0],
            [20.0, 20.0, 20.0],
            [0.0, 20.0, 20.0],
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let paint = BTreeMap::from([(2, "8".to_owned()), (3, "8".to_owned()), (4, "0C01".to_owned())]);
        Object {
            mesh: TriMesh::new(positions, triangles),
            transform: None,
            slot: 1,
            color: Some([0xFF, 0x80, 0x00]),
            paint,
        }
    }

    fn fnv(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in bytes {
            h = (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }

    #[test]
    fn a_picture_is_the_same_bytes_every_time_and_counts_the_paint() {
        let cube = [painted_cube()];
        let opts = Options {
            colors: vec![[0xFF, 0x80, 0x00], [0xFF, 0xFF, 0x80], [0x00, 0x80, 0x80]],
            ..Options::default()
        };
        let (a, s) = render(&cube, &opts).unwrap();
        let (b, _) = render(&cube, &opts).unwrap();
        assert_eq!(a, b);
        // The long side is the size asked for; the cube from the front left is taller than wide.
        assert_eq!((s.width, s.height), (333, 384), "{s:?}");
        assert_eq!(s.triangles, 12);
        assert!(
            (s.painted_mm2.get(&2).copied().unwrap_or(0.0) - 400.0).abs() < 1e-9,
            "{s:?}"
        );
        assert!(
            (s.painted_mm2.get(&3).copied().unwrap_or(0.0) - 100.0).abs() < 1e-9,
            "{s:?}"
        );
        // The yellow top shows from above, the teal side from the front, and the picture is not all background.
        let count = |img: &Image, near: [u8; 3]| {
            img.rgb
                .chunks(3)
                .filter(|p| {
                    p.iter()
                        .zip(near)
                        .all(|(&c, n)| (i16::from(c) - i16::from(n)).abs() < 40)
                })
                .count()
        };
        let top = render(
            &cube,
            &Options {
                view: View::Top,
                ..opts.clone()
            },
        )
        .unwrap()
        .0;
        assert!(
            count(&top, [0xFF, 0xFF, 0x80]) > 50_000,
            "{}",
            count(&top, [0xFF, 0xFF, 0x80])
        );
        let front = render(
            &cube,
            &Options {
                view: View::Front,
                ..opts.clone()
            },
        )
        .unwrap()
        .0;
        // Teal by hue: shading darkens it.
        let teal = front
            .rgb
            .chunks(3)
            .filter(|p| p[0] < 30 && p[1] > 50 && p[1].abs_diff(p[2]) < 6)
            .count();
        assert!(teal > 5_000, "{teal}");
        assert!(count(&front, BACKGROUND) < 384 * 384);
    }

    #[test]
    fn each_view_has_its_own_fixed_picture() {
        // Hashes of the pictures: a change to drawing shows here (update them when the change is meant).
        let cube = [painted_cube()];
        let hashes: Vec<(String, u64, u32, u32)> = ["iso", "top", "front", "fit"]
            .iter()
            .map(|v| {
                // `fit` framed on the top corner the paint is in.
                let focus = (*v == "fit").then_some(Aabb {
                    min: [0.0, 0.0, 15.0],
                    max: [10.0, 10.0, 20.0],
                });
                let (img, s) = render(
                    &cube,
                    &Options {
                        view: View::parse(v).unwrap(),
                        focus,
                        ..Options::default()
                    },
                )
                .unwrap();
                ((*v).to_owned(), fnv(&img.rgb), s.width, s.height)
            })
            .collect();
        let want: [(&str, u64, u32, u32); 4] = [
            ("iso", 9_727_058_463_317_265_956, 333, 384),
            ("top", 17_210_977_758_052_143_557, 384, 384),
            ("front", 15_313_260_867_482_292_959, 384, 384),
            ("fit", 15_012_644_574_990_136_150, 359, 384),
        ];
        let got: Vec<(&str, u64, u32, u32)> = hashes
            .iter()
            .map(|(v, h, w, ht)| (v.as_str(), *h, *w, *ht))
            .collect();
        assert_eq!(got, want);
    }

    #[test]
    fn fit_looks_at_paint_on_an_underside_from_below() {
        let mut cube = painted_cube();
        // Only the bottom painted, slot 3.
        cube.paint = BTreeMap::from([(0, "0C".to_owned()), (1, "0C".to_owned())]);
        let opts = Options {
            colors: vec![[0xFF, 0x80, 0x00], [0xFF, 0xFF, 0x80], [0x00, 0x80, 0x80]],
            ..Options::default()
        };
        let teal = |img: &Image| {
            img.rgb
                .chunks(3)
                .filter(|p| p[0] < 30 && p[1] > 50 && p[1].abs_diff(p[2]) < 6)
                .count()
        };
        let iso = render(std::slice::from_ref(&cube), &opts).unwrap().0;
        assert_eq!(teal(&iso), 0, "the bottom is hidden from above");
        let fit = render(
            &[cube],
            &Options {
                view: View::Fit,
                ..opts
            },
        )
        .unwrap()
        .0;
        assert!(teal(&fit) > 20_000, "{}", teal(&fit));
    }

    #[test]
    fn fit_frames_the_painted_pieces() {
        let cube = [painted_cube()];
        let (_, s) = render(
            &cube,
            &Options {
                view: View::Fit,
                ..Options::default()
            },
        )
        .unwrap();
        // The painted top and the painted side: the whole top face and a side triangle.
        assert!(
            (s.framed.max[2] - 20.0).abs() < 1e-9 && s.framed.min[2] >= 0.0,
            "{s:?}"
        );
        let (_, all) = render(&cube, &Options::default()).unwrap();
        assert_eq!(all.framed, all.bounds);
    }

    #[test]
    fn the_png_is_a_valid_file_of_the_picture() {
        let (img, _) = render(
            &[painted_cube()],
            &Options {
                size: 64,
                ..Options::default()
            },
        )
        .unwrap();
        let file = png(&img);
        assert_eq!(&file[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&file[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(file[16..20].try_into().unwrap()), img.width);
        // The image data inflates back to the rows.
        let idat = file.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(file[idat - 4..idat].try_into().unwrap()) as usize;
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&file[idat + 4..idat + 4 + len]).unwrap();
        assert_eq!(raw.len(), (img.width as usize * 3 + 1) * img.height as usize);
        assert_eq!(&raw[1..4], &img.rgb[0..3]);
        // The chunk checksum covers the kind and the data.
        let crc = u32::from_be_bytes(file[idat + 4 + len..idat + 8 + len].try_into().unwrap());
        assert_eq!(crc, crc32(&file[idat..idat + 4 + len]));
    }

    #[test]
    fn nothing_to_draw_is_an_error_and_a_bad_text_draws_unpainted() {
        assert!(render(&[], &Options::default()).is_err());
        let mut cube = painted_cube();
        cube.paint.insert(0, "zz".to_owned());
        let (_, s) = render(&[cube], &Options::default()).unwrap();
        assert_eq!(s.bad_paint, 1);
    }
}
