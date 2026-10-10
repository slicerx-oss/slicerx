// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 6: path planning. Orders one layer's extrusions and estimates its
//! time. Every decision uses only this layer's geometry (the cursor starts at
//! the bed origin on every layer), which keeps sharded output exact.

use crate::config::{PrintConfig, SeamPosition, WallSequence};
use crate::fm::Fm as _;
use crate::geom::{Point, SCALE};
use crate::infill::{Dir, Iv};
use crate::output::{Feature, LayerPaths, PathInfo};
use crate::overhang::Overhang;
use crate::perimeters::IslandWalls;
use crate::perimeters::Shapes;
use i_overlay::i_float::int::point::IntPoint;

/// Everything one filament slot prints on one layer.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolWork {
    pub(crate) tool: u8,
    pub(crate) brim: Vec<Vec<IntPoint<i32>>>,
    pub(crate) skirt: Vec<Vec<IntPoint<i32>>>,
    /// Prime tower wall and purge rows, printed first: the purge follows the tool change.
    pub(crate) tower: Vec<crate::tower::TowerPath>,
    /// Prime tower rows printed last, right before the next tool change: the old filament rammed out
    /// before the nozzle changes (Bambu Studio's nozzle change block).
    pub(crate) tower_after: Vec<crate::tower::TowerPath>,
    /// The sparse infill prints first, right after the tool change, to take up the purged filament.
    pub(crate) flush_first: bool,
    /// Bead width of a region with its own line width (a modifier volume), mm.
    pub(crate) width: Option<f32>,
    pub(crate) islands: Vec<IslandWalls>,
    pub(crate) sparse: Vec<[Point; 2]>,
    /// Sparse infill from patterns that are not straight scanlines.
    pub(crate) sparse_paths: Vec<Vec<Point>>,
    /// Sparse paths of their own line width (locked zag's skin and skeleton), mm.
    pub(crate) sparse_alt: Vec<(f32, Vec<Vec<Point>>)>,
    /// Sparse paths of combined layers (`infill_combination`), with their flow against a bead of this layer.
    pub(crate) sparse_thick: Vec<(f32, Vec<Vec<Point>>)>,
    /// Support and its dense interface, printed before the walls.
    pub(crate) support: Vec<Vec<Point>>,
    pub(crate) support_interface: Vec<Vec<Point>>,
    /// Ironing over the top support contact (`support_ironing`), printed after the interface.
    pub(crate) support_ironing: Vec<Vec<Point>>,
    /// Flow of the support beads against a bead of this layer's height: a support layer of
    /// another thickness printed at the same height. 0 means 1.
    pub(crate) support_flow: f32,
    pub(crate) bottom: Vec<[Point; 2]>,
    /// Solid infill of the top shell under the visible top surface.
    pub(crate) shell: Vec<[Point; 2]>,
    /// Narrow bands of the solid shell, filled with variable-width beads.
    pub(crate) shell_thick: Vec<crate::arachne::WallLine>,
    /// Gap beads between a surface's lines and its edge (`gap_fill_target`).
    pub(crate) gap_bottom: Vec<crate::arachne::WallLine>,
    pub(crate) gap_shell: Vec<crate::arachne::WallLine>,
    pub(crate) gap_top: Vec<crate::arachne::WallLine>,
    /// The surfaces the fill lines belong to, one shape each: Orca fills and orders each one as a unit.
    /// The area painted with fuzzy skin on this layer: the outer walls get fuzzy skin where they run inside it.
    pub(crate) fuzzy_paint: Option<Shapes>,
    pub(crate) region_bottom: Shapes,
    pub(crate) region_shell: Shapes,
    /// The narrow bands `shell_thick` fills: Orca fills each one as a collection of its own.
    pub(crate) region_narrow: Shapes,
    pub(crate) region_sparse: Shapes,
    pub(crate) region_top: Shapes,
    /// Solid infill over sparse infill, printed as thick strands.
    pub(crate) internal_bridge: Vec<[Point; 2]>,
    /// Internal bridge strands joined along the walls.
    pub(crate) internal_bridge_paths: Vec<Vec<Point>>,
    pub(crate) top: Vec<[Point; 2]>,
    /// Bridge strands over air, printed with round strands of `bridge_width`.
    pub(crate) bridge: Vec<[Point; 2]>,
    /// Bridge strands joined along the walls.
    pub(crate) bridge_paths: Vec<Vec<Point>>,
    /// Wave overhang rings (`wave_overhangs`), their extrusion in mm3 per mm and speed in mm/s.
    pub(crate) wave_paths: Vec<Vec<Point>>,
    pub(crate) wave_flow: f32,
    pub(crate) wave_speed: f32,
    pub(crate) bridge_width: f32,
    /// Zero for round strands; otherwise the flow of flat bridge beads against a normal bead.
    pub(crate) bridge_flat_flow: f32,
    /// Internal bridge strands: round with this diameter (mm), or zero for normal beads at `internal_bridge_ratio`.
    pub(crate) internal_bridge_width: f32,
    pub(crate) internal_bridge_ratio: f32,
    /// Set when some wall of this layer hangs over the layer below.
    pub(crate) overhang: Option<crate::overhang::Overhang>,
    /// Point by point overhang speeds for walls and bridges (`enable_overhang_speed`).
    pub(crate) quality: Option<std::sync::Arc<crate::quality::Context>>,
    /// Extra perimeters on overhangs (`extraperim.rs`), printed before the walls of their island as overhang
    /// walls, with their bead width (mm) and flow against a normal bead.
    pub(crate) extra_perimeters: Vec<Vec<IntPoint<i32>>>,
    pub(crate) extra_width: f32,
    pub(crate) extra_flow: f32,
}

/// Speeds for one layer, mm/s.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Speeds {
    outer: f32,
    inner: f32,
    sparse: f32,
    solid: f32,
    top: f32,
    brim: f32,
    /// Loops no longer than this many mm print at the speed beside it (`small_perimeter_*`).
    small: Option<(f64, f32)>,
}

impl Speeds {
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    pub(crate) fn for_layer(c: &PrintConfig, layer: u32) -> Self {
        // Brim and skirt are not walls to Orca (`GCode::_extrude`, `is_perimeter`): on the first layer they
        // print at the first layer's infill speed, above it at the support speed (what `extrude_skirt` and the
        // brim pass in), ramped by `slow_down_layers` like infill.
        let brim_first = c.initial_layer_infill_speed as f32;
        // Over a raft the part's first layer is an ordinary layer.
        if layer == 0 && crate::raft::layers_asked(c) == 0 {
            let wall = c.initial_layer_speed as f32;
            let infill = c.initial_layer_infill_speed as f32;
            Self {
                outer: wall,
                inner: wall,
                sparse: infill,
                solid: infill,
                top: infill,
                brim: brim_first,
                small: None,
            }
        } else {
            let mut me = Self {
                outer: c.outer_wall_speed as f32,
                inner: c.inner_wall_speed as f32,
                sparse: c.sparse_infill_speed as f32,
                solid: c.internal_solid_infill_speed as f32,
                top: c.top_surface_speed as f32,
                brim: if layer == 0 {
                    brim_first
                } else {
                    c.support.speed as f32
                },
                small: Self::small(c),
            };
            // `slow_down_layers`: the first layers climb linearly from the first layer's speeds to the
            // profile's (Orca: `GCode::_extrude`).
            let slow = c.raw_number("slow_down_layers", 0.0);
            if slow > 1.0 && f64::from(layer) < slow {
                let t = (f64::from(layer) / slow) as f32;
                let ramp = |first: f64, v: f32| -> f32 {
                    let first = first as f32;
                    if first < v {
                        v.min(first + (v - first) * t)
                    } else {
                        v
                    }
                };
                let (wall, infill) = (c.initial_layer_speed, c.initial_layer_infill_speed);
                me.outer = ramp(wall, me.outer);
                me.inner = ramp(wall, me.inner);
                me.sparse = ramp(infill, me.sparse);
                me.solid = ramp(infill, me.solid);
                me.top = ramp(infill, me.top);
                me.brim = ramp(infill, me.brim);
            }
            me
        }
    }

    /// Orca (`GCode::extrude_loop`): a loop of at most `small_perimeter_threshold` times 2 pi mm prints at
    /// `small_perimeter_speed` (a speed or a percent of the outer wall speed; 0 means half of it).
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    fn small(c: &PrintConfig) -> Option<(f64, f32)> {
        let threshold = c.raw_number("small_perimeter_threshold", 0.0);
        if threshold <= 0.0 {
            return None;
        }
        let outer = c.outer_wall_speed;
        let speed = match c.raw.get("small_perimeter_speed") {
            Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => t
                .trim()
                .trim_end_matches('%')
                .trim()
                .parse::<f64>()
                .ok()
                .map(|p| outer * p / 100.0),
            _ => crate::motion::raw_f(c, "small_perimeter_speed"),
        }
        .filter(|v| *v > 0.0)
        .unwrap_or(outer * 0.5);
        Some((threshold * std::f64::consts::TAU, speed as f32))
    }

    /// The speed of a wall loop of `len_mm`: the small perimeter speed when the loop is short enough.
    fn loop_speed(&self, base: f32, len_mm: f64) -> f32 {
        match self.small {
            Some((limit, v)) if len_mm <= limit => v,
            _ => base,
        }
    }
}

/// Length of a closed ring in mm.
fn ring_len_mm(c: &[IntPoint<i32>]) -> f64 {
    c.iter()
        .zip(c.iter().cycle().skip(1))
        .map(|(a, b)| f64::from(a.x - b.x).m_hypot(f64::from(a.y - b.y)))
        .sum::<f64>()
        / SCALE
}

/// Turns spans on scanline family `(dir, spacing)` into lines in serpentine order.
pub(crate) fn span_lines(spans: &[Iv], dir: Dir, spacing: i64, out: &mut Vec<[Point; 2]>) {
    let mut row = 0usize;
    let mut i = 0;
    while let Some(first) = spans.get(i) {
        let k = first.k;
        let end = i + spans
            .get(i..)
            .map_or(0, |r| r.iter().take_while(|s| s.k == k).count());
        let s = i64::from(k) * spacing;
        let row_spans = spans.get(i..end).unwrap_or(&[]);
        if row.is_multiple_of(2) {
            for iv in row_spans {
                out.push([dir.point(s, iv.t0), dir.point(s, iv.t1)]);
            }
        } else {
            for iv in row_spans.iter().rev() {
                out.push([dir.point(s, iv.t1), dir.point(s, iv.t0)]);
            }
        }
        row += 1;
        i = end;
    }
}

struct Builder<'a> {
    out: &'a mut LayerPaths,
    cursor: Point,
    width_mm: f32,
    flow: f32,
    seam: SeamPosition,
    layer: u32,
    /// The planned seams of the whole object (`seamplan.rs`), read by wall rings.
    plan: Option<&'a crate::seamplan::Plan>,
    /// Painted seam pieces near this layer, and the layer's height.
    faces: &'a [crate::seam::SeamFace],
    z: f64,
    /// The layer below as the walls see it, so a seam avoids stretches that hang free.
    hang: Option<&'a Overhang>,
    /// `wall_direction` = `cw`: outlines print clockwise and holes counterclockwise (Orca's default,
    /// `ccw`, is the other way round, which is how the rings come).
    clockwise: bool,
    /// Fuzzy skin settings, when the print has any.
    fuzzy: Option<crate::fuzzy::Fuzzy>,
    /// Fuzzy skin of a painted area, and the painted area of the work being planned.
    painted: Option<crate::fuzzy::Fuzzy>,
    fuzzy_mask: Option<Shapes>,
    /// `filament_max_volumetric_speed` of each filament slot (mm3/s), 0 for none.
    vol_caps: Vec<f64>,
    /// Scarf seams (`seam_slope_type`), and the seam gap that ends every loop short of its start, mm.
    scarf: Option<crate::scarf::Scarf>,
    gap: f64,
    /// Where the next skirt loop wants to start, mm (`skirt_start_angle`, first layer's first loop).
    start_point: Option<[f64; 2]>,
    /// How far the seam of the last wall ring hangs past the layer below (Orca `seam_overhang`).
    unsupported: std::cell::Cell<f32>,
    /// Points with their own Z and flow: (index, z, flow).
    pz: Vec<(u32, f32, f32)>,
}

