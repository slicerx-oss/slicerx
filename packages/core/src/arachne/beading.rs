// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Beading strategies: how many lines of which widths cover a stretch of wall that is a given
//! thickness. The strategies wrap each other (distribute the width, keep the outer walls at their
//! own width, widen thin features, inset the outer wall, cap the count), following the layering
//! in the Arachne paper (Kuipers et al., "A framework for adaptive width control of dense
//! contour-parallel toolpaths in fused deposition modeling").
//!
//! Lengths are in nanometers (`i64`), the unit of the rest of the module.

/// The lines that cover a stretch of wall.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Beading {
    pub(crate) total_thickness: i64,
    /// Width of each bead from the outer wall inward.
    pub(crate) bead_widths: Vec<i64>,
    /// Distance of each bead's center from the outline.
    pub(crate) toolpath_locations: Vec<i64>,
    /// Thickness no bead covers.
    pub(crate) left_over: i64,
}

pub(crate) trait Strategy {
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading;
    fn optimal_thickness(&self, bead_count: i64) -> i64;
    fn transition_thickness(&self, lower_bead_count: i64) -> i64;
    fn optimal_bead_count(&self, thickness: i64) -> i64;
    fn transitioning_length(&self, lower_bead_count: i64) -> i64;
    fn transition_anchor_pos(&self, lower_bead_count: i64) -> f64;
    /// Thicknesses inside one bead count where the widths bend.
    fn nonlinear_thicknesses(&self, lower_bead_count: i64) -> Vec<i64>;
    fn split_middle_threshold(&self) -> f64;
    fn transitioning_angle(&self) -> f64;
}

/// Nanometers in a millimeter.
pub(crate) const NM: f64 = 1_000_000.0;

pub(crate) fn nm(mm: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation, reason = "a length in nanometers")]
    let v = (mm * NM).round() as i64;
    v
}

/// The base: all beads share the thickness the same, with the extra spread over the middle ones.
pub(crate) struct Distributed {
    optimal_width: i64,
    transition_length: i64,
    angle: f64,
    split_middle: f64,
    add_middle: f64,
    one_over_radius_squared: f64,
}

impl Distributed {
    pub(crate) fn new(
        optimal_width: i64,
        transition_length: i64,
        angle: f64,
        split_middle: f64,
        add_middle: f64,
        distribution_radius: i64,
    ) -> Self {
        #[allow(clippy::cast_precision_loss, reason = "a small count")]
        let r = if distribution_radius >= 2 {
            (distribution_radius - 1) as f64
        } else {
            1.0
        };
        Self {
            optimal_width,
            transition_length,
            angle,
            split_middle,
            add_middle,
            one_over_radius_squared: 1.0 / (r * r),
        }
    }
}

