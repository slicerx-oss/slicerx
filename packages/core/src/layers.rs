// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 1: the layer plan.

use crate::error::{Error, Result};

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
        if covered < max_z - 1e-6 && plan.slice_z.len() == tops.len() {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