impl Builder<'_> {
    /// A speed held to the filament's volumetric limit (Orca: `filament_max_volumetric_speed` over the bead's
    /// cross-section, a rectangle with rounded ends, times the flow ratio).
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    fn capped(&self, tool: u8, speed: f32) -> f32 {
        let Some(&cap) = self
            .vol_caps
            .get(usize::from(tool.max(1) - 1))
            .filter(|c| **c > 0.0)
        else {
            return speed;
        };
        let h = f64::from(self.out.height);
        let area =
            h * (f64::from(self.width_mm) - h * (1.0 - std::f64::consts::FRAC_PI_4)) * f64::from(self.flow);
        if area > 0.0 {
            speed.min((cap / area) as f32)
        } else {
            speed
        }
    }

    fn push(&mut self, tool: u8, feature: Feature, speed: f32, pts: impl Iterator<Item = Point>) {
        let speed = self.capped(tool, speed);
        #[allow(
            clippy::cast_possible_truncation,
            reason = "per-layer point counts fit in u32"
        )]
        let start = self.out.points.len() as u32;
        self.out.points.extend(pts);
        #[allow(
            clippy::cast_possible_truncation,
            reason = "per-layer point counts fit in u32"
        )]
        let end = self.out.points.len() as u32;
        if end >= start + 2 {
            if let Some(last) = self.out.points.last() {
                self.cursor = *last;
            }
            self.out.paths.push(PathInfo {
                start,
                end,
                tool,
                feature,
                speed_mm_s: speed,
                width_mm: self.width_mm,
                flow: self.flow,
                dz: 0.0,
                overhang_fan: false,
                owner: crate::preview::OBJECT_NONE,
            });
        } else {
            self.out.points.truncate(start as usize);
        }
    }

    /// A ring rotated to start at its seam (the rearmost point, then leftmost, unless the seam
    /// setting or a painted seam says otherwise). Painted enforcers add points along the ring.
    fn seam_ring(&self, c: &[IntPoint<i32>], wall: Option<bool>) -> Option<Vec<IntPoint<i32>>> {
        let key = (u64::from(self.layer) << 32) ^ self.out.paths.len() as u64;
        // Painted seams are part of the plan when there is one; otherwise they place the ring on their own.
        if self.plan.is_none()
            && let Some(mut r) = crate::seam::painted(
                c,
                self.faces,
                self.z,
                self.seam,
                self.cursor,
                key,
                f64::from(self.width_mm),
            )
        {
            self.orient(&mut r);
            return Some(r);
        }
        // The planned seam of the wall ring (aligned strings, visibility, overhang), where a plan exists.
        if let (Some(plan), Some(inner)) = (self.plan, wall)
            && let Some(placed) = plan.seam(self.layer, c, inner, [self.cursor.x_mm(), self.cursor.y_mm()])
            && let Some(mut ring) = crate::seamplan::start_at(c, placed.at)
        {
            self.unsupported.set(placed.unsupported);
            self.orient(&mut ring);
            return Some(ring);
        }
        self.unsupported.set(f32::MIN);
        // Orca's seam scoring puts overhang first: a point over air is chosen only when every point is.
        let supported: Option<Vec<bool>> = self.hang.and_then(|o| {
            let flags: Vec<bool> = c.iter().map(|p| !o.hangs(*p)).collect();
            (flags.iter().any(|f| *f) && flags.iter().any(|f| !*f)).then_some(flags)
        });
        let seam = seam_index(c, self.seam, self.cursor, key, supported.as_deref())?;
        let n = c.len();
        let mut ring: Vec<IntPoint<i32>> = (0..n).filter_map(|i| c.get((seam + i) % n).copied()).collect();
        self.orient(&mut ring);
        Some(ring)
    }

    /// Turns a ring round, keeping its first point, when the wall direction asks for it.
    /// The height of the slicing plane, mm: the middle of the layer.
    fn slice_z(&self) -> f64 {
        f64::from(self.out.z) - f64::from(self.out.height) / 2.0
    }

    fn orient(&self, ring: &mut [IntPoint<i32>]) {
        if self.clockwise
            && let Some(rest) = ring.get_mut(1..)
        {
            rest.reverse();
        }
    }

    fn push_loop(&mut self, tool: u8, feature: Feature, speed: f32, c: &[IntPoint<i32>]) {
        let wall = match feature {
            Feature::OuterWall => Some(false),
            Feature::InnerWall => Some(true),
            _ => None,
        };
        // Orca (`extrude_loop`): only walls have seams; skirt and brim loops start at the point of the loop
        // nearest the nozzle (the skirt's first loop on the first layer, nearest the start angle's point).
        if matches!(feature, Feature::Skirt | Feature::Brim) {
            let at = self
                .start_point
                .take()
                .unwrap_or([self.cursor.x_mm(), self.cursor.y_mm()]);
            let Some(mut ring) = crate::seamplan::start_at(c, at) else {
                return;
            };
            self.orient(&mut ring);
            self.push_closed(tool, feature, speed, &ring, None, false);
            return;
        }
        let Some(ring) = self.seam_ring(c, wall) else {
            return;
        };
        self.push_closed(tool, feature, speed, &ring, wall, crate::geom::area2_int(c) < 0);
    }

    /// A closed loop that starts at `ring[0]`: with a scarf joint when the settings ask for one, else
    /// ending the seam gap short of its start.
    fn push_closed(
        &mut self,
        tool: u8,
        feature: Feature,
        speed: f32,
        ring: &[IntPoint<i32>],
        wall: Option<bool>,
        hole: bool,
    ) {
        if let (Some(inner), Some(sc), true) = (wall, self.scarf, self.layer > 0)
            && sc.applies(ring, hole, inner, self.unsupported.get(), self.width_mm)
            && let Some(plan) = sc.slope(ring, self.gap, f64::from(self.out.height), inner)
        {
            let (top, h) = (self.out.z, self.out.height);
            for (part, a, bnd) in &plan.parts {
                let sp = if *part == crate::scarf::Part::Flat {
                    speed
                } else {
                    sc.speed_for(speed)
                };
                let at = self.out.points.len();
                let before = self.out.paths.len();
                self.push(
                    tool,
                    feature,
                    sp,
                    plan.points.get(*a..*bnd).unwrap_or(&[]).iter().copied(),
                );
                if self.out.paths.len() > before {
                    for (k, i) in (*a..*bnd).enumerate() {
                        let zr = plan.z_ratio.get(i).copied().unwrap_or(1.0);
                        let fl = plan.flow.get(i).copied().unwrap_or(1.0);
                        let idx = u32::try_from(at + k).unwrap_or(u32::MAX);
                        self.pz.push((idx, top - h * (1.0 - zr), fl));
                    }
                }
            }
            return;
        }
        let mut pts: Vec<Point> = ring
            .iter()
            .chain(ring.first())
            .map(|p| Point::new(p.x, p.y))
            .collect();
        if self.gap > 0.0 {
            crate::scarf::clip_end(&mut pts, self.gap);
        }
        self.push(tool, feature, speed, pts.into_iter());
    }

    /// A wall loop: like [`Self::push_loop`], with the stretches that hang
    /// over the layer below written as overhang walls.
    fn push_wall(
        &mut self,
        tool: u8,
        feature: Feature,
        speed: f32,
        c: &[IntPoint<i32>],
        ov: Option<&Overhang>,
    ) {
        let wall = Some(feature != Feature::OuterWall);
        let ring = self.seam_ring(c, wall);
        let split = ov.and_then(|o| o.split(ring.as_deref()?).map(|pieces| (o, pieces)));
        let Some((o, pieces)) = split else {
            if let Some(r) = ring {
                self.push_closed(tool, feature, speed, &r, wall, crate::geom::area2_int(c) < 0);
            }
            return;
        };
        let last = pieces.len().saturating_sub(1);
        for (n, (pts, tier)) in pieces.into_iter().enumerate() {
            let (f, sp) = match tier {
                None => (feature, speed),
                Some(t) => (
                    if o.labeled(t) {
                        Feature::OverhangWall
                    } else {
                        feature
                    },
                    o.speed(t).unwrap_or(speed),
                ),
            };
            let mut line: Vec<Point> = pts.iter().map(|p| Point::new(p.x, p.y)).collect();
            if n == last && self.gap > 0.0 {
                crate::scarf::clip_end(&mut line, self.gap);
            }
            self.push_bead(tool, f, sp, line, o);
        }
    }

    /// A piece of wall; an overhang wall prints with Orca's overhang flow (`Overhang::bead`).
    fn push_bead(&mut self, tool: u8, feature: Feature, speed: f32, line: Vec<Point>, o: &Overhang) {
        if feature != Feature::OverhangWall {
            self.push(tool, feature, speed, line.into_iter());
            return;
        }
        let keep = (self.width_mm, self.flow);
        (self.width_mm, self.flow) = o.bead();
        self.push(tool, feature, speed, line.into_iter());
        (self.width_mm, self.flow) = keep;
    }

    /// The variable-width wall lines of an island: the walls in the order the wall sequence asks for,
    /// gap-filling lines after them. Each line is cut where its width changes by more than 0.05 mm,
    /// and each piece is printed at its own width.
    fn push_wide(
        &mut self,
        tool: u8,
        lines: &[crate::arachne::WallLine],
        cfg: &PrintConfig,
        speeds: &Speeds,
        overhang: Option<&Overhang>,
    ) {
        if lines.is_empty() {
            return;
        }
        let max_k = lines
            .iter()
            .filter(|l| !l.is_odd)
            .map(|l| l.inset)
            .max()
            .unwrap_or(0);
        let key = |l: &crate::arachne::WallLine| -> usize {
            if l.is_odd {
                return usize::MAX;
            }
            let k = l.inset;
            match cfg.wall_sequence {
                WallSequence::InnerOuter => max_k - k,
                WallSequence::OuterInner => k,
                WallSequence::InnerOuterInner if k == max_k => 0,
                WallSequence::InnerOuterInner if k == 0 => 1,
                WallSequence::InnerOuterInner => 2 + max_k - k,
            }
        };
        // Inner-outer and outer-inner walls follow Orca's adjacency order (`WallToolPaths::getRegionOrder`); the
        // sandwich sequence keeps its own order above the first layer, where Orca reorders after that walk.
        let order: Vec<usize> = match cfg.wall_sequence {
            WallSequence::InnerOuterInner if self.layer > 0 => {
                let mut order: Vec<usize> = (0..lines.len()).collect();
                crate::sorting::sort_by_key(&mut order, |i| lines.get(*i).map_or(usize::MAX, &key));
                order
            }
            WallSequence::OuterInner => crate::arachne::wall_order(lines, true),
            _ => crate::arachne::wall_order(lines, false),
        };
        let base = (self.width_mm, self.flow);
        for i in order {
            let Some(l) = lines.get(i) else { continue };
            let (feature, speed) = if l.inset == 0 {
                (Feature::OuterWall, speeds.outer)
            } else {
                (Feature::InnerWall, speeds.inner)
            };
            let (mut pts, mut widths) = (l.points.clone(), l.widths.clone());
            let speed = if l.closed {
                speeds.loop_speed(speed, ring_len_mm(&pts))
            } else {
                speed
            };
            if l.closed && pts.len() > 3 {
                // Start the closed wall at its seam.
                pts.pop();
                widths.pop();
                let inset = u32::try_from(l.inset).unwrap_or(u32::MAX);
                // Arachne writes contours clockwise.
                let contour = crate::geom::area2_int(&pts) < 0;
                let seed = (u64::from(self.layer) << 40) ^ ((l.inset as u64) << 32) ^ ring_hash(&pts);
                if let Some(f) = self.fuzzy.filter(|f| f.applies(self.layer, inset, contour)) {
                    (pts, widths) = f.wide(&pts, &widths, seed, self.slice_z(), self.layer);
                } else if let (Some(f), Some(mask)) = (
                    self.painted.filter(|f| f.applies(self.layer, inset, contour)),
                    self.fuzzy_mask.as_ref(),
                ) {
                    // Fuzzy skin only where the wall runs through a painted area.
                    (pts, widths) = f.wide_in(&pts, &widths, mask, seed, self.slice_z(), self.layer);
                }
                // Arachne writes contours clockwise and holes counterclockwise.
                let hole = crate::geom::area2_int(&pts) > 0;
                if let Some(ring) = self.seam_ring(&pts, Some(l.inset != 0)) {
                    let find = |p: &IntPoint<i32>| {
                        pts.iter()
                            .position(|q| q == p)
                            .and_then(|k| widths.get(k).copied())
                    };
                    // A seam placed between two vertices is a new point: its width is the one along its edge, not the
                    // first vertex's (a random or aligned seam on a wide bead's edge gave the whole first edge the
                    // width of wherever the ring used to start).
                    let mut last = widths.first().copied().unwrap_or(0);
                    let new_widths: Vec<i32> = ring
                        .iter()
                        .map(|p| {
                            if let Some(w) = find(p).or_else(|| width_on_ring(&pts, &widths, *p)) {
                                last = w;
                            }
                            last
                        })
                        .collect();
                    pts = ring;
                    widths = new_widths;
                }
                if let (Some(f), Some(fw)) = (pts.first().copied(), widths.first().copied()) {
                    pts.push(f);
                    widths.push(fw);
                }
                if self.scarf_wide(tool, feature, speed, &pts, &widths, l.inset != 0, hole) {
                    continue;
                }
                if self.gap > 0.0 {
                    let mut line: Vec<Point> = pts.iter().map(|p| Point::new(p.x, p.y)).collect();
                    crate::scarf::clip_end(&mut line, self.gap);
                    pts = line.iter().map(|p| IntPoint::new(p.x, p.y)).collect();
                    widths.truncate(pts.len());
                }
            }
            // Stretches that hang over the layer below print as overhang walls, at their own speed.
            let pieces = overhang.and_then(|o| o.split_path(&pts).map(|pieces| (o, pieces)));
            let Some((o, pieces)) = pieces else {
                self.push_thick(tool, feature, speed, &pts, &widths);
                continue;
            };
            for (piece, tier) in pieces {
                let (f, sp) = match tier {
                    None => (feature, speed),
                    Some(t) => (
                        if o.labeled(t) {
                            Feature::OverhangWall
                        } else {
                            feature
                        },
                        o.speed(t).unwrap_or(speed),
                    ),
                };
                if f == Feature::OverhangWall {
                    let line: Vec<Point> = piece.iter().map(|p| Point::new(p.x, p.y)).collect();
                    self.push_bead(tool, f, sp, line, o);
                    continue;
                }
                // The width of a cut point is the one of the nearest junction.
                let piece_widths: Vec<i32> = piece
                    .iter()
                    .map(|q| {
                        pts.iter()
                            .zip(&widths)
                            .min_by_key(|(p, _)| {
                                let (dx, dy) = (i64::from(p.x - q.x), i64::from(p.y - q.y));
                                dx * dx + dy * dy
                            })
                            .map_or(0, |(_, w)| *w)
                    })
                    .collect();
                self.push_thick(tool, f, sp, &piece, &piece_widths);
            }
        }
        (self.width_mm, self.flow) = base;
    }

    /// A closed variable-width wall (`pts` ends where it starts) written with a scarf joint; false when
    /// the settings or the wall do not ask for one. Each point of the slope takes the width of the
    /// nearest junction, and each written point the Z and flow of the nearest point of the slope.
    #[allow(clippy::too_many_arguments, reason = "one wall and its context")]
    fn scarf_wide(
        &mut self,
        tool: u8,
        feature: Feature,
        speed: f32,
        pts: &[IntPoint<i32>],
        widths: &[i32],
        inner: bool,
        hole: bool,
    ) -> bool {
        let ring = pts.get(..pts.len().saturating_sub(1)).unwrap_or(&[]);
        let Some(sc) = self.scarf else { return false };
        if self.layer == 0
            || ring.len() < 3
            || !sc.applies(ring, hole, inner, self.unsupported.get(), self.width_mm)
        {
            return false;
        }
        let Some(plan) = sc.slope(ring, self.gap, f64::from(self.out.height), inner) else {
            return false;
        };
        let near = |q: &Point, from: &[Point]| -> usize {
            from.iter()
                .enumerate()
                .min_by_key(|(_, p)| {
                    let (dx, dy) = (i64::from(p.x - q.x), i64::from(p.y - q.y));
                    dx * dx + dy * dy
                })
                .map_or(0, |(i, _)| i)
        };
        let junctions: Vec<Point> = ring.iter().map(|p| Point::new(p.x, p.y)).collect();
        let (top, h) = (self.out.z, self.out.height);
        for (part, a, bnd) in &plan.parts {
            let seg = plan.points.get(*a..*bnd).unwrap_or(&[]);
            let sp = if *part == crate::scarf::Part::Flat {
                speed
            } else {
                sc.speed_for(speed)
            };
            // The width where each point sits along the ring, not the nearest junction's (a slope point halfway
            // along a tapering edge took the narrow end's width).
            let ws: Vec<i32> = seg
                .iter()
                .map(|q| {
                    width_on_ring(ring, widths, IntPoint::new(q.x, q.y))
                        .unwrap_or_else(|| widths.get(near(q, &junctions)).copied().unwrap_or(0))
                })
                .collect();
            let line: Vec<IntPoint<i32>> = seg.iter().map(|p| IntPoint::new(p.x, p.y)).collect();
            let at = self.out.points.len();
            self.push_thick(tool, feature, sp, &line, &ws);
            for idx in at..self.out.points.len() {
                let Some(q) = self.out.points.get(idx).copied() else {
                    continue;
                };
                let k = *a + near(&q, seg);
                let zr = plan.z_ratio.get(k).copied().unwrap_or(1.0);
                let fl = plan.flow.get(k).copied().unwrap_or(1.0);
                self.pz
                    .push((u32::try_from(idx).unwrap_or(u32::MAX), top - h * (1.0 - zr), fl));
            }
        }
        true
    }

    /// Gap beads of a surface (`gap_fill_target`), variable width, at the gap fill speed.
    fn push_gaps(&mut self, tool: u8, speed: f32, lines: &[crate::arachne::WallLine]) {
        let (width, flow) = (self.width_mm, self.flow);
        for l in lines {
            self.push_thick(tool, Feature::GapFill, speed, &l.points, &l.widths);
        }
        self.width_mm = width;
        self.flow = flow;
    }

    /// One polyline with a width per point: a segment whose width changes by more than 0.05 mm is cut into
    /// pieces that change by at most that, and consecutive pieces of the same width are one path.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss,
        reason = "piece counts and widths are small"
    )]
    fn push_thick(&mut self, tool: u8, feature: Feature, speed: f32, pts: &[IntPoint<i32>], widths: &[i32]) {
        if pts.len() < 2 {
            return;
        }
        let extra = f64::from(self.out.height) * (1.0 - std::f64::consts::FRAC_PI_4);
        let tol = 0.05 * SCALE;
        // (start, end, width of the piece) in order.
        let mut pieces: Vec<(Point, Point, f64)> = Vec::new();
        for i in 0..pts.len() - 1 {
            let (Some(a), Some(b)) = (pts.get(i), pts.get(i + 1)) else {
                continue;
            };
            let (wa, wb) = (
                f64::from(widths.get(i).copied().unwrap_or(0)),
                f64::from(widths.get(i + 1).copied().unwrap_or(0)),
            );
            let (pa, pb) = (Point::new(a.x, a.y), Point::new(b.x, b.y));
            if pa == pb {
                continue;
            }
            let delta = (wa - wb).abs();
            if delta > tol {
                let n = (delta / tol).ceil().max(1.0);
                let count = n as usize;
                let at = |k: usize| -> Point {
                    let t = k as f64 / n;
                    #[allow(clippy::cast_possible_truncation, reason = "a point between two i32 points")]
                    Point::new(
                        (f64::from(pa.x) + f64::from(pb.x - pa.x) * t).round() as i32,
                        (f64::from(pa.y) + f64::from(pb.y - pa.y) * t).round() as i32,
                    )
                };
                for k in 0..count {
                    let w0 = wa + (wb - wa) * k as f64 / n;
                    let w1 = wa + (wb - wa) * (k + 1) as f64 / n;
                    pieces.push((at(k), at(k + 1), w0.max(w1)));
                }
            } else {
                pieces.push((pa, pb, wa.max(wb)));
            }
        }
        let mut i = 0;
        while i < pieces.len() {
            let Some(&(start, _, w)) = pieces.get(i) else {
                break;
            };
            let mut path = vec![start];
            let mut j = i;
            while let Some(&(_, end, pw)) = pieces.get(j) {
                if (pw - w).abs() > 1.0 {
                    break;
                }
                path.push(end);
                j += 1;
            }
            #[allow(clippy::cast_possible_truncation, reason = "widths are small")]
            {
                self.width_mm = (w / SCALE + extra) as f32;
            }
            if w > 0.0 {
                self.push(tool, feature, speed, path.into_iter());
            }
            i = j.max(i + 1);
        }
    }

    fn push_lines(&mut self, tool: u8, feature: Feature, speed: f32, lines: &[[Point; 2]]) {
        for l in lines {
            self.push(tool, feature, speed, l.iter().copied());
        }
    }
}