impl Strategy for Distributed {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "bead counts and widths in nm"
    )]
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let mut ret = Beading {
            total_thickness: thickness,
            ..Beading::default()
        };
        if bead_count > 2 {
            let to_divide = thickness - bead_count * self.optimal_width;
            let middle = (bead_count - 1) as f64 / 2.0;
            let weights: Vec<f64> = (0..bead_count)
                .map(|i| {
                    let dev = i as f64 - middle;
                    (1.0 - self.one_over_radius_squared * dev * dev).max(0.0)
                })
                .collect();
            let total: f64 = weights.iter().sum();
            let mut accumulated = 0i64;
            for (i, w) in weights.iter().enumerate() {
                let share = (to_divide as f64 * (w / total)) as i64;
                let width = if i as i64 == bead_count - 1 {
                    thickness - accumulated
                } else {
                    self.optimal_width + share
                };
                let loc = match (ret.toolpath_locations.last(), ret.bead_widths.last()) {
                    (Some(l), Some(pw)) => l + (pw + width) / 2,
                    _ => width / 2,
                };
                ret.toolpath_locations.push(loc);
                ret.bead_widths.push(width);
                accumulated += width;
            }
            ret.left_over = 0;
        } else if bead_count == 2 {
            let outer = thickness / 2;
            ret.bead_widths = vec![outer, outer];
            ret.toolpath_locations = vec![outer / 2, thickness - outer / 2];
        } else if bead_count == 1 {
            ret.bead_widths = vec![thickness];
            ret.toolpath_locations = vec![thickness / 2];
        } else {
            ret.left_over = thickness;
        }
        ret
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.optimal_width * bead_count
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "widths in nm"
    )]
    fn transition_thickness(&self, lower: i64) -> i64 {
        let lo = self.optimal_thickness(lower);
        let hi = self.optimal_thickness(lower + 1);
        let threshold = if lower % 2 == 1 {
            self.split_middle
        } else {
            self.add_middle
        };
        lo + (threshold * (hi - lo) as f64) as i64
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "widths in nm"
    )]
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        let naive = thickness / self.optimal_width;
        let remainder = thickness - naive * self.optimal_width;
        let threshold = if naive % 2 == 1 {
            self.split_middle
        } else {
            self.add_middle
        };
        let minimum = (self.optimal_width as f64 * threshold) as i64;
        naive + i64::from(remainder >= minimum)
    }

    fn transitioning_length(&self, lower: i64) -> i64 {
        if lower == 0 {
            nm(0.01)
        } else {
            self.transition_length
        }
    }

    #[allow(clippy::cast_precision_loss, reason = "widths in nm")]
    fn transition_anchor_pos(&self, lower: i64) -> f64 {
        let lower_opt = self.optimal_thickness(lower);
        let point = self.transition_thickness(lower);
        let upper_opt = self.optimal_thickness(lower + 1);
        1.0 - (point - lower_opt) as f64 / (upper_opt - lower_opt) as f64
    }

    fn nonlinear_thicknesses(&self, _lower: i64) -> Vec<i64> {
        Vec::new()
    }

    fn split_middle_threshold(&self) -> f64 {
        self.split_middle
    }

    fn transitioning_angle(&self) -> f64 {
        self.angle
    }
}

/// Keeps the two outer walls at their own width and lets the parent distribute the rest.
pub(crate) struct Redistribute {
    parent: Box<dyn Strategy>,
    outer_width: i64,
    min_variable_ratio: f64,
}

impl Redistribute {
    pub(crate) fn new(outer_width: i64, min_variable_ratio: f64, parent: Box<dyn Strategy>) -> Self {
        Self {
            parent,
            outer_width,
            min_variable_ratio,
        }
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "widths in nm"
    )]
    fn ratio_width(&self, r: f64) -> i64 {
        (r * self.outer_width as f64) as i64
    }
}

impl Strategy for Redistribute {
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        if bead_count == 0 || thickness < self.ratio_width(self.min_variable_ratio) {
            return Beading {
                total_thickness: thickness,
                left_over: thickness,
                ..Beading::default()
            };
        }
        let inner_count = bead_count - 2;
        let inner_thickness = thickness - 2 * self.outer_width;
        let mut ret = Beading::default();
        if inner_count > 0 && inner_thickness > 0 {
            ret = self.parent.compute(inner_thickness, inner_count);
            for l in &mut ret.toolpath_locations {
                *l += self.outer_width;
            }
        }
        let outer = if bead_count > 2 {
            (thickness / 2).min(self.outer_width)
        } else {
            thickness / bead_count
        };
        ret.bead_widths.insert(0, outer);
        ret.toolpath_locations.insert(0, outer / 2);
        if bead_count > 1 {
            ret.bead_widths.push(outer);
            ret.toolpath_locations.push(thickness - outer / 2);
        }
        ret.total_thickness = thickness;
        ret.left_over = thickness - ret.bead_widths.iter().sum::<i64>();
        ret
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        let inner = (bead_count - 2).max(0);
        let outer = bead_count - inner;
        self.parent.optimal_thickness(inner) + self.outer_width * outer
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "widths in nm"
    )]
    fn transition_thickness(&self, lower: i64) -> i64 {
        match lower {
            0 => self.ratio_width(self.min_variable_ratio),
            1 => ((1.0 + self.parent.split_middle_threshold()) * self.outer_width as f64) as i64,
            _ => self.parent.transition_thickness(lower - 2) + 2 * self.outer_width,
        }
    }

    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        if thickness < self.ratio_width(self.min_variable_ratio) {
            return 0;
        }
        if thickness <= 2 * self.outer_width {
            return if thickness > self.ratio_width(1.0 + self.parent.split_middle_threshold()) {
                2
            } else {
                1
            };
        }
        self.parent.optimal_bead_count(thickness - 2 * self.outer_width) + 2
    }

    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }

    fn transition_anchor_pos(&self, lower: i64) -> f64 {
        self.parent.transition_anchor_pos(lower)
    }

    fn nonlinear_thicknesses(&self, lower: i64) -> Vec<i64> {
        self.parent.nonlinear_thicknesses(lower)
    }

    fn split_middle_threshold(&self) -> f64 {
        self.parent.split_middle_threshold()
    }

    fn transitioning_angle(&self) -> f64 {
        self.parent.transitioning_angle()
    }
}

