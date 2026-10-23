// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 1: the layer plan.

use crate::error::{Error, Result};

/// How far below the model top the last layer top may end and still count as reaching it, mm.
///
/// Tops are planned on the plate mesh rounded to f32 (sx-geom, in the app and in [`crate::sleipnir`]), while the
/// model top here is the f64 transform of the f32 mesh. At printable heights (under 1 m) the two differ by at most
/// half an f32 step, about 3e-5 mm, so a tolerance of 1e-6 mm refused plates whose tops reached the top exactly
/// (39.350002288818 against 39.350003600121 on a real project). One micron is 30 times that rounding and 40 times
/// under the thinnest layer a plan may have (0.04 mm), so it passes float noise and still refuses tops that stop a
/// layer short.
const TOP_TOLERANCE_MM: f64 = 1e-3;

/// Layer heights for the whole plate. Uniform tops are computed by
/// multiplication, not accumulation, so every shard sees the same values.
#[derive(Debug, Clone, Default)]
pub(crate) struct LayerPlan {
    pub(crate) first_height: f64,
    pub(crate) height: f64,
    /// True when the tops came from the caller (sleipnir) instead of the two heights.
    pub(crate) custom: bool,
    /// Top of each layer, mm, ascending.
    tops: Vec<f64>,
    /// Thickness of each layer, mm.
    thick: Vec<f64>,
    /// Plane each layer is cut at (the middle of the layer), ascending.
    pub(crate) slice_z: Vec<f64>,
}

impl LayerPlan {
    /// Layers are added while their cutting plane is below the top of the model.
    pub(crate) fn new(max_z: f64, first_height: f64, height: f64) -> Self {
        let mut plan = Self {
            first_height,
            height,
            ..Self::default()
        };
        let mut i = 0u32;
        loop {
            let (bottom, top) = Self::bounds_of(first_height, height, i);
            let mid = f64::midpoint(bottom, top);
            if mid >= max_z || i > 200_000 {
                break;
            }
            plan.slice_z.push(mid);
            plan.tops.push(top);
            plan.thick.push(if i == 0 { first_height } else { height });
            i += 1;
        }
        plan
    }

    /// A plan from explicit layer tops (first entry is the first layer's top).
    /// Layers are kept while their cutting plane is below the top of the model;
    /// the tops must reach that far. Each thickness is checked against
    /// `min_h..=max_h`.
    pub(crate) fn from_tops(max_z: f64, tops: &[f64], min_h: f64, max_h: f64) -> Result<Self> {
        let bad = |reason: String| Error::Config {
            key: "options.layerTopsMm",
            reason,
        };
        let mut plan = Self {
            custom: true,
            ..Self::default()
        };
        let mut bottom = 0.0_f64;
        for (i, &top) in tops.iter().enumerate() {
            if !top.is_finite() {
                return Err(bad(format!("entry {i} is not a number")));
            }
            let t = top - bottom;
            if t < min_h - 1e-9 || t > max_h + 1e-9 {
                return Err(bad(format!(
                    "layer {i} is {t:.4} mm thick, outside {min_h} to {max_h} mm"
                )));
            }
            let mid = f64::midpoint(bottom, top);
            if mid >= max_z {
                break;
            }
            if plan.slice_z.len() >= 200_000 {
                return Err(bad("more than 200,000 layers".to_owned()));
            }
            plan.slice_z.push(mid);
            plan.tops.push(top);
            plan.thick.push(t);
            bottom = top;
        }
        let covered = plan.tops.last().copied().unwrap_or(0.0);
        if covered < max_z - TOP_TOLERANCE_MM && plan.slice_z.len() == tops.len() {
            return Err(bad(format!(
                "tops end at {covered:.4} mm, below the model top at {max_z:.4} mm"
            )));
        }
        plan.first_height = plan.thick.first().copied().unwrap_or(0.0);
        plan.height = plan.thick.get(1).copied().unwrap_or(plan.first_height);
        Ok(plan)
    }

