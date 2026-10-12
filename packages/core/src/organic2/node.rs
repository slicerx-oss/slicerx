// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A branch node: one layer of a branch, the area its center may lie in, and what it carries above.

use super::ops::P;
use super::volumes::Kind;
use crate::perimeters::Shapes;

/// How far a node moves going one layer down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Speed {
    /// Stands still.
    Zero,
    Slow,
    Fast,
}

/// One way of growing a node one layer down (spec 5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(clippy::struct_excessive_bools, reason = "the fields of a growth setting")]
pub(crate) struct Setting {
    pub(crate) kind: Kind,
    pub(crate) speed: Speed,
    /// The radius may grow.
    pub(crate) grow: bool,
    /// Last resort: the node moves through the model's wall limit and is flagged lost.
    pub(crate) error: bool,
    pub(crate) min_gap: bool,
    pub(crate) moves: bool,
}

/// The class a tip point gets from where its branch can go (spec 4.6), best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Class {
    BedSafe,
    Bed,
    ModelFlatSafe,
    ModelFlat,
    Model,
}

impl Class {
    pub(crate) fn to_bed(self) -> bool {
        matches!(self, Self::BedSafe | Self::Bed)
    }
    pub(crate) fn flat(self) -> bool {
        !matches!(self, Self::Model)
    }
    pub(crate) fn safe(self) -> bool {
        matches!(self, Self::BedSafe | Self::ModelFlatSafe)
    }
}

/// A roof a branch top should become once drawn: layers left and the depth below the overhang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Recovery {
    pub(crate) count: u32,
    pub(crate) depth: u32,
}

#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools, reason = "the flags of a branch node")]
pub(crate) struct Node {
    /// Layers below the tip.
    pub(crate) d: u32,
    /// Effective radius depth; may lag `d` where the branch could not widen.
    pub(crate) e: f64,
    /// Bed-widening steps taken.
    pub(crate) f: f64,
    /// Layer and position of the topmost tip this node carries.
    pub(crate) target_layer: usize,
    pub(crate) target: P,
    /// Where the center would like to be.
    pub(crate) hint: P,
    /// The chosen center (bottom-up, spec 6).
    pub(crate) center: Option<P>,
    pub(crate) to_bed: bool,
    pub(crate) flat: bool,
    pub(crate) min_gap: bool,
    pub(crate) supports_roof: bool,
    pub(crate) safe: bool,
    pub(crate) skip_oval: bool,
    /// Stand still until this depth.
    pub(crate) stay_until: u32,
    pub(crate) last: Option<Setting>,
    pub(crate) recovery: Option<Recovery>,
    /// Widening used so far to merge into a bed-reaching branch.
    pub(crate) merge_used: f64,
    pub(crate) lost: bool,
    pub(crate) very_lost: bool,
    /// Indices of the nodes on the layer above that this one carries.
    pub(crate) parents: Vec<usize>,
    /// The index of the node on the layer below that carries this one.
    pub(crate) child: Option<usize>,
    /// Where the center may lie.
    pub(crate) area: Shapes,
    /// The parts of `area` from which the bed, or a flat model top, can still be reached; merging works on
    /// them.
    pub(crate) bed_area: Shapes,
    pub(crate) model_area: Shapes,
    /// Skips merging this layer.
    pub(crate) bypass: bool,
    pub(crate) deleted: bool,
    /// Reached from below when centers were chosen.
    pub(crate) reached: bool,
}

impl Node {
    pub(crate) fn tip(at: P, layer: usize, class: Class, min_gap: bool) -> Self {
        Self {
            d: 0,
            e: 0.0,
            f: 0.0,
            target_layer: layer,
            target: at,
            hint: at,
            center: Some(at),
            to_bed: class.to_bed(),
            flat: class.flat(),
            min_gap,
            supports_roof: false,
            safe: class.safe(),
            skip_oval: false,
            stay_until: 0,
            last: None,
            recovery: None,
            merge_used: 0.0,
            lost: false,
            very_lost: false,
            parents: Vec::new(),
            child: None,
            area: super::ops::circle(at, 0.01, 25),
            bed_area: Vec::new(),
            model_area: Vec::new(),
            bypass: false,
            deleted: false,
            reached: false,
        }
    }
}