/// Prints features thinner than a normal bead as one wider bead, down to a minimum width.
pub(crate) struct Widening {
    parent: Box<dyn Strategy>,
    min_input_width: i64,
    min_output_width: i64,
}

impl Widening {
    pub(crate) fn new(parent: Box<dyn Strategy>, min_input_width: i64, min_output_width: i64) -> Self {
        Self {
            parent,
            min_input_width,
            min_output_width,
        }
    }
}

impl Strategy for Widening {
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        // Only one bead at most collapses to a single wide one; two asked for stay two.
        if bead_count <= 1 && thickness < self.transition_thickness(1) {
            let mut ret = Beading {
                total_thickness: thickness,
                ..Beading::default()
            };
            if thickness >= self.min_input_width {
                ret.bead_widths.push(thickness.max(self.min_output_width));
                ret.toolpath_locations.push(thickness / 2);
            } else {
                ret.left_over = thickness;
            }
            ret
        } else {
            self.parent.compute(thickness, bead_count)
        }
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.parent.optimal_thickness(bead_count)
    }

    fn transition_thickness(&self, lower: i64) -> i64 {
        if lower == 0 {
            self.min_input_width
        } else {
            self.parent.transition_thickness(lower)
        }
    }

    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        if thickness < self.min_input_width {
            return 0;
        }
        self.parent.optimal_bead_count(thickness).max(1)
    }

    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }

    fn transition_anchor_pos(&self, lower: i64) -> f64 {
        self.parent.transition_anchor_pos(lower)
    }

    fn nonlinear_thicknesses(&self, lower: i64) -> Vec<i64> {
        let mut ret = vec![self.min_output_width];
        ret.extend(self.parent.nonlinear_thicknesses(lower));
        ret
    }

    fn split_middle_threshold(&self) -> f64 {
        self.parent.split_middle_threshold()
    }

    fn transitioning_angle(&self) -> f64 {
        self.parent.transitioning_angle()
    }
}

/// Moves the outer wall inward by `offset` (never past the middle of the thickness).
pub(crate) struct OuterInset {
    parent: Box<dyn Strategy>,
    offset: i64,
}

impl OuterInset {
    pub(crate) fn new(offset: i64, parent: Box<dyn Strategy>) -> Self {
        Self { parent, offset }
    }
}

impl Strategy for OuterInset {
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let mut ret = self.parent.compute(thickness, bead_count);
        let real = ret.bead_widths.iter().filter(|w| **w > 0).count();
        if real >= 2
            && let Some(first) = ret.toolpath_locations.first_mut()
        {
            *first = (*first + self.offset).min(thickness / 2);
        }
        ret
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.parent.optimal_thickness(bead_count)
    }

    fn transition_thickness(&self, lower: i64) -> i64 {
        self.parent.transition_thickness(lower)
    }

    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        self.parent.optimal_bead_count(thickness)
    }

    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }

    fn transition_anchor_pos(&self, lower: i64) -> f64 {
        self.parent.transition_anchor_pos(lower)
    }

    fn nonlinear_thicknesses(&self, lower: i64) -> Vec<i64> {
        self.parent.nonlinear_thicknesses(lower)
    }

    fn split_middle_threshold(&self) -> f64 {
        self.parent.split_middle_threshold()
    }

    fn transitioning_angle(&self) -> f64 {
        self.parent.transitioning_angle()
    }
}

/// Caps the bead count, and marks the edge of the walled area with zero-width beads.
pub(crate) struct Limited {
    parent: Box<dyn Strategy>,
    max_beads: i64,
}