/// The width at `p` on a closed ring of variable-width points: interpolated along the nearest edge.
fn width_on_ring(pts: &[IntPoint<i32>], widths: &[i32], p: IntPoint<i32>) -> Option<i32> {
    let n = pts.len();
    let (mut best, mut width) = (f64::INFINITY, None);
    for k in 0..n {
        let (Some(a), Some(b)) = (pts.get(k), pts.get((k + 1) % n)) else {
            continue;
        };
        let (ax, ay, bx, by) = (f64::from(a.x), f64::from(a.y), f64::from(b.x), f64::from(b.y));
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (((f64::from(p.x) - ax) * dx + (f64::from(p.y) - ay) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = (ax + t * dx - f64::from(p.x)).m_hypot(ay + t * dy - f64::from(p.y));
        if d < best {
            best = d;
            let (wa, wb) = (f64::from(*widths.get(k)?), f64::from(*widths.get((k + 1) % n)?));
            #[allow(clippy::cast_possible_truncation, reason = "a width in internal units")]
            {
                width = Some((wa + (wb - wa) * t).round() as i32);
            }
        }
    }
    width
}

/// Where the first skirt loop starts (Orca `Skirt::find_start_point`): from the center of the loop's box,
/// the distance to the box's lower left corner in the direction `angle` degrees (0 is straight right).
fn skirt_start_point(loop_: &[IntPoint<i32>], angle: f64) -> Option<[f64; 2]> {
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for p in loop_ {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    if loop_.is_empty() {
        return None;
    }
    let center = (
        f64::midpoint(f64::from(min_x), f64::from(max_x)),
        f64::midpoint(f64::from(min_y), f64::from(max_y)),
    );
    let r = (center.0 - f64::from(min_x)).m_hypot(center.1 - f64::from(min_y));
    let rad = angle.to_radians();
    Some([
        (center.0 + r * rad.m_cos()) / SCALE,
        (center.1 + r * rad.m_sin()) / SCALE,
    ])
}

/// A number that identifies a ring's first point and size, for seeding per-loop noise.
fn ring_hash(c: &[IntPoint<i32>]) -> u64 {
    let first = c.first().copied().unwrap_or(IntPoint::new(0, 0));
    (u64::from(first.x.unsigned_abs()) << 20) ^ u64::from(first.y.unsigned_abs()) ^ (c.len() as u64)
}

/// The rearmost point of a ring: the highest y, then the leftmost.
fn rear_index(c: &[IntPoint<i32>], ok: &dyn Fn(usize) -> bool) -> Option<usize> {
    if c.len() < 3 {
        return None;
    }
    c.iter()
        .enumerate()
        .filter(|(i, _)| ok(*i))
        .max_by(|(_, a), (_, b)| a.y.cmp(&b.y).then(b.x.cmp(&a.x)))
        .map(|(i, _)| i)
}

/// Corners are read between points at least this far along the ring, 0.3 mm,
/// so slicing noise on a smooth wall does not look like a corner.
const CORNER_ARM: i64 = 3_000;

/// The point `CORNER_ARM` along the ring from vertex `i`, going `step` (1 or -1) vertices at a time.
#[allow(clippy::cast_possible_wrap, reason = "ring lengths fit in isize")]
fn arm(c: &[IntPoint<i32>], i: usize, step: isize) -> Option<IntPoint<i32>> {
    let n = c.len();
    let p = c.get(i)?;
    let mut acc = 0i64;
    let mut at = i;
    for _ in 0..n {
        at = (at as isize + step).rem_euclid(n as isize) as usize;
        let q = c.get(at)?;
        acc += ((i64::from(q.x - p.x)).pow(2) + (i64::from(q.y - p.y)).pow(2)).isqrt();
        if acc >= CORNER_ARM {
            return Some(*q);
        }
    }
    None
}

/// The signed turn of the ring at vertex `i`, radians, read between the points 0.3 mm either way.
pub(crate) fn turn_at(c: &[IntPoint<i32>], i: usize) -> Option<f64> {
    let p = c.get(i)?;
    let (a, b) = (arm(c, i, -1)?, arm(c, i, 1)?);
    let (ux, uy) = (f64::from(p.x - a.x), f64::from(p.y - a.y));
    let (vx, vy) = (f64::from(b.x - p.x), f64::from(b.y - p.y));
    Some((ux * vy - uy * vx).m_atan2(ux * vx + uy * vy))
}

/// Orca's corner penalty for a turn of `ccw_angle` radians (positive when the ring bulges out, negative
/// into a concave corner): a bump around zero plus a sigmoid, so flat stretches score worst, sharp
/// convex corners better and concave ones best (`SeamPlacerImpl::compute_angle_penalty`).
fn angle_penalty(ccw_angle: f64) -> f64 {
    let gauss = (f64::m_exp(1.0 / (3.0 * ccw_angle * ccw_angle + 1.0)) - 1.0) / (std::f64::consts::E - 1.0);
    gauss + 1.0 / (2.0 + f64::m_exp(-ccw_angle))
}

/// The vertex with the lowest corner penalty among the vertices `keep` accepts; None when no corner
/// turns by at least 20 degrees. Equal scores go to the rearmost, then leftmost, so the choice does
/// not depend on where the ring happens to start.
fn corner_index(c: &[IntPoint<i32>], keep: impl Fn(usize, &IntPoint<i32>) -> bool) -> Option<usize> {
    let n = c.len();
    let area2: i128 = (0..n)
        .filter_map(|i| Some((c.get(i)?, c.get((i + 1) % n)?)))
        .map(|(a, b)| i128::from(a.x) * i128::from(b.y) - i128::from(b.x) * i128::from(a.y))
        .sum();
    let ccw = area2 >= 0;
    // (penalty in 1/20 steps, then rear, then left): the smallest wins. Corners within a step of each other
    // count as equal, so a seam does not hop between near-identical corners from layer to layer.
    let mut best: Option<((i64, i32, i32), usize)> = None;
    for (i, p) in c.iter().enumerate() {
        if !keep(i, p) {
            continue;
        }
        let Some(turn) = turn_at(c, i) else {
            continue;
        };
        if turn.abs() < 20f64.to_radians() {
            continue;
        }
        let concave = (turn > 0.0) != ccw;
        let angle = if concave { -turn.abs() } else { turn.abs() };
        #[allow(clippy::cast_possible_truncation, reason = "a penalty in twentieths")]
        let key = (
            (angle_penalty(angle) * 20.0).round() as i64,
            p.y.saturating_neg(),
            p.x,
        );
        if best.is_none_or(|(b, _)| key < b) {
            best = Some((key, i));
        }
    }
    best.map(|(_, i)| i)
}

/// Where a wall ring starts, by the seam setting. `cursor` is where the nozzle
/// is, `key` distinguishes loops of one layer for the random choice.
/// `allowed` limits the choice to some points of the ring (painted seams), by index.
pub(crate) fn seam_index(
    c: &[IntPoint<i32>],
    mode: SeamPosition,
    cursor: Point,
    key: u64,
    allowed: Option<&[bool]>,
) -> Option<usize> {
    if c.len() < 3 {
        return None;
    }
    let ok = |i: usize| allowed.is_none_or(|a| a.get(i).copied().unwrap_or(false));
    let rear = || rear_index(c, &ok);
    match mode {
        SeamPosition::Back => rear(),
        SeamPosition::Nearest => c
            .iter()
            .enumerate()
            .filter(|(i, _)| ok(*i))
            .min_by_key(|(_, p)| Point::new(p.x, p.y).dist2(cursor))
            .map(|(i, _)| i),
        SeamPosition::Aligned => corner_index(c, |i, _| ok(i)).or_else(rear),
        SeamPosition::AlignedBack => {
            let (lo, hi) = c
                .iter()
                .fold((i32::MAX, i32::MIN), |(l, h), p| (l.min(p.y), h.max(p.y)));
            let cut = hi - (hi - lo) / 4;
            corner_index(c, |i, p| ok(i) && p.y >= cut).or_else(rear)
        }
        SeamPosition::Random => {
            let first = c.first()?;
            let choices: Vec<usize> = (0..c.len()).filter(|i| ok(*i)).collect();
            // splitmix64 steps, so the layer number in the high half of `key` reaches the low bits too.
            let mix = |mut x: u64| {
                x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
                x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                x ^ (x >> 31)
            };
            let mut h = mix(key);
            for v in [
                i64::from(first.x),
                i64::from(first.y),
                i64::try_from(c.len()).ok()?,
            ] {
                h = mix(h ^ v.unsigned_abs());
            }
            choices
                .get(usize::try_from(h % choices.len().max(1) as u64).ok()?)
                .copied()
        }
    }
}

/// Orders one layer: tools in `order`, and for each tool the brim, then walls
/// island by island (nearest island next, inner walls before the outer wall),
/// then sparse infill, bottom and internal solid, and top surfaces.
/// Speed of the prime tower's wall and purge rows, mm/s.
const PRIME_TOWER_SPEED: f32 = 60.0;

/// The speed of gap beads in the fill: the gap infill speed, never above the inner wall's.
#[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
fn fill_gap_speed(cfg: &PrintConfig, inner: f32) -> f32 {
    cfg.gap_infill_speed.min(f64::from(inner)) as f32
}

/// The shape of `region` that holds `p` (the nearest one when none does).
fn surface_of(region: &Shapes, p: Point) -> usize {
    if region.len() < 2 {
        return 0;
    }
    let at = |ring: &[IntPoint<i32>]| -> Vec<Point> { ring.iter().map(|q| Point::new(q.x, q.y)).collect() };
    let mut best = (i64::MAX, 0usize);
    for (i, shape) in region.iter().enumerate() {
        let Some(outer) = shape.first() else { continue };
        let outer = at(outer);
        let holes: Vec<Vec<Point>> = shape.iter().skip(1).map(|r| at(r)).collect();
        if ring_contains(&outer, p) && !holes.iter().any(|h| ring_contains(h, p)) {
            return i;
        }
        let d = shape
            .iter()
            .flat_map(|r| r.iter())
            .map(|q| Point::new(q.x, q.y).dist2(p))
            .min()
            .unwrap_or(i64::MAX);
        if d < best.0 {
            best = (d, i);
        }
    }
    best.1
}

/// A run of paths that Orca prints as one thing: a fill's collection, or every path in the run as its own.
struct Group<'a> {
    start: usize,
    end: usize,
    /// The surfaces its paths fill, when they are several: each is a collection of its own.
    region: Option<&'a Shapes>,
    /// The pattern keeps its own order and direction (`Fill::no_sort`).
    no_sort: bool,
    /// Each path of the run is an entity of its own (the gap beads).
    each: bool,
}

/// A top-level thing of the infill phase: a path alone, or a whole collection.
struct Thing {
    paths: Vec<usize>,
    no_sort: bool,
    /// The paths are one line in pieces (a variable-width gap bead): printed in order, or all turned round.
    whole: bool,
}

fn path_ends(out: &LayerPaths, p: usize) -> Option<(Point, Point)> {
    let info = out.paths.get(p)?;
    let pts = out.points.get(info.start as usize..info.end as usize)?;
    Some((*pts.first()?, *pts.last()?))
}

/// The things of the infill phase in `groups`, and the range of paths they cover; None when a path of the
/// range belongs to none.
fn make_things(out: &LayerPaths, groups: &[Group<'_>]) -> Option<(Vec<Thing>, usize, usize)> {
    let first = groups.iter().filter(|g| g.end > g.start).map(|g| g.start).min()?;
    let last = groups.iter().map(|g| g.end).max().unwrap_or(first);
    let mut things: Vec<Thing> = Vec::new();
    for g in groups {
        if g.end <= g.start {
            continue;
        }
        // A collection whose pattern sorts is not kept whole: Orca hands each of its paths to the layer's chain
        // on its own (`ObjectByExtruder::Island::Region::append` takes `eec->entities` when `can_sort()`), so
        // only the collections that keep their order (`no_sort`) stay one thing.
        if g.each || !g.no_sort {
            // A bead cut where its width changes keeps its pieces together (Orca's `ExtrusionMultiPath`).
            for p in g.start..g.end {
                let joins = p > g.start
                    && things
                        .last()
                        .is_some_and(|t: &Thing| t.whole && t.paths.last() == Some(&(p - 1)))
                    && path_ends(out, p - 1)
                        .zip(path_ends(out, p))
                        .is_some_and(|(a, b)| a.1 == b.0);
                match things.last_mut() {
                    Some(t) if joins => t.paths.push(p),
                    _ => things.push(Thing {
                        paths: vec![p],
                        no_sort: false,
                        whole: true,
                    }),
                }
            }
        } else {
            let mut by_surface: std::collections::BTreeMap<usize, Vec<usize>> =
                std::collections::BTreeMap::new();
            for p in g.start..g.end {
                let at = path_ends(out, p).map_or(0, |(a, _)| g.region.map_or(0, |r| surface_of(r, a)));
                by_surface.entry(at).or_default().push(p);
            }
            for (_, paths) in by_surface {
                things.push(Thing {
                    paths,
                    no_sort: g.no_sort,
                    whole: false,
                });
            }
        }
    }
    let covered: usize = things.iter().map(|t| t.paths.len()).sum();
    (covered == last - first).then_some((things, first, last))
}

/// Chains `things` nearest first from `start`, appending their paths to `order` and the reversed ones to
/// `flips`. Returns where the nozzle ends, or None when a thing has no points.
fn chain_things(
    out: &LayerPaths,
    things: &[&Thing],
    start: Point,
    order: &mut Vec<usize>,
    flips: &mut Vec<usize>,
) -> Option<Point> {
    use crate::chain::{Ent, chain};
    let mut ents: Vec<Ent> = Vec::with_capacity(things.len());
    for t in things {
        let a = t.paths.first().and_then(|&p| path_ends(out, p))?;
        let z = t.paths.last().and_then(|&p| path_ends(out, p))?;
        ents.push(Ent {
            first: a.0,
            last: z.1,
            reversible: !t.no_sort,
        });
    }
    let mut cur = start;
    for (idx, reversed) in chain(&ents, start) {
        let Some(t) = things.get(idx) else { continue };
        if t.paths.len() == 1 || t.no_sort || t.whole {
            // Kept as it is, or a single path that may turn round.
            let mut ps = t.paths.clone();
            let flip = reversed && !t.no_sort;
            if flip {
                ps.reverse();
                flips.extend(ps.iter().copied());
            }
            if let Some(&p) = ps.last() {
                cur = path_ends(out, p).map_or(cur, |(a, z)| if flip { a } else { z });
            }
            order.extend(ps);
        } else {
            let inner: Vec<Ent> = t
                .paths
                .iter()
                .filter_map(|&p| {
                    path_ends(out, p).map(|(a, z)| Ent {
                        first: a,
                        last: z,
                        reversible: true,
                    })
                })
                .collect();
            if inner.len() != t.paths.len() {
                order.extend(t.paths.iter().copied());
                continue;
            }
            for (k, rev) in chain(&inner, cur) {
                let Some(&p) = t.paths.get(k) else { continue };
                if rev {
                    flips.push(p);
                }
                order.push(p);
                if let Some((a, z)) = path_ends(out, p) {
                    cur = if rev { a } else { z };
                }
            }
        }
    }
    Some(cur)
}

/// Writes the new order of the paths from `first`: `order` lists old path indices, `flips` the ones to turn.
fn apply_order(out: &mut LayerPaths, first: usize, order: &[usize], flips: &[usize]) {
    let old: Vec<crate::output::PathInfo> = out
        .paths
        .get(first..first + order.len())
        .map(<[_]>::to_vec)
        .unwrap_or_default();
    if old.len() != order.len() {
        return;
    }
    for &p in flips {
        let Some(info) = out.paths.get(p) else { continue };
        let (a, z) = (info.start as usize, info.end as usize);
        if let Some(pts) = out.points.get_mut(a..z) {
            pts.reverse();
        }
        if let Some(zs) = out.zs.get_mut(a..z) {
            zs.reverse();
        }
        if let Some(fs) = out.flows.get_mut(a..z) {
            fs.reverse();
        }
    }
    for (slot, &p) in order.iter().enumerate() {
        if let (Some(src), Some(dst)) = (old.get(p - first), out.paths.get_mut(first + slot)) {
            *dst = *src;
        }
    }
}

/// Puts the paths of `groups` in the order Orca's infill phase prints them (`GCode::extrude_infill`): the
/// collections that keep their own order and the single paths of every other collection, chained nearest
/// first from `start`. Reversed paths have their points turned in place.
fn reorder(out: &mut LayerPaths, groups: &[Group<'_>], start: Point) {
    let Some((things, first, last)) = make_things(out, groups) else {
        return;
    };
    let refs: Vec<&Thing> = things.iter().collect();
    let (mut order, mut flips) = (Vec::with_capacity(last - first), Vec::new());
    if chain_things(out, &refs, start, &mut order, &mut flips).is_none() || order.len() != last - first {
        return;
    }
    apply_order(out, first, &order, &flips);
}

/// The walls of one island: the paths `start..end` and the island's outline.
struct IslandRange {
    start: usize,
    end: usize,
    outline: Vec<IntPoint<i32>>,
}

/// Orca prints a layer island by island (`GCode::process_layer`, `ObjectByExtruder::Island`): the island's walls,
/// then its infill chained from where the walls end (with `is_infill_first`, the infill first), then the next
/// island. A fill path belongs to the smallest island whose outline holds its first point; the ones no island
/// holds print last. `pre` is the paths before the first island (extra perimeters of no island), kept first.
fn reorder_islands(
    out: &mut LayerPaths,
    pre: usize,
    islands: &[IslandRange],
    groups: &[Group<'_>],
    start: Point,
    infill_first: bool,
) -> bool {
    let Some((things, first, last)) = make_things(out, groups) else {
        return false;
    };
    let walls_end = islands.last().map_or(pre, |r| r.end);
    if walls_end != first || islands.first().map_or(pre, |r| r.start) < pre {
        return false;
    }
    let n = islands.len();
    let mut by_size: Vec<usize> = (0..n).collect();
    crate::sorting::sort_by_key(&mut by_size, |&i| {
        islands
            .get(i)
            .map_or(i64::MAX, |r| crate::geom::area2_int(&r.outline).abs())
    });
    let mut owned: Vec<Vec<&Thing>> = vec![Vec::new(); n + 1];
    for t in &things {
        let at = t.paths.first().and_then(|&p| path_ends(out, p)).map(|(a, _)| a);
        let k = at
            .and_then(|a| {
                by_size.iter().copied().find(|&i| {
                    islands
                        .get(i)
                        .is_some_and(|r| crate::perimeters::point_in(&r.outline, IntPoint::new(a.x, a.y)))
                })
            })
            .unwrap_or(n);
        if let Some(v) = owned.get_mut(k) {
            v.push(t);
        }
    }
    let (mut order, mut flips) = (Vec::with_capacity(last - pre), Vec::new());
    order.extend(pre..islands.first().map_or(pre, |r| r.start));
    let mut cur = order
        .last()
        .and_then(|&p| path_ends(out, p))
        .map_or(start, |(_, z)| z);
    for (i, r) in islands.iter().enumerate() {
        let mine = owned.get(i).map_or(&[][..], Vec::as_slice);
        if infill_first {
            let Some(c) = chain_things(out, mine, cur, &mut order, &mut flips) else {
                return false;
            };
            order.extend(r.start..r.end);
            cur = c;
        } else {
            order.extend(r.start..r.end);
        }
        if r.end > r.start {
            cur = path_ends(out, r.end - 1).map_or(cur, |(_, z)| z);
        }
        if !infill_first {
            let Some(c) = chain_things(out, mine, cur, &mut order, &mut flips) else {
                return false;
            };
            cur = c;
        }
    }
    let rest = owned.get(n).map_or(&[][..], Vec::as_slice);
    if chain_things(out, rest, cur, &mut order, &mut flips).is_none() || order.len() != last - pre {
        return false;
    }
    apply_order(out, pre, &order, &flips);
    true
}

// Siblings chain nearest first from the origin; a loop is as far as its first point.
fn chain_siblings(ids: &[usize], first: &dyn Fn(usize) -> Point) -> Vec<usize> {
    let mut left: Vec<usize> = ids.to_vec();
    let mut out = Vec::with_capacity(left.len());
    let mut at = Point::new(0, 0);
    while !left.is_empty() {
        let best = left
            .iter()
            .enumerate()
            .min_by_key(|(_, i)| first(**i).dist2(at))
            .map_or(0, |(k, _)| k);
        let id = left.remove(best);
        at = first(id);
        out.push(id);
    }
    out
}
fn traverse(
    ids: &[usize],
    children: &[Vec<usize>],
    contour: &[bool],
    first: &dyn Fn(usize) -> Point,
    out: &mut Vec<usize>,
) {
    for id in chain_siblings(ids, first) {
        let kids = children.get(id).map_or(&[][..], Vec::as_slice);
        let mut below = Vec::new();
        traverse(kids, children, contour, first, &mut below);
        if contour.get(id).copied().unwrap_or(true) {
            out.extend(below);
            out.push(id);
        } else {
            out.push(id);
            out.extend(below);
        }
    }
}

/// Whether `p` is inside `ring` (even-odd).
fn ring_contains(ring: &[Point], p: Point) -> bool {
    let (px, py) = (f64::from(p.x), f64::from(p.y));
    let mut odd = false;
    let n = ring.len();
    for i in 0..n {
        let (Some(a), Some(b)) = (ring.get(i), ring.get((i + 1) % n)) else {
            continue;
        };
        let (ay, by) = (f64::from(a.y), f64::from(b.y));
        if (ay > py) != (by > py) {
            let x = f64::from(a.x) + (py - ay) / (by - ay) * (f64::from(b.x) - f64::from(a.x));
            if px < x {
                odd = !odd;
            }
        }
    }
    odd
}

/// The order Orca's classic perimeter generator prints an island's loops in (`PerimeterGenerator::
/// process_classic`): the loops nest by containment (a hole goes under the hole around it, else under the
/// deepest contour around it; a contour under the nearest shallower contour around it), each level is chained
/// nearest first from the origin, and a contour prints its children before itself where a hole prints itself
/// before them, which puts the innermost wall of each tree first. `wall_sequence` then turns the whole list
/// round (outer wall first) or, for the sandwich, moves the walls from the third in to the front.
fn loop_order(loops: &[(u32, Vec<IntPoint<i32>>)], sequence: WallSequence, layer: u32) -> Vec<usize> {
    let n = loops.len();
    let pts: Vec<Vec<Point>> = loops
        .iter()
        .map(|(_, c)| c.iter().map(|p| Point::new(p.x, p.y)).collect())
        .collect();
    let contour: Vec<bool> = loops.iter().map(|(_, c)| crate::geom::area2_int(c) > 0).collect();
    #[allow(clippy::cast_possible_truncation, reason = "a wall index is small")]
    let depth = |i: usize| loops.get(i).map_or(0, |l| l.0 as usize);
    let loop_number = (0..n).map(depth).max().unwrap_or(0);
    let first = |i: usize| {
        pts.get(i)
            .and_then(|p| p.first().copied())
            .unwrap_or(Point::new(0, 0))
    };
    let contains =
        |parent: usize, child: usize| pts.get(parent).is_some_and(|r| ring_contains(r, first(child)));
    let mut holes: Vec<Vec<usize>> = vec![Vec::new(); loop_number + 1];
    let mut contours: Vec<Vec<usize>> = vec![Vec::new(); loop_number + 1];
    for i in 0..n {
        let list = if contour.get(i).copied().unwrap_or(true) {
            &mut contours
        } else {
            &mut holes
        };
        if let Some(l) = list.get_mut(depth(i)) {
            l.push(i);
        }
    }
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    // Holes nest first.
    for d in 0..=loop_number {
        let mut i = 0;
        while i < holes.get(d).map_or(0, Vec::len) {
            let Some(&hole) = holes.get(d).and_then(|h| h.get(i)) else {
                break;
            };
            let mut parent = None;
            'search: {
                for t in d + 1..=loop_number {
                    for &j in holes.get(t).map_or(&[][..], Vec::as_slice) {
                        if contains(j, hole) {
                            parent = Some(j);
                            break 'search;
                        }
                    }
                }
                for t in (0..=loop_number).rev() {
                    for &j in contours.get(t).map_or(&[][..], Vec::as_slice) {
                        if contains(j, hole) {
                            parent = Some(j);
                            break 'search;
                        }
                    }
                }
            }
            if let Some(p) = parent {
                if let Some(c) = children.get_mut(p) {
                    c.push(hole);
                }
                if let Some(h) = holes.get_mut(d) {
                    h.remove(i);
                }
            } else {
                i += 1;
            }
        }
    }
    // Then the contours, deepest first.
    for d in (1..=loop_number).rev() {
        let mut i = 0;
        while i < contours.get(d).map_or(0, Vec::len) {
            let Some(&c) = contours.get(d).and_then(|h| h.get(i)) else {
                break;
            };
            let mut parent = None;
            'search: for t in (0..d).rev() {
                for &j in contours.get(t).map_or(&[][..], Vec::as_slice) {
                    if contains(j, c) {
                        parent = Some(j);
                        break 'search;
                    }
                }
            }
            if let Some(p) = parent {
                if let Some(ch) = children.get_mut(p) {
                    ch.push(c);
                }
                if let Some(h) = contours.get_mut(d) {
                    h.remove(i);
                }
            } else {
                i += 1;
            }
        }
    }
    let mut base: Vec<usize> = Vec::with_capacity(n);
    let roots: Vec<usize> = contours.first().cloned().unwrap_or_default();
    traverse(&roots, &children, &contour, &first, &mut base);
    // Whatever did not nest (a hole outside every contour) still prints, after the rest.
    for i in 0..n {
        if !base.contains(&i) {
            base.push(i);
        }
    }
    match sequence {
        WallSequence::InnerOuter => base,
        WallSequence::InnerOuterInner if layer == 0 => base,
        WallSequence::OuterInner => {
            base.reverse();
            base
        }
        WallSequence::InnerOuterInner => {
            base.reverse();
            sandwich(base, &|i| depth(i))
        }
    }
}

/// Orca's sandwich reordering of a list of loops printed from the outside in: in each island the walls from the
/// third in go first (innermost first), then the outer wall and the first inner wall.
fn sandwich(list: Vec<usize>, depth: &dyn Fn(usize) -> usize) -> Vec<usize> {
    if list.len() <= 2 {
        return list;
    }
    // Bring first inner walls ahead of any second inner walls of the same island.
    let mut reordered: Vec<usize> = Vec::with_capacity(list.len());
    let mut skipped: Vec<usize> = Vec::new();
    let mut found_second = false;
    for &i in &list {
        match depth(i) {
            0 => {
                if found_second {
                    reordered.append(&mut skipped);
                }
                reordered.push(i);
            }
            1 => reordered.push(i),
            _ => {
                skipped.push(i);
                found_second = true;
            }
        }
    }
    reordered.append(&mut skipped);
    let mut position = 0;
    while position < reordered.len() {
        let (mut outer, mut first_in, mut second_in) = (None, None, None);
        let mut max_internal = reordered.len() - 1;
        let mut stop = position;
        for (at, &i) in reordered.iter().enumerate().skip(position) {
            stop = at;
            match depth(i) {
                0 => {
                    if outer.is_none() {
                        outer = Some(at);
                    }
                }
                1 if first_in.is_none() && outer.is_some_and(|o| at > o) => {
                    first_in = Some(at);
                }
                2 if second_in.is_none() && first_in.is_some_and(|f| at > f) && outer.is_some() => {
                    second_in = Some(at);
                }
                _ => {}
            }
            if outer.is_some() && first_in.is_some() && second_in.is_some() && depth(i) == 0 {
                stop = at - 1;
                max_internal = stop;
                break;
            }
        }
        let (Some(_), Some(_), Some(second)) = (outer, first_in, second_in) else {
            break;
        };
        let mut block: Vec<usize> = Vec::new();
        for j in (position..=max_internal).rev() {
            if j >= second
                && let Some(&id) = reordered.get(j)
            {
                block.push(id);
            }
        }
        block.extend(reordered.get(position..second).unwrap_or(&[]));
        for (k, id) in block.into_iter().enumerate() {
            if let Some(slot) = reordered.get_mut(position + k) {
                *slot = id;
            }
        }
        position = stop + 1;
    }
    reordered
}

/// The layer's paths in print order with their speeds ([`plan_layer_paths`]), then its time and the cooling
/// slowdown ([`cool`]).
pub(crate) fn plan_layer(
    out: &mut LayerPaths,
    works: &[ToolWork],
    cfg: &PrintConfig,
    layer: u32,
    seams: (&[crate::seam::SeamFace], f64, Option<&crate::seamplan::Plan>),
    vase: Option<&crate::spiral::VaseLayer>,
    object_hulls: &[Vec<IntPoint<i32>>],
) {
    plan_layer_paths(out, works, cfg, layer, seams, vase, object_hulls);
    cool(out, cfg);
}

/// [`plan_layer`] up to the layer's time.
pub(crate) fn plan_layer_paths(
    out: &mut LayerPaths,
    works: &[ToolWork],
    cfg: &PrintConfig,
    layer: u32,
    seams: (&[crate::seam::SeamFace], f64, Option<&crate::seamplan::Plan>),
    vase: Option<&crate::spiral::VaseLayer>,
    object_hulls: &[Vec<IntPoint<i32>>],
) {
    let speeds = Speeds::for_layer(cfg, layer);
    // `skirt_speed` replaces the skirt's own speed when it is set.
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    let skirt_speed = Some(cfg.raw_number("skirt_speed", 0.0))
        .filter(|v| *v > 0.0)
        .map(|v| v as f32);
    #[allow(clippy::cast_possible_truncation, reason = "line widths are small")]
    let width_mm = cfg.line_width as f32;
    // Widths by feature; a region with its own line width (a modifier) overrides all of them.
    #[allow(clippy::cast_possible_truncation, reason = "line widths are small")]
    let feature_w = [
        cfg.outer_wall_width() as f32,
        cfg.inner_wall_width() as f32,
        cfg.sparse_infill_width() as f32,
        cfg.solid_infill_width() as f32,
        cfg.top_surface_width() as f32,
        cfg.support_width() as f32,
    ];
    let mut b = Builder {
        out,
        cursor: Point::new(0, 0),
        width_mm,
        flow: 1.0,
        seam: cfg.seam_position,
        layer,
        faces: seams.0,
        z: seams.1,
        plan: seams.2,
        hang: None,
        clockwise: matches!(cfg.raw.get("wall_direction"), Some(serde_json::Value::String(s)) if s == "cw"),
        fuzzy: crate::fuzzy::Fuzzy::new(cfg),
        painted: crate::fuzzy::Fuzzy::painted(cfg),
        fuzzy_mask: None,
        scarf: crate::scarf::Scarf::of(cfg),
        gap: crate::scarf::seam_gap(cfg),
        start_point: None,
        unsupported: std::cell::Cell::new(f32::MIN),
        pz: Vec::new(),
        vol_caps: (1..=works.iter().map(|w| w.tool).max().unwrap_or(1))
            .map(|s| crate::tower::per_slot_raw(cfg, "filament_max_volumetric_speed", s, 0.0))
            .collect(),
    };
    // A spiral loop starts at the vertex nearest a fixed point and always turns the same way (clockwise,
    // unless `wall_direction` is `ccw`), so a layer does not depend on the one below.
    if let Some(v) = vase {
        b.seam = SeamPosition::Nearest;
        b.plan = None;
        b.scarf = None;
        b.gap = 0.0;
        b.cursor = v.anchor;
        b.faces = &[];
        b.fuzzy = None;
        b.painted = None;
        b.clockwise =
            !matches!(cfg.raw.get("wall_direction"), Some(serde_json::Value::String(s)) if s == "ccw");
    }
    // Per work: its paths and how they slow down over the layer below.
    let mut vary: Vec<(usize, usize, &crate::quality::Context)> = Vec::new();
    for w in works {
        b.fuzzy_mask.clone_from(&w.fuzzy_paint);
        b.hang = w.overhang.as_ref();
        let work_from = b.out.paths.len();
        let (line_width, line_flow) = (b.width_mm, b.flow);
        for t in &w.tower {
            b.width_mm = t.width_mm;
            b.flow = if t.flow > 0.0 { t.flow } else { 1.0 };
            b.push(
                w.tool,
                Feature::PrimeTower,
                if t.speed_mm_s > 0.0 {
                    t.speed_mm_s
                } else {
                    PRIME_TOWER_SPEED
                },
                t.points.iter().copied(),
            );
        }
        b.width_mm = line_width;
        b.flow = line_flow;
        let base_width = b.width_mm;
        let fw = |i: usize| {
            w.width
                .unwrap_or_else(|| feature_w.get(i).copied().unwrap_or(base_width))
        };
        if let Some(v) = w.width {
            b.width_mm = v;
        }
        if w.flush_first {
            b.width_mm = fw(2);
            b.push_lines(w.tool, Feature::SparseInfill, speeds.sparse, &w.sparse);
            for p in &w.sparse_paths {
                b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
            }
            for (width, set) in &w.sparse_alt {
                b.width_mm = *width;
                for p in set {
                    b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
                }
            }
            b.width_mm = fw(2);
            for (flow, set) in &w.sparse_thick {
                b.flow = line_flow * *flow;
                for p in set {
                    b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
                }
                b.flow = line_flow;
            }
            b.width_mm = base_width;
        }
        for (i, c) in w.skirt.iter().enumerate() {
            if i == 0 && layer == 0 {
                b.start_point = skirt_start_point(c, cfg.raw_number("skirt_start_angle", -135.0));
            }
            b.push_loop(w.tool, Feature::Skirt, skirt_speed.unwrap_or(speeds.brim), c);
        }
        for c in &w.brim {
            b.push_loop(w.tool, Feature::Brim, speeds.brim, c);
        }
        let support_speed = |speed: f64| {
            #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
            let v = if layer == 0 && crate::raft::layers_asked(cfg) == 0 {
                speed.min(cfg.initial_layer_infill_speed)
            } else {
                speed
            } as f32;
            v
        };
        b.width_mm = fw(5);
        if w.support_flow > 0.0 {
            b.flow = w.support_flow;
        }
        // Orca (`GCode::extrude_support`): a support path no longer than `small_support_perimeter_threshold`
        // times 2 pi mm prints at `small_support_perimeter_speed` (a speed, or a percent of the support or
        // interface speed; 0 means half of it).
        let small_threshold =
            cfg.raw_number("small_support_perimeter_threshold", 0.0) * 2.0 * std::f64::consts::PI;
        let small_speed = |base: f64| -> f64 {
            match cfg.raw.get("small_support_perimeter_speed") {
                Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => {
                    base * cfg.raw_number("small_support_perimeter_speed", 50.0) / 100.0
                }
                Some(_) => match cfg.raw_number("small_support_perimeter_speed", 0.0) {
                    v if v > 0.0 => v,
                    _ => base * 0.5,
                },
                None => base * 0.5,
            }
        };
        let path_speed = |p: &[Point], base: f64| -> f32 {
            let len: f64 = p
                .windows(2)
                .map(|s| match s {
                    [a, c] => f64::from(c.x - a.x).m_hypot(f64::from(c.y - a.y)) / crate::geom::SCALE,
                    _ => 0.0,
                })
                .sum();
            support_speed(if len <= small_threshold {
                small_speed(base)
            } else {
                base
            })
        };
        let support_from = b.out.paths.len();
        let here = b.cursor;
        for p in &w.support {
            b.push(
                w.tool,
                Feature::Support,
                path_speed(p, cfg.support.speed),
                p.iter().copied(),
            );
        }
        let interface_from = b.out.paths.len();
        for p in &w.support_interface {
            b.push(
                w.tool,
                Feature::SupportInterface,
                path_speed(p, cfg.support.interface_speed),
                p.iter().copied(),
            );
        }
        // Orca (`generate_support_toolpaths`, `GCode::extrude_support`): the support paths and the interface paths
        // are chained nearest first from where the nozzle is; a tree island keeps its own order (the sheath
        // before the fill).
        if let Some(areas) = b.out.support_areas.take() {
            let end = b.out.paths.len();
            let groups = [
                Group {
                    start: support_from,
                    end: interface_from,
                    region: Some(&areas.islands),
                    no_sort: areas.keep_order,
                    each: false,
                },
                Group {
                    start: interface_from,
                    end,
                    region: None,
                    no_sort: false,
                    each: false,
                },
            ];
            reorder(b.out, &groups, here);
            b.out.support_areas = Some(areas);
            if let Some(last) = b
                .out
                .paths
                .last()
                .and_then(|p| b.out.points.get(p.end as usize - 1))
            {
                b.cursor = *last;
            }
        }
        if !w.support_ironing.is_empty() {
            // The interface flow at `support_ironing_flow` percent of its height (Orca's `ironing_flow`).
            let width = f64::from(b.width_mm);
            let h = f64::from(b.out.height).max(0.01);
            let area = |hh: f64| hh * (width - hh * (1.0 - std::f64::consts::FRAC_PI_4)).max(width * 0.5);
            let ratio = area(h * cfg.support.ironing_flow.max(0.0) / 100.0) / area(h);
            #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
            {
                b.flow = (f64::from(if w.support_flow > 0.0 { w.support_flow } else { 1.0 }) * ratio) as f32;
            }
            let speed = crate::motion::raw_f(cfg, "ironing_speed")
                .filter(|v| *v > 0.0)
                .unwrap_or(20.0);
            for p in &w.support_ironing {
                #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
                b.push(w.tool, Feature::Ironing, speed as f32, p.iter().copied());
            }
        }
        b.flow = line_flow;
        b.width_mm = base_width;
        let walls_from = b.out.paths.len();
        let mut island_ranges: Vec<IslandRange> = Vec::new();
        // Where each island's first loop starts; the nearest setting depends on the
        // nozzle, so it is read per step, the others once.
        let mut remaining: Vec<(&IslandWalls, Option<Point>)> = w
            .islands
            .iter()
            .filter(|i| !i.loops.is_empty() || !i.wide.is_empty())
            .map(|i| {
                let start = i
                    .loops
                    .first()
                    .and_then(|(k, c)| b.seam_ring(c, Some(*k != 0)))
                    .and_then(|r| r.first().copied())
                    .or_else(|| i.wide.first().and_then(|l| l.points.first().copied()))
                    .map(|p| Point::new(p.x, p.y));
                (i, start)
            })
            .collect();
        let mut thin_plain: Vec<(&Vec<IntPoint<i32>>, i32)> = Vec::new();
        let mut thin_lines: Vec<&crate::arachne::WallLine> = Vec::new();
        // Extra perimeters go with the island around them (the smallest outer wall ring holding their start).
        let extra_owner: Vec<Option<usize>> = w
            .extra_perimeters
            .iter()
            .map(|e| {
                let p = Point::new(e.first()?.x, e.first()?.y);
                let mut best: Option<(i64, usize)> = None;
                for (k, isl) in w.islands.iter().enumerate() {
                    let rings = isl.loops.iter().filter(|(i, _)| *i == 0).map(|(_, c)| c).chain(
                        isl.wide
                            .iter()
                            .filter(|l| l.inset == 0 && l.closed)
                            .map(|l| &l.points),
                    );
                    for c in rings {
                        let ring: Vec<Point> = c.iter().map(|q| Point::new(q.x, q.y)).collect();
                        let a = crate::geom::area2_int(c).abs();
                        if ring_contains(&ring, p) && best.is_none_or(|(ba, _)| a < ba) {
                            best = Some((a, k));
                        }
                    }
                }
                best.map(|(_, k)| k)
            })
            .collect();
        #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
        let extra_speed = cfg.bridge_speed as f32;
        let push_extra = |b: &mut Builder<'_>, owner: Option<usize>| {
            let (line_width, line_flow) = (b.width_mm, b.flow);
            b.width_mm = w.extra_width;
            b.flow = w.extra_flow;
            for (e, o) in w.extra_perimeters.iter().zip(&extra_owner) {
                if *o == owner {
                    b.push(
                        w.tool,
                        Feature::OverhangWall,
                        extra_speed,
                        e.iter().map(|q| Point::new(q.x, q.y)),
                    );
                }
            }
            (b.width_mm, b.flow) = (line_width, line_flow);
        };
        if extra_owner.iter().any(Option::is_none) {
            push_extra(&mut b, None);
        }
        while !remaining.is_empty() {
            let cursor = b.cursor;
            let best = remaining
                .iter()
                .enumerate()
                .min_by_key(|(_, (isl, start))| {
                    // `print_order` as object list: the islands of the first object, then the next.
                    let object = if object_hulls.is_empty() {
                        0
                    } else {
                        isl.loops
                            .first()
                            .map(|(_, c)| c.first().copied())
                            .or_else(|| isl.wide.first().map(|l| l.points.first().copied()))
                            .flatten()
                            .map_or(0, |p| {
                                let p = crate::session::as_f(p);
                                object_hulls
                                    .iter()
                                    .enumerate()
                                    .min_by(|a, c| {
                                        crate::session::point_to_hull(p, a.1)
                                            .total_cmp(&crate::session::point_to_hull(p, c.1))
                                    })
                                    .map_or(0, |(i, _)| i)
                            })
                    };
                    let dist = if b.seam == SeamPosition::Nearest {
                        isl.loops
                            .first()
                            .map(|(_, c)| c.as_slice())
                            .or_else(|| isl.wide.first().map(|l| l.points.as_slice()))
                            .map_or(i64::MAX, |c| {
                                c.iter()
                                    .map(|p| Point::new(p.x, p.y).dist2(cursor))
                                    .min()
                                    .unwrap_or(i64::MAX)
                            })
                    } else {
                        start.map_or(i64::MAX, |p| p.dist2(cursor))
                    };
                    (object, dist)
                })
                .map_or(0, |(i, _)| i);
            let (isl, _) = remaining.swap_remove(best);
            let island_from = b.out.paths.len();
            if let Some(k) = w.islands.iter().position(|i| std::ptr::eq(i, isl))
                && extra_owner.contains(&Some(k))
            {
                push_extra(&mut b, Some(k));
            }
            // Loops are stored innermost first (wall index k counts from the outer wall,
            // which is 0); the sequence setting reorders them, keeping loops of one wall together.
            let order = loop_order(&isl.loops, cfg.wall_sequence, layer);
            // `overhang_reverse`: on odd layers, when a wall hangs far enough past the layer below, the
            // walls of that kind (outlines or holes) all print the other way round.
            let (mut turn_contours, mut turn_holes) = (false, false);
            if layer % 2 == 1
                && let Some(o) = w.overhang.as_ref().filter(|o| o.reverses())
            {
                for (_, c) in &isl.loops {
                    if o.steep(c) {
                        if crate::geom::area2_int(c) > 0 {
                            turn_contours = true;
                        } else {
                            turn_holes = true;
                        }
                    }
                }
            }
            let keep_outer = w
                .overhang
                .as_ref()
                .is_some_and(crate::overhang::Overhang::keeps_outer);
            for &i in &order {
                let Some((k, c)) = isl.loops.get(i) else { continue };
                let reversed: Vec<IntPoint<i32>>;
                let c = if (if crate::geom::area2_int(c) > 0 {
                    turn_contours
                } else {
                    turn_holes
                }) && !(keep_outer && *k == 0)
                {
                    reversed = c.iter().rev().copied().collect();
                    &reversed
                } else {
                    c
                };
                let (feature, speed) = if *k == 0 {
                    (Feature::OuterWall, speeds.outer)
                } else {
                    (Feature::InnerWall, speeds.inner)
                };
                let speed = speeds.loop_speed(speed, ring_len_mm(c));
                b.width_mm = fw(usize::from(*k != 0));
                let contour = crate::geom::area2_int(c) > 0;
                let seed = (u64::from(layer) << 40) ^ (u64::from(*k) << 32) ^ ring_hash(c);
                let painted = b
                    .painted
                    .filter(|f| f.applies(layer, *k, contour))
                    .zip(b.fuzzy_mask.as_ref());
                match b.fuzzy.filter(|f| f.applies(layer, *k, contour)) {
                    Some(f) => {
                        let ring: Vec<IntPoint<i32>> = f
                            .ring(c, seed, b.slice_z(), layer)
                            .into_iter()
                            .map(|(p, _)| p)
                            .collect();
                        b.push_wall(w.tool, feature, speed, &ring, w.overhang.as_ref());
                    }
                    // Fuzzy skin only where the wall runs through a painted area.
                    None => match painted {
                        Some((f, mask)) => {
                            let ring: Vec<IntPoint<i32>> = f
                                .ring_in(c, mask, seed, b.slice_z(), layer)
                                .into_iter()
                                .map(|(p, _)| p)
                                .collect();
                            b.push_wall(w.tool, feature, speed, &ring, w.overhang.as_ref());
                        }
                        None => b.push_wall(w.tool, feature, speed, c, w.overhang.as_ref()),
                    },
                }
            }
            b.width_mm = base_width;
            b.push_wide(w.tool, &isl.wide, cfg, &speeds, w.overhang.as_ref());
            // The island's outline: its largest outer ring.
            let outline = isl
                .loops
                .iter()
                .filter(|(k, c)| *k == 0 && crate::geom::area2_int(c) > 0)
                .map(|(_, c)| c)
                .chain(
                    isl.wide
                        .iter()
                        .filter(|l| l.inset == 0 && l.closed)
                        .map(|l| &l.points),
                )
                .max_by_key(|c| crate::geom::area2_int(c).abs())
                .cloned()
                .unwrap_or_default();
            island_ranges.push(IslandRange {
                start: island_from,
                end: b.out.paths.len(),
                outline,
            });
            // The gap beads go with the infill, where Orca prints them (`thin_fills`), after the walls.
            thin_plain.extend(isl.gaps.iter().map(|(p, w)| (p, *w)));
            thin_lines.extend(isl.gap_lines.iter());
        }
        let walls_to = b.out.paths.len();
        // The infill phase. Orca chains the fill collections and the gap beads nearest first from where the walls
        // left off, and the paths inside a collection too unless its pattern keeps its own order (`no_sort`).
        let fill_from = b.cursor;
        let mut groups: Vec<Group<'_>> = Vec::new();
        let solid_pattern = |key: &str, default: &'static str| -> bool {
            let name = match cfg.raw.get(key) {
                Some(serde_json::Value::String(t)) => t.as_str(),
                _ => default,
            };
            matches!(name, "monotonic" | "monotonicline" | "concentric")
        };
        {
            let g = b.out.paths.len();
            let (line_width, line_flow) = (b.width_mm, b.flow);
            for (path, width) in &thin_plain {
                #[allow(clippy::cast_possible_truncation, reason = "widths are small")]
                {
                    b.width_mm = (f64::from(*width) / crate::geom::SCALE) as f32;
                }
                b.push(
                    w.tool,
                    Feature::GapFill,
                    fill_gap_speed(cfg, speeds.inner),
                    path.iter().map(|p| Point::new(p.x, p.y)),
                );
            }
            // Orca's gap fill: variable-width lines down the strips the walls leave.
            for l in &thin_lines {
                b.push_thick(
                    w.tool,
                    Feature::GapFill,
                    fill_gap_speed(cfg, speeds.inner),
                    &l.points,
                    &l.widths,
                );
            }
            b.width_mm = line_width;
            b.flow = line_flow;
            groups.push(Group {
                start: g,
                end: b.out.paths.len(),
                region: None,
                no_sort: false,
                each: true,
            });
        }
        if !w.flush_first {
            let g = b.out.paths.len();
            b.width_mm = fw(2);
            b.push_lines(w.tool, Feature::SparseInfill, speeds.sparse, &w.sparse);
            for p in &w.sparse_paths {
                b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
            }
            for (width, set) in &w.sparse_alt {
                b.width_mm = *width;
                for p in set {
                    b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
                }
            }
            b.width_mm = fw(2);
            for (flow, set) in &w.sparse_thick {
                b.flow = line_flow * *flow;
                for p in set {
                    b.push(w.tool, Feature::SparseInfill, speeds.sparse, p.iter().copied());
                }
                b.flow = line_flow;
            }
            b.width_mm = base_width;
            groups.push(Group {
                start: g,
                end: b.out.paths.len(),
                region: Some(&w.region_sparse),
                no_sort: cfg.sparse_infill_pattern == crate::config::InfillPattern::Concentric,
                each: false,
            });
        }
        let bottom_feature = if layer == 0 {
            Feature::BottomSurface
        } else {
            Feature::InternalSolid
        };
        let g = b.out.paths.len();
        b.width_mm = fw(3);
        b.push_lines(w.tool, bottom_feature, speeds.solid, &w.bottom);
        b.push_gaps(w.tool, fill_gap_speed(cfg, speeds.inner), &w.gap_bottom);
        b.width_mm = base_width;
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: Some(if layer == 0 {
                &w.region_bottom
            } else {
                &w.region_shell
            }),
            no_sort: if layer == 0 {
                solid_pattern("bottom_surface_pattern", "monotonic")
            } else {
                solid_pattern("internal_solid_infill_pattern", "monotonic")
            },
            each: false,
        });
        let g = b.out.paths.len();
        #[allow(clippy::cast_possible_truncation, reason = "speeds and flow ratios are small")]
        if !w.bridge.is_empty() || !w.bridge_paths.is_empty() {
            // A round strand of the bridge width: its cross-section against the layer's bead.
            let d = f64::from(w.bridge_width);
            let h = f64::from(b.out.height);
            let (line_width, line_flow) = (b.width_mm, b.flow);
            b.width_mm = w.bridge_width;
            b.flow = if w.bridge_flat_flow > 0.0 {
                w.bridge_flat_flow
            } else {
                (std::f64::consts::PI * d * d / 4.0 / crate::gcode::bead_area(d, h)) as f32
            };
            #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
            let speed = cfg.bridge_speed as f32;
            for p in &w.bridge_paths {
                b.push(w.tool, Feature::Bridge, speed, p.iter().copied());
            }
            b.push_lines(w.tool, Feature::Bridge, speed, &w.bridge);
            b.width_mm = line_width;
            b.flow = line_flow;
        }
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: None,
            no_sort: false,
            each: false,
        });
        let g = b.out.paths.len();
        if !w.wave_paths.is_empty() {
            let (line_width, line_flow) = (b.width_mm, b.flow);
            // A round bead of the nozzle's width at the wave flow: its cross-section against the layer's bead.
            #[allow(clippy::cast_possible_truncation, reason = "a width and a flow ratio")]
            {
                let nozzle = cfg.nozzle_diameter;
                b.width_mm = nozzle as f32;
                let h = f64::from(b.out.height);
                b.flow = (f64::from(w.wave_flow) / crate::gcode::bead_area(nozzle, h)) as f32;
            }
            for ring in &w.wave_paths {
                b.push(w.tool, Feature::Bridge, w.wave_speed, ring.iter().copied());
            }
            b.width_mm = line_width;
            b.flow = line_flow;
        }
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: None,
            no_sort: false,
            each: false,
        });
        let g = b.out.paths.len();
        if !w.internal_bridge.is_empty() || !w.internal_bridge_paths.is_empty() {
            let (line_width, line_flow) = (b.width_mm, b.flow);
            // A round strand of the bridge width (thick internal bridges), else a normal bead at the bridge
            // flow ratio.
            if w.internal_bridge_width > 0.0 {
                let d = f64::from(w.internal_bridge_width);
                let h = f64::from(b.out.height);
                b.width_mm = w.internal_bridge_width;
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
                {
                    b.flow = (std::f64::consts::PI * d * d / 4.0 / crate::gcode::bead_area(d, h)) as f32;
                }
            } else if w.internal_bridge_ratio > 0.0 {
                b.flow = w.internal_bridge_ratio;
            }
            // `internal_bridge_flow` multiplies the flow of internal bridge strands, on top of the bridge flow.
            #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
            {
                b.flow *= cfg.raw_number("internal_bridge_flow", 1.0).max(0.0) as f32;
            }
            #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
            let speed = cfg.internal_bridge_speed as f32;
            for p in &w.internal_bridge_paths {
                b.push(w.tool, Feature::InternalBridge, speed, p.iter().copied());
            }
            b.push_lines(w.tool, Feature::InternalBridge, speed, &w.internal_bridge);
            b.width_mm = line_width;
            b.flow = line_flow;
        }
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: None,
            no_sort: false,
            each: false,
        });
        let g = b.out.paths.len();
        b.width_mm = fw(3);
        // The narrow bands (`FillConcentricInternal`): one collection per band, kept in its own order, chained
        // with the other collections of the layer instead of inside the surface's lines.
        for l in &w.shell_thick {
            b.push_thick(w.tool, Feature::InternalSolid, speeds.solid, &l.points, &l.widths);
        }
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: Some(&w.region_narrow),
            no_sort: true,
            each: false,
        });
        let g = b.out.paths.len();
        b.width_mm = fw(3);
        b.push_lines(w.tool, Feature::InternalSolid, speeds.solid, &w.shell);
        b.push_gaps(w.tool, fill_gap_speed(cfg, speeds.inner), &w.gap_shell);
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: Some(&w.region_shell),
            no_sort: solid_pattern("internal_solid_infill_pattern", "monotonic"),
            each: false,
        });
        let g = b.out.paths.len();
        b.width_mm = fw(4);
        b.push_lines(w.tool, Feature::TopSurface, speeds.top, &w.top);
        b.push_gaps(w.tool, fill_gap_speed(cfg, speeds.inner), &w.gap_top);
        b.width_mm = base_width;
        groups.push(Group {
            start: g,
            end: b.out.paths.len(),
            region: Some(&w.region_top),
            no_sort: solid_pattern("top_surface_pattern", "monotonicline"),
            each: false,
        });
        // `is_infill_first`: above the first layer the walls print after the infill (Orca's
        // `extrude_perimeters` for the regions that ask for it); the first layer keeps walls first.
        let infill_first = layer > 0 && vase.is_none() && crate::tower::flag(cfg, "is_infill_first");
        let by_island = vase.is_none()
            && island_ranges.len() > 1
            && reorder_islands(
                b.out,
                walls_from,
                &island_ranges,
                &groups,
                fill_from,
                infill_first,
            );
        if !by_island {
            if vase.is_none() {
                reorder(b.out, &groups, fill_from);
            }
            if infill_first
                && walls_to > walls_from
                && let Some(tail) = b.out.paths.get_mut(walls_from..)
            {
                tail.rotate_left(walls_to - walls_from);
            }
        }
        if let Some(q) = w.quality.as_deref() {
            vary.push((work_from, b.out.paths.len(), q));
        }
        if !w.tower_after.is_empty() {
            let (line_width, line_flow) = (b.width_mm, b.flow);
            // Ramming runs at its own flow, past the filament's volumetric limit (`WipeTowerWriter::ram`).
            let caps = std::mem::take(&mut b.vol_caps);
            for t in &w.tower_after {
                b.width_mm = t.width_mm;
                b.flow = if t.flow > 0.0 { t.flow } else { 1.0 };
                b.push(
                    w.tool,
                    Feature::PrimeTower,
                    if t.speed_mm_s > 0.0 {
                        t.speed_mm_s
                    } else {
                        PRIME_TOWER_SPEED
                    },
                    t.points.iter().copied(),
                );
            }
            b.vol_caps = caps;
            b.width_mm = line_width;
            b.flow = line_flow;
        }
    }
    let mut scarf_points = std::mem::take(&mut b.pz);
    if !vary.is_empty() {
        vary_speeds(out, &vary, &mut scarf_points);
    }
    if !scarf_points.is_empty() {
        out.zs = vec![out.z; out.points.len()];
        out.flows = vec![1.0; out.points.len()];
        for (i, z, f) in scarf_points {
            if let (Some(zs), Some(fs)) = (out.zs.get_mut(i as usize), out.flows.get_mut(i as usize)) {
                *zs = z;
                *fs = f;
            }
        }
    }
    if let Some(v) = vase {
        crate::spiral::apply(out, cfg, v, !crate::gcode::absolute_e_mode(cfg));
    }
    crate::tall::apply(out, cfg);
    crate::preflight::cap_speeds(out, cfg);
}