    /// `precise_z_height` (Orca `adjust_layer_series_to_align_object_height`): the last five layers are
    /// stretched, or squeezed, evenly within `min_h..=max_h` so the top of the print lands on `height`. A
    /// plan under six layers, or one that cannot reach it, is left as it is.
    pub(crate) fn align_height(&mut self, height: f64, min_h: f64, max_h: f64) {
        const EPS: f64 = 1e-4;
        let approx = |a: f64, b: f64| (a - b).abs() < EPS;
        let n = self.tops.len();
        let Some(&back) = self.tops.last() else { return };
        if approx(back, height) || n < 6 {
            return;
        }
        let mut last: Vec<f64> = (n - 5..n)
            .map(|i| self.thick.get(i).copied().unwrap_or(0.0))
            .collect();
        let mut gap = (back - height).abs();
        let mut can = [true; 5];
        let grow = back < height;
        loop {
            let valid = can.iter().filter(|c| **c).count();
            if valid == 0 {
                return;
            }
            let delta = gap / f64::from(u32::try_from(valid).unwrap_or(5));
            let mut remain = 0.0;
            for (h, ok) in last.iter_mut().zip(can.iter_mut()) {
                let (limit, near) = if grow {
                    (max_h, approx(*h, max_h))
                } else {
                    (min_h, approx(*h, min_h))
                };
                if *ok && near {
                    remain += delta;
                    *ok = false;
                    continue;
                }
                let moved = if grow { *h + delta } else { *h - delta };
                let over = if grow { moved > limit } else { moved < limit };
                if *ok && over {
                    remain += if grow { moved - limit } else { limit - moved };
                    *h = limit;
                    *ok = false;
                } else {
                    *h = moved;
                }
            }
            gap = remain;
            if approx(gap, 0.0) {
                break;
            }
        }
        let mut bottom = self.tops.get(n - 6).copied().unwrap_or(0.0);
        for (k, h) in last.iter().enumerate() {
            let i = n - 5 + k;
            let top = bottom + h;
            if let (Some(t), Some(th), Some(s)) = (
                self.tops.get_mut(i),
                self.thick.get_mut(i),
                self.slice_z.get_mut(i),
            ) {
                *t = top;
                *th = *h;
                *s = f64::midpoint(bottom, top);
            }
            bottom = top;
        }
    }

    fn bounds_of(first: f64, h: f64, i: u32) -> (f64, f64) {
        if i == 0 {
            (0.0, first)
        } else {
            (first + f64::from(i - 1) * h, first + f64::from(i) * h)
        }
    }

    #[allow(clippy::cast_possible_truncation, reason = "layer count is capped at 200,000")]
    pub(crate) fn count(&self) -> u32 {
        self.slice_z.len() as u32
    }

    /// Top of layer `i`, mm.
    pub(crate) fn top(&self, i: u32) -> f64 {
        self.tops.get(i as usize).copied().unwrap_or(0.0)
    }

    /// Thickness of layer `i`, mm.
    pub(crate) fn thickness(&self, i: u32) -> f64 {
        self.thick.get(i as usize).copied().unwrap_or(self.height)
    }

    /// First layer whose cutting plane is at or above `z`.
    pub(crate) fn first_at_or_above(&self, z: f64) -> usize {
        self.slice_z.partition_point(|&s| s < z)
    }

    /// The layers whose cutting plane cuts a span of the mesh from `lo` to `hi`, with points sorted to either
    /// side as [`on_or_above`] does: a part whose top lies on a plane is cut there, one whose bottom does is not.
    pub(crate) fn cutting(&self, lo: f64, hi: f64) -> std::ops::Range<usize> {
        let a = self.slice_z.partition_point(|&s| on_or_above(lo, s));
        let b = self.slice_z.partition_point(|&s| on_or_above(hi, s));
        a..b.max(a)
    }
}

/// How close to a cutting plane a mesh point counts as lying on it, mm: the rounding of a part's placement
/// and of the layer heights (Orca slices in single precision, where such points land on the plane).
const ON_PLANE: f64 = 1e-6;

/// Whether a mesh point at height `z` lies on the upper side of the cutting plane at `plane`. A point on the
/// plane counts as above it, as in Orca's `slice_facet`: a triangle owns its top edge and vertex, not its
/// bottom ones, so a face lying on the plane is cut as the top of the part below it. Where two parts meet on
/// a plane, that layer gets the lower part's outline.
pub(crate) fn on_or_above(z: f64, plane: f64) -> bool {
    z >= plane - ON_PLANE
}