impl Limited {
    pub(crate) fn new(max_beads: i64, parent: Box<dyn Strategy>) -> Self {
        Self { parent, max_beads }
    }

    /// Inserts a zero-width bead after bead `at` (0-based), at the inner edge of that bead.
    fn mark_inner_edge(ret: &mut Beading, at: usize) {
        if let (Some(loc), Some(w)) = (
            ret.toolpath_locations.get(at).copied(),
            ret.bead_widths.get(at).copied(),
        ) {
            ret.toolpath_locations.insert(at + 1, loc + w / 2);
            ret.bead_widths.insert(at + 1, 0);
        }
    }
}

impl Strategy for Limited {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_possible_wrap,
        reason = "bead counts are small"
    )]
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let max = self.max_beads;
        if bead_count <= max {
            let mut ret = self.parent.compute(thickness, bead_count);
            let count = ret.toolpath_locations.len() as i64;
            if count % 2 == 0 && count == max {
                Self::mark_inner_edge(&mut ret, (max / 2 - 1) as usize);
            }
            return ret;
        }
        let optimal = self.parent.optimal_thickness(max);
        let mut ret = self.parent.compute(optimal, max);
        let count = ret.toolpath_locations.len();
        ret.left_over += thickness - ret.total_thickness;
        ret.total_thickness = thickness;
        if count % 2 == 1 {
            if let Some(l) = ret.toolpath_locations.get_mut(count / 2) {
                *l = thickness / 2;
            }
            if let Some(w) = ret.bead_widths.get_mut(count / 2) {
                *w = thickness - optimal;
            }
        }
        for i in 0..count.div_ceil(2) {
            let mirror = count - 1 - i;
            if let Some(l) = ret.toolpath_locations.get(i).copied()
                && let Some(m) = ret.toolpath_locations.get_mut(mirror)
            {
                *m = thickness - l;
            }
        }
        // A zero-width bead on each side of the walled area marks where the infill area starts.
        let half = (max / 2 - 1).max(0) as usize;
        Self::mark_inner_edge(&mut ret, half);
        let opposite = count - half;
        if let (Some(loc), Some(w)) = (
            ret.toolpath_locations.get(opposite).copied(),
            ret.bead_widths.get(opposite).copied(),
        ) {
            ret.toolpath_locations.insert(opposite, loc - w / 2);
            ret.bead_widths.insert(opposite, 0);
        }
        ret
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        if bead_count <= self.max_beads {
            self.parent.optimal_thickness(bead_count)
        } else {
            nm(1000.0)
        }
    }

    fn transition_thickness(&self, lower: i64) -> i64 {
        match lower.cmp(&self.max_beads) {
            std::cmp::Ordering::Less => self.parent.transition_thickness(lower),
            std::cmp::Ordering::Equal => self.parent.optimal_thickness(lower + 1) - nm(0.01),
            std::cmp::Ordering::Greater => nm(900.0),
        }
    }

    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        let parent = self.parent.optimal_bead_count(thickness);
        if parent <= self.max_beads {
            parent
        } else if parent == self.max_beads + 1 {
            if thickness < self.parent.optimal_thickness(self.max_beads + 1) - nm(0.01) {
                self.max_beads
            } else {
                self.max_beads + 1
            }
        } else {
            self.max_beads + 1
        }
    }

    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }

    fn transition_anchor_pos(&self, lower: i64) -> f64 {
        self.parent.transition_anchor_pos(lower)
    }

    fn nonlinear_thicknesses(&self, lower: i64) -> Vec<i64> {
        self.parent.nonlinear_thicknesses(lower)
    }

    fn split_middle_threshold(&self) -> f64 {
        self.parent.split_middle_threshold()
    }

    fn transitioning_angle(&self) -> f64 {
        self.parent.transitioning_angle()
    }
}

/// Athena (preFlight's fork of Arachne): every bead keeps its width, and what the thickness does not divide
/// evenly goes into the spacing of the middle beads. The spacing of the outer bead to the first inner
/// one and of inner beads to each other are settings (the overlap of walls), not the widths.
pub(crate) struct Athena {
    outer_width: i64,
    inner_width: i64,
    /// Center distance of the outer bead to the first inner one, and of inner beads.
    ext_spacing: i64,
    inner_spacing: i64,
    transition_length: i64,
    angle: f64,
    split_middle: f64,
    add_middle: f64,
}