/// Orca's point by point overhang speed (`quality.rs`) over the walls and bridges of each work, in their
/// printed order and direction: a path whose speed changes along it is cut into pieces of one speed and one
/// overhang fan state each, with the points the estimator adds. Scarf heights and flows follow the points they
/// belong to.
/// A piece: the speed, whether the overhang fan runs, its points and where each sits between the path's own
/// points.
type Piece = (f32, bool, Vec<Point>, Vec<(usize, usize, f64)>);

#[allow(clippy::cast_possible_truncation, reason = "point counts and coordinates")]
fn vary_speeds(
    out: &mut LayerPaths,
    vary: &[(usize, usize, &crate::quality::Context)],
    pz: &mut Vec<(u32, f32, f32)>,
) {
    let mut pieces: Vec<Option<Vec<Piece>>> = vec![None; out.paths.len()];
    let mut any = false;
    for &(from, to, q) in vary {
        for (i, p) in out.paths.iter().enumerate().take(to).skip(from) {
            let outer = match p.feature {
                Feature::OuterWall => true,
                Feature::InnerWall | Feature::OverhangWall | Feature::Bridge | Feature::InternalBridge => {
                    false
                }
                _ => continue,
            };
            let pts = out.path_points(p);
            if pts.len() < 2 {
                continue;
            }
            let mm: Vec<(f64, f64)> = pts.iter().map(|q| (q.x_mm(), q.y_mm())).collect();
            let mm3 =
                crate::gcode::bead_area(f64::from(p.width_mm), f64::from(out.height)) * f64::from(p.flow);
            let Some((first, stretches)) = q.speeds(&mm, p.width_mm, mm3, p.speed_mm_s, outer, p.tool) else {
                continue;
            };
            // Each new point: its position and where it sits between the path's own points (a, b, t).
            let at = |e: &crate::quality::ExtPoint, last_src: usize| -> (Point, (usize, usize, f64)) {
                let pt = Point::new((e.x * SCALE).round() as i32, (e.y * SCALE).round() as i32);
                if let Some(k) = e.src {
                    return (pt, (k, k, 0.0));
                }
                let (a, b) = (last_src, (last_src + 1).min(pts.len() - 1));
                let (Some(&pa), Some(&pb)) = (pts.get(a), pts.get(b)) else {
                    return (pt, (a, a, 0.0));
                };
                let whole = pa.dist_mm(pb);
                let t = if whole > 0.0 { pa.dist_mm(pt) / whole } else { 0.0 };
                (pt, (a, b, t))
            };
            let mut list: Vec<Piece> = Vec::new();
            let mut last_src = first.src.unwrap_or(0);
            let (mut cur_pt, mut cur_src) = at(&first, last_src);
            for st in stretches {
                let (pt, src) = at(&st.to, last_src);
                if let Some(k) = st.to.src {
                    last_src = k;
                }
                if let Some((speed, fan, ps, ss)) = list.last_mut()
                    && (*speed - st.speed).abs() < f32::EPSILON
                    && *fan == st.fan
                {
                    ps.push(pt);
                    ss.push(src);
                } else {
                    list.push((st.speed, st.fan, vec![cur_pt, pt], vec![cur_src, src]));
                }
                (cur_pt, cur_src) = (pt, src);
            }
            if !list.is_empty()
                && let Some(slot) = pieces.get_mut(i)
            {
                *slot = Some(list);
                any = true;
            }
        }
    }
    if !any {
        return;
    }
    let old_z: std::collections::HashMap<u32, (f32, f32)> = pz.iter().map(|&(i, z, f)| (i, (z, f))).collect();
    let mut points: Vec<Point> = Vec::with_capacity(out.points.len() + out.points.len() / 4);
    let mut paths: Vec<PathInfo> = Vec::with_capacity(out.paths.len() + 16);
    let mut new_pz: Vec<(u32, f32, f32)> = Vec::with_capacity(pz.len());
    let z0 = out.z;
    for (p, piece) in out.paths.iter().zip(pieces) {
        let base = p.start as usize;
        match piece {
            None => {
                let start = points.len() as u32;
                for k in p.start..p.end {
                    if let Some((z, f)) = old_z.get(&k) {
                        new_pz.push((points.len() as u32, *z, *f));
                    }
                    if let Some(q) = out.points.get(k as usize) {
                        points.push(*q);
                    }
                }
                paths.push(PathInfo {
                    start,
                    end: points.len() as u32,
                    ..*p
                });
            }
            Some(list) => {
                for (speed, fan, ps, ss) in list {
                    let start = points.len() as u32;
                    for (q, (a, b, t)) in ps.into_iter().zip(ss) {
                        let (ga, gb) = ((base + a) as u32, (base + b) as u32);
                        if old_z.contains_key(&ga) || old_z.contains_key(&gb) {
                            let (za, _) = old_z.get(&ga).copied().unwrap_or((z0, 1.0));
                            let (zb, fb) = old_z.get(&gb).copied().unwrap_or((z0, 1.0));
                            new_pz.push((points.len() as u32, za + (zb - za) * t as f32, fb));
                        }
                        points.push(q);
                    }
                    paths.push(PathInfo {
                        start,
                        end: points.len() as u32,
                        speed_mm_s: speed,
                        overhang_fan: fan,
                        ..*p
                    });
                }
            }
        }
    }
    out.points = points;
    out.paths = paths;
    *pz = new_pz;
}