/// One layer of the print where support has layers of its own: its top and thickness (mm), the
/// object layer printed on it and the support stack layer printed on it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PrintLayer {
    pub(crate) top: f64,
    pub(crate) height: f64,
    pub(crate) object: Option<u32>,
    pub(crate) support: Option<u32>,
    /// The raft layer (an index into the raft's layers) that this print layer is, when it is one.
    pub(crate) raft: Option<u32>,
}

/// Object and support layers (top, thickness) merged into print layers by height, as Orca pairs
/// them for G-code: layers whose tops are within 0.1 micron print together, at the object's
/// thickness.
pub(crate) fn merge_layers(object: &[(f64, f64)], support: &[(f64, f64)]) -> Vec<PrintLayer> {
    const EPS: f64 = 1e-4;
    let mut out = Vec::with_capacity(object.len() + support.len());
    let (mut i, mut j) = (0usize, 0usize);
    loop {
        let (o, s) = (object.get(i), support.get(j));
        let low = match (o, s) {
            (None, None) => break,
            (Some(a), None) => a.0,
            (None, Some(b)) => b.0,
            (Some(a), Some(b)) => a.0.min(b.0),
        };
        let take_o = o.filter(|a| a.0 <= low + EPS);
        let take_s = s.filter(|b| b.0 <= low + EPS);
        #[allow(
            clippy::cast_possible_truncation,
            reason = "layer counts are capped at 200,000"
        )]
        out.push(PrintLayer {
            top: take_o.or(take_s).map_or(low, |l| l.0),
            height: take_o.or(take_s).map_or(0.0, |l| l.1),
            object: take_o.map(|_| i as u32),
            support: take_s.map(|_| j as u32),
            raft: None,
        });
        i += usize::from(take_o.is_some());
        j += usize::from(take_s.is_some());
    }
    out
}

/// A height range's own layer height (`layer_height` in a project's `Metadata/layer_config_ranges.xml`): the layers
/// whose bottom lies in `z_from_mm..z_to_mm` above the bed are `height_mm` thick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeLayerHeight {
    pub z_from_mm: f64,
    pub z_to_mm: f64,
    pub height_mm: f64,
}

/// The note for a plate whose printed objects change layer height at different heights.
pub(crate) const LAYER_HEIGHTS_DIFFER: &str = "objects on this plate change layer height at different heights (height ranges); layers are plate-wide, so the plate keeps one layer height";

/// The note for a request whose height ranges set a layer height while its layer tops come from elsewhere.
pub(crate) const RANGE_LAYER_HEIGHT_UNUSED: &str =
    "layer_height in a height range is not applied: the request's layer tops or sleipnir set the layers";

/// Layers thinner than this at the top of a range plan join the layer below them, mm.
const RANGE_SLIVER_MM: f64 = 0.04;

/// The layer tops of a plate whose objects share the layer heights `ranges`, up to the plate's top `top`, mm. The
/// first layer keeps its own height `first_layer`. Above it each layer takes the height of the first range its bottom
/// lies in, else `layer_height`, and ends at the top at most. A layer that would leave less than
/// [`RANGE_SLIVER_MM`] under the top reaches the top instead, and a last layer thinner than that joins the one below
/// it. Tops are rounded to a micron. `None` without ranges, or when the plate is no taller than its first layer.
///
/// The app sends a project's layer height ranges in its request's height ranges and leaves the plan to this, so a
/// project slices with the same layers in the app and with `sx slice`.
#[must_use]
pub fn range_layer_tops(
    ranges: &[RangeLayerHeight],
    top: f64,
    first_layer: f64,
    layer_height: f64,
) -> Option<Vec<f64>> {
    let usable = |h: f64| h.is_finite() && h > 0.0;
    if ranges.is_empty()
        || !top.is_finite()
        || top <= first_layer
        || !usable(first_layer)
        || !usable(layer_height)
        || ranges.iter().any(|r| !usable(r.height_mm))
    {
        return None;
    }
    let mut tops = vec![first_layer];
    let mut z = first_layer;
    while top - z > 1e-6 {
        let h = ranges
            .iter()
            .find(|r| z + 1e-6 >= r.z_from_mm && z + 1e-6 < r.z_to_mm)
            .map_or(layer_height, |r| r.height_mm);
        let mut next = top.min(z + h);
        if top - next < RANGE_SLIVER_MM && next < top {
            next = top;
        }
        z = next;
        tops.push((z * 1e6).round() / 1e6);
    }
    let n = tops.len();
    if n > 2
        && let [.., below, last] = tops.as_slice()
        && last - below < RANGE_SLIVER_MM
    {
        tops.remove(n - 2);
    }
    Some(tops)
}