impl Athena {
    #[allow(clippy::too_many_arguments, reason = "the strategy's own settings")]
    pub(crate) fn new(
        outer_width: i64,
        inner_width: i64,
        ext_spacing: i64,
        inner_spacing: i64,
        transition_length: i64,
        angle: f64,
        split_middle: f64,
        add_middle: f64,
    ) -> Self {
        Self {
            outer_width,
            inner_width,
            ext_spacing,
            inner_spacing,
            transition_length,
            angle,
            split_middle,
            add_middle,
        }
    }

    /// Center of the `k`th bead counted from one outline, at the nominal spacing.
    fn center(&self, k: i64) -> i64 {
        let c0 = self.outer_width / 2;
        if k <= 0 {
            c0
        } else {
            c0 + self.ext_spacing + (k - 1) * self.inner_spacing
        }
    }

    /// One or two beads, where preFlight's center absorbing strategy (`CenterAbsorbBeadingStrategy`) widens
    /// the beads to take up what the thickness leaves, by the factor width over spacing of the inner beads
    /// (the overlap), never below a third of that width, and never past the wall itself.
    fn absorb_thin(&self, thickness: i64, n: i64) -> Beading {
        let mut ret = Beading {
            total_thickness: thickness,
            ..Beading::default()
        };
        let (nominal_w, nominal_s) = (self.inner_width, self.inner_spacing);
        let overlap = if nominal_w > 0 {
            (nominal_w - nominal_s) as f64 / nominal_w as f64
        } else {
            0.0
        };
        let factor = 1.0 / (1.0 - overlap).max(0.05);
        let min_safe = nominal_w / 3;
        if n == 1 {
            // The wall's single bead: widened by the thickness left over, within the wall.
            let left_over = thickness - self.ext_spacing;
            let wanted = self.outer_width + (left_over as f64 * factor) as i64;
            let wall = thickness + (self.outer_width - self.ext_spacing);
            let width = wanted.min(wall);
            let width = if width < min_safe { self.outer_width } else { width };
            ret.bead_widths.push(width);
            ret.toolpath_locations.push(thickness / 2);
            ret.left_over = 0;
            return ret;
        }
        // Two beads face their own outline, each in half the thickness.
        let half = thickness / 2;
        let mut width = self.outer_width;
        if half < self.ext_spacing {
            // A thin wall: contract the width to keep the overlap ratio; nothing is left over.
            width = (half as f64 * self.outer_width as f64 / self.ext_spacing as f64) as i64;
            ret.bead_widths = vec![width.min(self.outer_width); 2];
            ret.toolpath_locations = vec![half / 2, thickness - half / 2];
            return ret;
        }
        let left_over = thickness - 2 * self.ext_spacing;
        let mut at = half / 2;
        if left_over > 0 && overlap >= 0.0 {
            let per = left_over / 2;
            let new_w = width + (per as f64 * factor) as i64;
            let target = (new_w as f64 * (1.0 - overlap)) as i64;
            let close = per - (new_w - target) / 2;
            if new_w >= min_safe {
                width = new_w;
                at = half / 2 + close / 2;
            }
        }
        ret.bead_widths = vec![width; 2];
        ret.toolpath_locations = vec![at, thickness - at];
        ret
    }

    /// The thickness `n` beads cover at the nominal spacing.
    fn nominal(&self, n: i64) -> i64 {
        match n {
            ..=0 => 0,
            1 => self.outer_width,
            _ if n % 2 == 1 => 2 * self.center((n + 1) / 2 - 1),
            2 => self.outer_width + self.ext_spacing,
            _ => 2 * self.center(n / 2 - 1) + self.inner_spacing,
        }
    }
}