/// The layer time Orca's cooling buffer works with (`CoolingBuffer::parse_layer_gcode`): every move at its
/// own feed rate with no acceleration, counted from the layer's first extrusion (the travel to it and the
/// layer change are left out). Returns the fixed time (travels and retractions) and per path its length
/// (mm) and time (s).
///
/// `cfg` is the layer's filament config ([`layer_filament`]).
fn cooling_parts(l: &LayerPaths, cfg: &PrintConfig) -> (f64, Vec<(f64, f64)>) {
    let retract = if cfg.retraction_length > 0.0 && cfg.retraction_speed > 0.0 {
        2.0 * cfg.retraction_length / cfg.retraction_speed
    } else {
        0.0
    };
    let mut fixed = 0.0;
    let mut cursor: Option<Point> = None;
    let mut parts = Vec::with_capacity(l.paths.len());
    for p in &l.paths {
        let pts = l.path_points(p);
        let len: f64 = pts
            .windows(2)
            .map(|w| match w {
                [a, b] => a.dist_mm(*b),
                _ => 0.0,
            })
            .sum();
        if let (Some(c), Some(first)) = (cursor, pts.first()) {
            let d = c.dist_mm(*first);
            fixed += d / cfg.travel_speed.max(1.0);
            if d > cfg.retraction_minimum_travel {
                fixed += retract;
            }
        }
        parts.push((len, len / f64::from(p.speed_mm_s.max(1.0))));
        if let Some(last) = pts.last() {
            cursor = Some(*last);
        }
    }
    (fixed, parts)
}