/// What a plate's layer height ranges ([`crate::Mesh::layer_heights`]) give its layer plan.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RangeTops {
    /// No printed object has a layer height range.
    None,
    /// The plate's layer tops ([`range_layer_tops`]).
    Tops(Vec<f64>),
    /// The printed objects change layer height at different heights, which plate-wide layers cannot follow.
    Differ,
}

/// A height range's own layer height (`layer_height` in its settings), mm, when it sets one.
fn layer_height_of(r: &crate::HeightRange) -> Option<&serde_json::Value> {
    r.settings.get("layer_height")
}

/// The ranges `ranges` without their `layer_height`, which plans the plate's layers ([`plate_range_tops`]) rather than
/// changing a setting by height; a range left with no settings is dropped. The second value is true when a range sets
/// a layer height. A range's layer height must be a number above 0, its heights must ascend, and the objects it names
/// must be on `plate`.
pub(crate) fn without_layer_heights<'a>(
    plate: &crate::Plate,
    ranges: &'a [crate::HeightRange],
) -> crate::Result<(std::borrow::Cow<'a, [crate::HeightRange]>, bool)> {
    if !ranges.iter().any(|r| layer_height_of(r).is_some()) {
        return Ok((std::borrow::Cow::Borrowed(ranges), false));
    }
    let bad = |reason: String| crate::Error::Config {
        key: "options.heightRanges",
        reason,
    };
    let mut out = Vec::with_capacity(ranges.len());
    for (i, r) in ranges.iter().enumerate() {
        let Some(h) = layer_height_of(r) else {
            out.push(r.clone());
            continue;
        };
        if !h.as_f64().is_some_and(|h| h.is_finite() && h > 0.0) {
            return Err(bad(format!(
                "range {i}: layer_height must be a number above 0 mm"
            )));
        }
        if !(r.z_from_mm.is_finite() && r.z_to_mm.is_finite() && r.z_from_mm < r.z_to_mm) {
            return Err(bad(format!("range {i} needs zFromMm below zToMm")));
        }
        if let Some(id) = r
            .objects
            .iter()
            .find(|id| !plate.objects.iter().any(|o| o.id == **id))
        {
            return Err(bad(format!(
                "range {i} names object {id}, which is not on the plate"
            )));
        }
        let mut settings = r.settings.clone();
        if let Some(m) = settings.as_object_mut() {
            m.remove("layer_height");
            if m.is_empty() {
                continue;
            }
        }
        out.push(crate::HeightRange {
            settings,
            ..r.clone()
        });
    }
    Ok((std::borrow::Cow::Owned(out), true))
}

/// The layer heights by height of plate object `o`: its project file's ([`crate::Mesh::layer_heights`]), then those of
/// the ranges `ranges` that apply to it (every object's, or its own by id), in order.
fn object_layer_heights(
    o: &crate::plate::PlateObject,
    ranges: &[crate::HeightRange],
) -> Vec<RangeLayerHeight> {
    let own = ranges
        .iter()
        .filter(|r| r.objects.is_empty() || r.objects.contains(&o.id))
        .filter_map(|r| {
            layer_height_of(r)
                .and_then(serde_json::Value::as_f64)
                .map(|height_mm| RangeLayerHeight {
                    z_from_mm: r.z_from_mm,
                    z_to_mm: r.z_to_mm,
                    height_mm,
                })
        });
    o.mesh.layer_heights.iter().copied().chain(own).collect()
}