impl Strategy for Athena {
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let mut ret = Beading {
            total_thickness: thickness,
            ..Beading::default()
        };
        if bead_count <= 0 {
            ret.left_over = thickness;
            return ret;
        }
        let n = bead_count;
        if n <= 2 {
            return self.absorb_thin(thickness, n);
        }
        let k = (n + 1) / 2;
        // What the thickness leaves over the nominal spacing goes to the middle bead (or the middle two), which
        // widen to cover it, as preFlight's center absorbing strategy does.
        // Kept at nominal width, the middle beads left a gap of up to half a spacing: a 1.4 mm bar printed 11
        // percent less than Arachne and classic walls.
        // Only a gap is taken up: where the beads crowd, they overlap a little as before rather than thin down.
        let left_over = (thickness - self.nominal(n)).max(0);
        let (nominal_w, nominal_s) = (self.inner_width, self.inner_spacing);
        let overlap = if nominal_w > 0 {
            (nominal_w - nominal_s) as f64 / nominal_w as f64
        } else {
            0.0
        };
        let factor = 1.0 / (1.0 - overlap).max(0.05);
        let min_safe = nominal_w / 3;
        let widen = |w: i64, by: i64| -> i64 {
            (w + (by as f64 * factor) as i64).clamp(min_safe.max(1), 2 * nominal_w)
        };
        for i in 0..n {
            let mut width = if i == 0 || i == n - 1 {
                self.outer_width
            } else {
                self.inner_width
            };
            // The beads from the far outline mirror the near ones; the middle one or two take what is left.
            let near = if i < k { i } else { n - 1 - i };
            let mut loc = self.center(near);
            if n % 2 == 1 && i == k - 1 {
                loc = thickness / 2;
                width = widen(width, left_over);
            } else if n % 2 == 0 && (i == k - 1 || i == k) {
                // The middle pair each take half, moved in by a quarter so the gap between them closes.
                width = widen(width, left_over / 2);
                loc = if i == k - 1 {
                    loc + left_over / 4
                } else {
                    thickness - (loc + left_over / 4)
                };
                loc = loc.clamp(0, thickness);
            } else if i >= k {
                loc = thickness - loc.min(thickness / 2);
            } else {
                loc = loc.min(thickness / 2);
            }
            ret.bead_widths.push(width);
            ret.toolpath_locations.push(loc);
        }
        ret
    }

    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.nominal(bead_count)
    }

    fn transition_thickness(&self, lower_bead_count: i64) -> i64 {
        self.nominal(lower_bead_count)
            .midpoint(self.nominal(lower_bead_count + 1))
    }

    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        let mut n = 0;
        while n < 4096 && thickness >= self.transition_thickness(n) {
            n += 1;
        }
        n
    }

    fn transitioning_length(&self, _lower_bead_count: i64) -> i64 {
        self.transition_length
    }

    fn transition_anchor_pos(&self, _lower_bead_count: i64) -> f64 {
        0.5
    }

    fn nonlinear_thicknesses(&self, _lower_bead_count: i64) -> Vec<i64> {
        Vec::new()
    }

    fn split_middle_threshold(&self) -> f64 {
        self.split_middle
    }

    fn transitioning_angle(&self) -> f64 {
        let _ = self.add_middle;
        self.angle
    }
}

/// Settings the wall generator hands the strategy factory.
pub(crate) struct Params {
    pub(crate) outer_width: i64,
    pub(crate) inner_width: i64,
    pub(crate) transition_length: i64,
    pub(crate) transitioning_angle: f64,
    pub(crate) print_thin_walls: bool,
    pub(crate) min_bead_width: i64,
    pub(crate) min_feature_size: i64,
    pub(crate) split_middle: f64,
    pub(crate) add_middle: f64,
    pub(crate) max_bead_count: i64,
    pub(crate) outer_inset: i64,
    pub(crate) distribution_count: i64,
    pub(crate) min_variable_ratio: f64,
    /// Athena: the spacing of the outer bead to the first inner one and of inner beads, nm; None keeps Arachne.
    pub(crate) athena: Option<(i64, i64)>,
}