/// The layer time after the cooling slowdown in the cooling buffer's model, seconds (what the part fan
/// reads, as Orca's `CoolingBuffer::apply_layer_cooldown` gets it). `fc` is the layer's filament config: the
/// layer's settings `for_filament` its [`first_slot`].
pub(crate) fn cooling_time(l: &LayerPaths, fc: &PrintConfig) -> f64 {
    let (fixed, parts) = cooling_parts(l, fc);
    fixed + parts.iter().map(|p| p.1).sum::<f64>()
}

/// A layer's time, then the cooling slowdown when the settings ask for it: the last step of a layer's paths, for
/// a layer put together from copies of objects sliced without it.
pub(crate) fn cool(l: &mut LayerPaths, cfg: &PrintConfig) {
    cool_with(l, cfg, &layer_filament(l, cfg));
}

/// [`cool`] with the layer's filament config `fc` (`cfg.for_filament` of the layer's [`first_slot`]) given.
pub(crate) fn cool_with(l: &mut LayerPaths, cfg: &PrintConfig, fc: &PrintConfig) {
    l.unslowed = None;
    l.cooling_extra_s = 0.0;
    l.written = None;
    // A slowdown that runs to the end works the time out itself, for the new speeds.
    if !(cfg.slow_down_for_layer_cooling && slow_down(l, cfg, fc, 0.0)) {
        l.time_s = estimate_time_with(l, cfg, fc);
    }
}