/// The layer tops a plate's layer height ranges give it: those of its objects' project files and the `layer_height`
/// of the request's height ranges `ranges`. Every printed object (one with triangles) must have the same ranges, and
/// the plan runs to the top of the highest one. The app sends a project's ranges this way and lets this plan them.
pub(crate) fn plate_range_tops(
    plate: &crate::Plate,
    ranges: &[crate::HeightRange],
    first_layer: f64,
    layer_height: f64,
) -> RangeTops {
    let printed: Vec<&crate::plate::PlateObject> = plate
        .objects
        .iter()
        .filter(|o| o.mesh.parts.iter().any(|p| !p.triangles.is_empty()))
        .collect();
    let heights: Vec<Vec<RangeLayerHeight>> =
        printed.iter().map(|o| object_layer_heights(o, ranges)).collect();
    let Some(first) = heights.first() else {
        return RangeTops::None;
    };
    if heights.iter().all(Vec::is_empty) {
        return RangeTops::None;
    }
    if heights.iter().any(|h| h != first) {
        return RangeTops::Differ;
    }
    let top = printed
        .iter()
        .flat_map(|o| {
            o.mesh
                .parts
                .iter()
                .flat_map(|p| p.positions.iter())
                .map(|&v| o.apply(v)[2])
        })
        .fold(0.0_f64, f64::max);
    range_layer_tops(first, top, first_layer, layer_height).map_or(RangeTops::None, RangeTops::Tops)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tops from `from` (exclusive) to `to` (inclusive) every `step`, mm, rounded to a micron.
    fn every(from: f64, to: f64, step: f64) -> Vec<f64> {
        (1..=100_000)
            .map(|i| ((from + f64::from(i) * step) * 1e6).round() / 1e6)
            .take_while(|z| *z <= to + 1e-9)
            .collect()
    }

    /// A 20 mm plate at 0.2 mm with a range of 0.1 mm layers from 5 to 10 mm: 0.2 mm layers up to 5 mm, 0.1 mm
    /// layers from there to 10 mm (the range ends where a layer's bottom reaches it), then 0.2 mm to the top.
    #[test]
    fn a_range_layer_height_steps_its_layers() {
        let range = [RangeLayerHeight {
            z_from_mm: 5.0,
            z_to_mm: 10.0,
            height_mm: 0.1,
        }];
        let tops = range_layer_tops(&range, 20.0, 0.2, 0.2).unwrap();
        let want: Vec<f64> = every(0.0, 5.0, 0.2)
            .into_iter()
            .chain(every(5.0, 10.0, 0.1))
            .chain(every(10.0, 20.0, 0.2))
            .collect();
        assert_eq!(tops, want);
        assert_eq!(tops.len(), 125);
        // The plan the slice takes from them.
        let plan = LayerPlan::from_tops(20.0, &tops, 0.04, 0.8).unwrap();
        assert_eq!(plan.count(), 125);
        assert!((plan.thickness(25) - 0.1).abs() < 1e-9);
        assert!((plan.thickness(75) - 0.2).abs() < 1e-9);
    }

    /// A range that ends off the layer grid: the layer that starts inside it keeps its height and crosses its top,
    /// the layers above take the base height from there, and the last one ends at the top.
    #[test]
    fn a_layer_starting_in_a_range_keeps_its_height() {
        let range = [RangeLayerHeight {
            z_from_mm: 1.0,
            z_to_mm: 1.25,
            height_mm: 0.15,
        }];
        let tops = range_layer_tops(&range, 2.0, 0.2, 0.2).unwrap();
        assert_eq!(tops, [0.2, 0.4, 0.6, 0.8, 1.0, 1.15, 1.3, 1.5, 1.7, 1.9, 2.0]);
    }

    /// A layer that would leave a sliver under the top reaches the top instead; nothing to plan without ranges or
    /// above the first layer.
    #[test]
    fn range_tops_end_at_the_top() {
        let range = [RangeLayerHeight {
            z_from_mm: 0.0,
            z_to_mm: 1.0,
            height_mm: 0.1,
        }];
        let tops = range_layer_tops(&range, 2.03, 0.2, 0.2).unwrap();
        assert!(
            matches!(tops.as_slice(), [.., below, last] if (below - 1.8).abs() < 1e-9 && (last - 2.03).abs() < 1e-9)
        );
        assert_eq!(range_layer_tops(&[], 2.0, 0.2, 0.2), None);
        assert_eq!(range_layer_tops(&range, 0.2, 0.2, 0.2), None);
    }

    /// A plate plans by its ranges only when every printed object has the same; the plan runs to the highest top.
    #[test]
    fn a_plate_plans_by_ranges_its_objects_share() {
        let block = |z: f32, heights: &[RangeLayerHeight]| {
            let positions = vec![
                [0.0, 0.0, 0.0],
                [10.0, 0.0, 0.0],
                [10.0, 10.0, 0.0],
                [0.0, 10.0, 0.0],
                [0.0, 0.0, z],
                [10.0, 0.0, z],
                [10.0, 10.0, z],
                [0.0, 10.0, z],
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
            crate::Mesh {
                parts: vec![crate::MeshPart {
                    name: "block".to_owned(),
                    slot: 1,
                    color: None,
                    positions,
                    triangles,
                    paint: Vec::new(),
                    support_paint: Vec::new(),
                    seam_paint: Vec::new(),
                    fuzzy_paint: Vec::new(),
                    paint_texts: Vec::new(),
                }],
                layer_heights: heights.to_vec(),
                ..crate::Mesh::default()
            }
        };
        let range = [RangeLayerHeight {
            z_from_mm: 1.0,
            z_to_mm: 2.0,
            height_mm: 0.1,
        }];
        let two = |a: crate::Mesh, b: crate::Mesh| {
            let mut plate = crate::Plate::single(a);
            let mut other = plate.objects[0].clone();
            other.id = "b".to_owned();
            other.mesh = std::sync::Arc::new(b);
            plate.objects.push(other);
            plate
        };
        assert_eq!(
            plate_range_tops(&two(block(3.0, &range), block(4.0, &range)), &[], 0.2, 0.2),
            RangeTops::Tops(range_layer_tops(&range, 4.0, 0.2, 0.2).unwrap())
        );
        assert_eq!(
            plate_range_tops(&two(block(3.0, &range), block(4.0, &[])), &[], 0.2, 0.2),
            RangeTops::Differ
        );
        assert_eq!(
            plate_range_tops(&two(block(3.0, &[]), block(4.0, &[])), &[], 0.2, 0.2),
            RangeTops::None
        );
        // A request's height ranges carry the same layer heights: for every object, or for each by id.
        let asked = |objects: &[&str]| crate::HeightRange {
            z_from_mm: 1.0,
            z_to_mm: 2.0,
            settings: serde_json::json!({"layer_height": 0.1}),
            objects: objects.iter().map(|&o| o.to_owned()).collect(),
        };
        let plain = two(block(3.0, &[]), block(4.0, &[]));
        let want = RangeTops::Tops(range_layer_tops(&range, 4.0, 0.2, 0.2).unwrap());
        assert_eq!(plate_range_tops(&plain, &[asked(&[])], 0.2, 0.2), want);
        let id = plain.objects[0].id.clone();
        assert_eq!(
            plate_range_tops(&plain, &[asked(&[&id]), asked(&["b"])], 0.2, 0.2),
            want
        );
        assert_eq!(
            plate_range_tops(&plain, &[asked(&["b"])], 0.2, 0.2),
            RangeTops::Differ
        );
        // A range without a layer height plans nothing.
        let walls = crate::HeightRange {
            settings: serde_json::json!({"wall_loops": 4}),
            ..asked(&[])
        };
        assert_eq!(plate_range_tops(&plain, &[walls], 0.2, 0.2), RangeTops::None);
    }

    #[test]
    fn a_ranges_layer_height_leaves_its_settings_for_the_plan() {
        let plate = crate::Plate::single(crate::Mesh::default());
        let range = |settings: serde_json::Value, objects: Vec<String>| crate::HeightRange {
            z_from_mm: 1.0,
            z_to_mm: 2.0,
            settings,
            objects,
        };
        let walls = range(serde_json::json!({"wall_loops": 4}), Vec::new());
        let (same, any) = without_layer_heights(&plate, std::slice::from_ref(&walls)).unwrap();
        assert!(!any);
        assert!(matches!(same, std::borrow::Cow::Borrowed(_)));
        let both = range(
            serde_json::json!({"layer_height": 0.1, "wall_loops": 4}),
            Vec::new(),
        );
        let only = range(serde_json::json!({"layer_height": 0.1}), Vec::new());
        let asked = [both, only, walls.clone()];
        let (left, any) = without_layer_heights(&plate, &asked).unwrap();
        assert!(any);
        assert_eq!(left.as_ref(), [walls.clone(), walls]);
        for bad in [
            range(serde_json::json!({"layer_height": "0.1"}), Vec::new()),
            range(serde_json::json!({"layer_height": 0}), Vec::new()),
            crate::HeightRange {
                z_to_mm: 1.0,
                ..range(serde_json::json!({"layer_height": 0.1}), Vec::new())
            },
            range(
                serde_json::json!({"layer_height": 0.1}),
                vec!["nowhere".to_owned()],
            ),
        ] {
            assert!(
                matches!(
                    without_layer_heights(&plate, std::slice::from_ref(&bad)),
                    Err(crate::Error::Config {
                        key: "options.heightRanges",
                        ..
                    })
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn reference_plate_has_508_layers() {
        let p = LayerPlan::new(101.53, 0.2, 0.2);
        assert_eq!(p.count(), 508);
        assert!((p.top(507) - 101.6).abs() < 1e-9);
    }

    #[test]
    fn support_layers_merge_by_height() {
        let object = [(0.2, 0.2), (0.4, 0.2), (0.6, 0.2)];
        let support = [(0.2, 0.2), (0.5, 0.3), (0.60001, 0.1)];
        let m = merge_layers(&object, &support);
        assert_eq!(m.len(), 4);
        assert_eq!((m[0].object, m[0].support), (Some(0), Some(0)));
        assert_eq!((m[1].object, m[1].support), (Some(1), None));
        assert_eq!((m[2].object, m[2].support), (None, Some(1)));
        assert!((m[2].height - 0.3).abs() < 1e-12);
        assert_eq!((m[3].object, m[3].support), (Some(2), Some(2)));
    }

    #[test]
    fn precise_z_height_stretches_the_last_five_layers_to_the_model_top() {
        let mut p = LayerPlan::new(10.05, 0.2, 0.2);
        let before = p.tops.clone();
        assert!((p.tops.last().unwrap() - 10.05).abs() > 0.01);
        p.align_height(10.05, 0.07, 0.3);
        assert!(
            (p.tops.last().unwrap() - 10.05).abs() < 1e-6,
            "{:?}",
            p.tops.last()
        );
        // Only the last five layers changed, each within the limits, and the cutting planes follow.
        let n = before.len();
        assert_eq!(&p.tops[..n - 5], &before[..n - 5]);
        assert!((n - 5..n).all(|i| (0.07..=0.3 + 1e-9).contains(&p.thickness(u32::try_from(i).unwrap()))));
        assert!((p.slice_z[n - 1] - f64::midpoint(p.tops[n - 1], p.tops[n - 2])).abs() < 1e-9);
        // A model that cannot be reached within the limits is left alone.
        let mut q = LayerPlan::new(10.4, 0.2, 0.2);
        let tops = q.tops.clone();
        q.align_height(10.4, 0.07, 0.2);
        assert_eq!(q.tops, tops);
    }

    #[test]
    fn explicit_tops() {
        let tops = [0.2, 0.4, 0.7, 1.0, 1.2];
        let p = LayerPlan::from_tops(1.05, &tops, 0.04, 0.8).unwrap();
        assert_eq!(p.count(), 4);
        assert!((p.thickness(2) - 0.3).abs() < 1e-9);
        assert!((p.slice_z[2] - 0.55).abs() < 1e-9);
        assert!(LayerPlan::from_tops(1.5, &tops, 0.04, 0.8).is_err());
        assert!(LayerPlan::from_tops(1.0, &[0.2, 0.2, 1.0], 0.04, 0.8).is_err());
        assert!(LayerPlan::from_tops(1.0, &[0.2, 1.4], 0.04, 0.8).is_err());
    }

    #[test]
    fn tops_that_end_at_the_model_top_within_float_noise_reach_it() {
        // A real project's plan: tops planned on the f32 plate mesh end 1.3e-6 mm under the f64 model top.
        let (top, model_top) = (39.350_002_288_818, 39.350_003_600_121);
        let tops: Vec<f64> = (1..=196).map(|i| f64::from(i) * 0.2).chain([top]).collect();
        let p = LayerPlan::from_tops(model_top, &tops, 0.04, 0.8).unwrap();
        assert_eq!(p.count(), 197);
        // Tops that stop short of the top by a layer, or by a tenth of the thinnest one, are still refused.
        assert!(LayerPlan::from_tops(model_top + 0.2, &tops, 0.04, 0.8).is_err());
        assert!(LayerPlan::from_tops(top + 0.004, &tops, 0.04, 0.8).is_err());
    }
}