pub(crate) fn make(p: &Params) -> Box<dyn Strategy> {
    // A single outer wall has to match its own width.
    let optimal = if p.max_bead_count <= 2 {
        p.outer_width
    } else {
        p.inner_width
    };
    let mut s: Box<dyn Strategy> = if let Some((ext, inner)) = p.athena {
        Box::new(Athena::new(
            p.outer_width,
            p.inner_width,
            ext,
            inner,
            p.transition_length,
            p.transitioning_angle,
            p.split_middle,
            p.add_middle,
        ))
    } else {
        let base: Box<dyn Strategy> = Box::new(Distributed::new(
            optimal,
            p.transition_length,
            p.transitioning_angle,
            p.split_middle,
            p.add_middle,
            p.distribution_count,
        ));
        Box::new(Redistribute::new(p.outer_width, p.min_variable_ratio, base))
    };
    if p.print_thin_walls {
        s = Box::new(Widening::new(s, p.min_feature_size, p.min_bead_width));
    }
    if p.outer_inset != 0 {
        s = Box::new(OuterInset::new(p.outer_inset, s));
    }
    Box::new(Limited::new(p.max_bead_count, s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strategy(max: i64) -> Box<dyn Strategy> {
        make(&Params {
            outer_width: nm(0.42),
            inner_width: nm(0.42),
            transition_length: nm(0.4),
            transitioning_angle: 10f64.to_radians(),
            print_thin_walls: true,
            min_bead_width: nm(0.34),
            min_feature_size: nm(0.1),
            split_middle: 0.85,
            add_middle: 0.8,
            max_bead_count: max,
            outer_inset: 0,
            distribution_count: 1,
            min_variable_ratio: 0.5,
            athena: None,
        })
    }

    #[test]
    fn thin_features_get_one_wide_bead_and_thick_ones_more() {
        let s = strategy(6);
        assert_eq!(s.optimal_bead_count(nm(0.05)), 0);
        assert_eq!(s.optimal_bead_count(nm(0.3)), 1);
        assert_eq!(s.optimal_bead_count(nm(0.84)), 2);
        assert!(s.optimal_bead_count(nm(1.7)) >= 4);
        let b = s.compute(nm(0.84), 2);
        assert_eq!(b.bead_widths.len(), 2);
        assert_eq!(b.bead_widths.iter().sum::<i64>() + b.left_over, nm(0.84));
    }

    #[test]
    fn athena_keeps_the_outer_widths_and_the_middle_beads_take_the_rest() {
        let s = make(&Params {
            outer_width: nm(0.4),
            inner_width: nm(0.4),
            transition_length: nm(0.4),
            transitioning_angle: 10f64.to_radians(),
            print_thin_walls: false,
            min_bead_width: nm(0.34),
            min_feature_size: nm(0.1),
            split_middle: 0.85,
            add_middle: 0.8,
            max_bead_count: 8,
            outer_inset: 0,
            distribution_count: 1,
            min_variable_ratio: 0.5,
            athena: Some((nm(0.38), nm(0.36))),
        });
        // Four beads: nominal thickness 2 * (0.2 + 0.38) + 0.36 = 1.52.
        assert_eq!(s.optimal_bead_count(nm(1.52)), 4);
        let b = s.compute(nm(1.7), 4);
        // The outer beads keep their width and place; the middle two each take half of the 0.18 mm left over,
        // widened by width over spacing (0.09 / 0.9 = 0.1) and moved in by a quarter of it, so no gap is left.
        assert_eq!(b.bead_widths[0], nm(0.4));
        assert_eq!(b.bead_widths[3], nm(0.4));
        assert!((b.bead_widths[1] - nm(0.5)).abs() <= 1, "{:?}", b.bead_widths);
        assert_eq!(b.bead_widths[1], b.bead_widths[2]);
        assert_eq!(b.toolpath_locations[0], nm(0.2));
        assert_eq!(b.toolpath_locations[1], nm(0.58) + nm(0.18) / 4);
        assert_eq!(b.toolpath_locations[2], nm(1.7) - (nm(0.58) + nm(0.18) / 4));
        assert_eq!(b.toolpath_locations[3], nm(1.5));
        // Crowded (thinner than nominal), the middle beads keep their width and overlap a little.
        let c = s.compute(nm(1.48), 4);
        assert!(c.bead_widths.iter().all(|w| *w == nm(0.4)), "{:?}", c.bead_widths);
    }

    #[test]
    fn the_limit_adds_zero_width_markers() {
        let s = strategy(2);
        let b = s.compute(nm(3.0), 3);
        assert!(b.bead_widths.contains(&0));
    }
}