/// The cooling slowdown worked out again from the layer's speeds before it, now that the written layer is
/// known to take `extra` seconds more than this module's model of it (custom G-code inside the layer,
/// retractions the writer leaves out, wipes; negative when it takes less). None when that changes nothing:
/// the slowdown is off, or the layer was not slowed and still needs no slowdown.
pub(crate) fn recool(l: &LayerPaths, cfg: &PrintConfig, fc: &PrintConfig, extra: f64) -> Option<LayerPaths> {
    if !cfg.slow_down_for_layer_cooling {
        return None;
    }
    let speeds = l.unslowed.as_ref().filter(|s| s.len() == l.paths.len());
    if speeds.is_none() && cooling_time(l, fc) + extra > cfg.slow_down_layer_time * 1.001 {
        return None;
    }
    let mut m = l.clone();
    m.written = None;
    if let Some(speeds) = speeds {
        for (p, &s) in m.paths.iter_mut().zip(speeds.iter()) {
            p.speed_mm_s = s;
        }
    }
    if !slow_down(&mut m, cfg, fc, extra) {
        // An unslowed layer that still needs no slowdown is unchanged.
        speeds?;
        m.time_s = estimate_time_with(&m, cfg, fc);
    }
    Some(m)
}

/// Slows a layer that prints faster than `slow_down_layer_time` as Orca's cooling buffer does
/// (`CoolingBuffer::calculate_layer_slowdown`, `extruder_range_slow_down_non_proportional`): the fastest
/// paths are capped first, at one common feed rate chosen so that the layer takes the minimum time, never
/// below `slow_down_min_speed`; when even that is not enough every path goes down to the minimum speed. A
/// path already at or under the minimum keeps its speed; with `dont_slow_down_outer_wall` the outer wall
/// keeps its own. Times are the cooling buffer's (no acceleration); `extra` is time the layer's G-code
/// spends outside its paths (custom G-code inside the layer).
///
/// `fc` is the layer's filament config ([`layer_filament`]); the slowdown changes speeds only, so it holds
/// throughout. True when it went through to the end and set the layer's time for the new speeds; false when
/// the layer needs no slowdown or nothing can slow, with the time left as it was.
#[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
fn slow_down(l: &mut LayerPaths, cfg: &PrintConfig, fc: &PrintConfig, extra: f64) -> bool {
    if l.paths.is_empty() {
        return false;
    }
    let target = cfg.slow_down_layer_time * 1.001;
    let (fixed, parts) = cooling_parts(l, fc);
    let total = fixed + extra + parts.iter().map(|p| p.1).sum::<f64>();
    if total > target {
        return false;
    }
    let min_speed = cfg.slow_down_min_speed.max(0.0);
    let keep_outer = crate::firmware::truthy(cfg, "dont_slow_down_outer_wall");
    // (index, speed, time) of the paths that can slow down.
    let adjustable: Vec<(usize, f64, f64)> = l
        .paths
        .iter()
        .zip(&parts)
        .enumerate()
        .filter(|(_, (p, (len, _)))| {
            *len > 0.0
                && f64::from(p.speed_mm_s) > min_speed
                && !(keep_outer && matches!(p.feature, Feature::OuterWall | Feature::OverhangWall))
        })
        .map(|(i, (p, (_, t)))| (i, f64::from(p.speed_mm_s), *t))
        .collect();
    if adjustable.is_empty() {
        return false;
    }
    let stretch = target - total;
    let cap = if min_speed <= 0.0 {
        None
    } else {
        // Time when every adjustable path runs at the minimum speed.
        let at_min: f64 = adjustable
            .iter()
            .map(|&(_, f, t)| t * (f / min_speed - 1.0))
            .sum();
        if at_min <= stretch {
            Some(min_speed)
        } else {
            // The common cap F with sum over paths faster than F of t (f / F - 1) = stretch.
            let mut by_speed = adjustable.clone();
            crate::sorting::sort_by(&mut by_speed, |a, b| b.1.total_cmp(&a.1));
            let (mut tf, mut tt) = (0.0, 0.0);
            let mut cap = min_speed;
            for (k, &(_, f, t)) in by_speed.iter().enumerate() {
                tf += t * f;
                tt += t;
                let next = by_speed.get(k + 1).map_or(min_speed, |n| n.1.max(min_speed));
                let c = tf / (stretch + tt);
                if c >= next - 1e-9 {
                    cap = c.max(min_speed);
                    break;
                }
            }
            Some(cap)
        }
    };
    if l.unslowed.is_none() {
        l.unslowed = Some(l.paths.iter().map(|p| p.speed_mm_s).collect());
    }
    if let Some(c) = cap {
        for &(i, f, _) in &adjustable {
            if f > c
                && let Some(p) = l.paths.get_mut(i)
            {
                p.speed_mm_s = c as f32;
            }
        }
    } else {
        // No minimum speed: every adjustable path slows in proportion.
        let adj_time: f64 = adjustable.iter().map(|a| a.2).sum();
        if adj_time > 0.0 {
            let rate = (adj_time + stretch) / adj_time;
            for &(i, f, _) in &adjustable {
                if let Some(p) = l.paths.get_mut(i) {
                    p.speed_mm_s = (f / rate) as f32;
                }
            }
        }
    }
    l.time_s = estimate_time_with(l, cfg, fc);
    true
}

/// Seconds to print a layer: extrusion length over speed, travels at travel
/// speed, and a retract plus unretract for every travel longer than
/// `retraction_minimum_travel` and at the layer change. Acceleration is not
/// modeled yet, so this reads low on short moves.
#[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
pub(crate) fn estimate_time(l: &LayerPaths, cfg: &PrintConfig) -> f32 {
    estimate_time_with(l, cfg, &layer_filament(l, cfg))
}

/// [`estimate_time`] with the layer's filament config already worked out.
fn estimate_time_with(l: &LayerPaths, cfg: &PrintConfig, fc: &PrintConfig) -> f32 {
    if let Some(lim) = crate::motion::Limits::from_config(cfg) {
        return motion_time(l, fc, &lim);
    }
    plain_time(l, fc)
}

/// The config the layer's first filament prints with: the retraction settings with that filament's own
/// overrides. Worked out once per layer step, since a filament with overrides takes a copy of the config.
fn layer_filament<'c>(l: &LayerPaths, cfg: &'c PrintConfig) -> std::borrow::Cow<'c, PrintConfig> {
    cfg.for_filament(first_slot(l))
}

/// The filament slot the layer's first path prints with (1 for an empty layer).
pub(crate) fn first_slot(l: &LayerPaths) -> u8 {
    l.paths.first().map_or(1, |p| p.tool.max(1))
}

/// The layer's time from the planner model: accelerations per feature, jerk, axis
/// limits, retracts and the lift at the layer change. Each layer starts and ends at rest.
#[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
/// `cfg` is the layer's filament config ([`layer_filament`]).
fn motion_time(l: &LayerPaths, cfg: &PrintConfig, lim: &crate::motion::Limits) -> f32 {
    use crate::motion::{Move, feature_accel, feature_jerk, retract_accel, travel_accel};
    if l.paths.is_empty() {
        return 0.0;
    }
    let retract = cfg.retraction_length;
    let r_acc = retract_accel(cfg);
    let t_acc = travel_accel(cfg);
    let fil_area = std::f64::consts::PI * (cfg.filament_diameter / 2.0).m_powi(2);
    let first_layer = l.index == 0;
    let h = f64::from(l.height);
    let e_move = |de: f64| Move {
        d: [0.0, 0.0, 0.0, de],
        feed: cfg.retraction_speed,
        accel: r_acc,
        jerk_xy: 0.0,
    };
    let mut moves: Vec<Move> = Vec::with_capacity(l.points.len() + 16);
    if retract > 0.0 {
        moves.push(e_move(-retract));
    }
    moves.push(Move {
        d: [0.0, 0.0, h, 0.0],
        feed: 20.0,
        accel: t_acc,
        jerk_xy: 0.0,
    });
    let mut cursor: Option<Point> = None;
    let mut retracted = retract > 0.0;
    let default_jerk = crate::motion::raw_f(cfg, "default_jerk").unwrap_or(0.0);
    for p in &l.paths {
        let pts = l.path_points(p);
        let (Some(first), Some(last)) = (pts.first(), pts.last()) else {
            continue;
        };
        if let Some(c) = cursor {
            let d = c.dist_mm(*first);
            if d > cfg.retraction_minimum_travel && retract > 0.0 && !retracted {
                moves.push(e_move(-retract));
                retracted = true;
            }
        }
        if let Some(c) = cursor.filter(|c| c != first) {
            moves.push(Move {
                d: [first.x_mm() - c.x_mm(), first.y_mm() - c.y_mm(), 0.0, 0.0],
                feed: cfg.travel_speed,
                accel: t_acc,
                jerk_xy: default_jerk,
            });
        }
        if retracted {
            moves.push(e_move(retract));
            retracted = false;
        }
        let accel = feature_accel(cfg, p.feature, first_layer);
        let jerk = feature_jerk(cfg, p.feature, first_layer).unwrap_or(0.0);
        let e_per_mm = crate::gcode::bead_area(f64::from(p.width_mm), h) / fil_area
            * cfg.flow_ratio(p.tool)
            * f64::from(p.flow);
        for w in pts.windows(2) {
            if let [a, b] = w {
                let (dx, dy) = (b.x_mm() - a.x_mm(), b.y_mm() - a.y_mm());
                moves.push(Move {
                    d: [dx, dy, 0.0, (dx * dx + dy * dy).sqrt() * e_per_mm],
                    feed: f64::from(p.speed_mm_s),
                    accel,
                    jerk_xy: jerk,
                });
            }
        }
        cursor = Some(*last);
    }
    crate::motion::time(&moves, lim) as f32
}

#[allow(clippy::cast_possible_truncation, reason = "layer times are small")]
/// `cfg` is the layer's filament config ([`layer_filament`]).
fn plain_time(l: &LayerPaths, cfg: &PrintConfig) -> f32 {
    let retract = if cfg.retraction_length > 0.0 {
        2.0 * cfg.retraction_length / cfg.retraction_speed
    } else {
        0.0
    };
    let min_travel = cfg.retraction_minimum_travel;
    let mut t = if l.paths.is_empty() { 0.0 } else { retract };
    let mut cursor: Option<Point> = None;
    for p in &l.paths {
        let pts = l.path_points(p);
        let (Some(first), Some(last)) = (pts.first(), pts.last()) else {
            continue;
        };
        if let Some(c) = cursor {
            let d = c.dist_mm(*first);
            t += d / cfg.travel_speed;
            if d > min_travel {
                t += retract;
            }
        }
        let len: f64 = pts
            .windows(2)
            .map(|w| match w {
                [a, b] => a.dist_mm(*b),
                _ => 0.0,
            })
            .sum();
        t += len / f64::from(p.speed_mm_s.max(1.0));
        cursor = Some(*last);
    }
    t as f32
}

/// `mm` along a scanline, in `t` units.
#[allow(clippy::cast_possible_truncation, reason = "distances on a bed fit in i64")]
pub(crate) fn t_units(mm: f64) -> i64 {
    (mm * std::f64::consts::SQRT_2 * SCALE).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(cx: i32, cy: i32, r: i32, ccw: bool) -> Vec<IntPoint<i32>> {
        let mut pts = vec![
            IntPoint::new(cx - r, cy - r),
            IntPoint::new(cx + r, cy - r),
            IntPoint::new(cx + r, cy + r),
            IntPoint::new(cx - r, cy + r),
        ];
        if !ccw {
            pts.reverse();
        }
        pts
    }

    /// A rim with a hole, two walls each: Orca prints the hole's walls, then the rim's, each inner first.
    fn ring() -> Vec<(u32, Vec<IntPoint<i32>>)> {
        vec![
            (0, square(0, 0, 1000, true)), // 0: outer wall of the rim
            (1, square(0, 0, 900, true)),  // 1: inner wall of the rim
            (0, square(0, 0, 200, false)), // 2: outer wall of the hole (its boundary)
            (1, square(0, 0, 300, false)), // 3: inner wall of the hole (grown)
        ]
    }

    #[test]
    fn a_ring_prints_the_hole_walls_before_the_rim_walls() {
        let order = loop_order(&ring(), WallSequence::InnerOuter, 3);
        assert_eq!(
            order,
            [3, 2, 1, 0],
            "hole inner, hole outer, rim inner, rim outer"
        );
    }

    #[test]
    fn outer_inner_turns_the_whole_order_round() {
        let order = loop_order(&ring(), WallSequence::OuterInner, 3);
        assert_eq!(order, [0, 1, 2, 3]);
    }

    #[test]
    fn the_sandwich_puts_the_third_wall_in_first_and_starts_above_the_first_layer() {
        let loops: Vec<(u32, Vec<IntPoint<i32>>)> = (0..4u32)
            .map(|k| (k, square(0, 0, 1000 - 100 * k.cast_signed(), true)))
            .collect();
        // Outside in is 0 1 2 3; the walls from the second inner one go first, innermost first.
        assert_eq!(loop_order(&loops, WallSequence::InnerOuterInner, 2), [3, 2, 0, 1]);
        // Three walls: the innermost, the outer, then the first inner.
        assert_eq!(
            loop_order(&loops[..3], WallSequence::InnerOuterInner, 2),
            [2, 0, 1]
        );
        // The first layer prints plainly inside out.
        assert_eq!(
            loop_order(&loops[..3], WallSequence::InnerOuterInner, 0),
            [2, 1, 0]
        );
    }
}
