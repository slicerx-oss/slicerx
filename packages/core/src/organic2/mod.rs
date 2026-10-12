// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree supports, written from a behavior description alone.
//!
//! Branches start as thin tips under each overhang, grow down and wider one layer at a time inside the
//! area the model leaves free, merge where they meet, and end on the bed or on a flat top of the model.
//! The trees are then smoothed, drawn as tube meshes and sliced into support layers.
//!
//! Stages, each in its own file: settings and derived values ([`params`]), overhangs ([`overhang`]),
//! model volumes ([`volumes`]), tips ([`tips`]), growth ([`grow`]) and merging ([`merge`]), centers
//! ([`centers`]), drawing ([`draw`]), layer areas ([`assemble`]) and toolpaths ([`paths`]).
//!
//! Selected with `organic_support_engine: "v2"`; `organic_quirks` turns on behaviors of the
//! reference slicer that differ from what its settings describe (see [`params::Quirks`]).

pub(crate) mod assemble;
mod centers;
pub(crate) mod draw;
mod grow;
mod merge;
mod node;
mod ops;
pub(crate) mod overhang;
pub(crate) mod params;
pub(crate) mod paths;
mod sample;
mod tips;
mod volumes;

use crate::perimeters::Shapes;
pub(crate) use assemble::Layer;
pub(crate) use params::{Quirks, Settings};

/// True when `organic_support_engine` asks for this engine (`"v2"`); the default `"legacy"` keeps
/// the existing one.
pub(crate) fn selected(cfg: &crate::config::PrintConfig) -> bool {
    matches!(cfg.raw.get("organic_support_engine"), Some(serde_json::Value::String(t)) if t == "v2")
}

/// What organic trees are planned from.
pub(crate) struct Input<'a> {
    /// Object slices per object layer.
    pub(crate) models: &'a [Shapes],
    /// Print Z of each object layer, not counting a raft.
    pub(crate) tops: &'a [f64],
    /// Enforcer and blocker areas per object layer.
    pub(crate) force: &'a [Shapes],
    pub(crate) block: &'a [Shapes],
    /// Bed rectangle `[x0, y0, x1, y1]`.
    pub(crate) bed: [f64; 4],
    /// The plate middle, which fill lines are anchored at.
    pub(crate) center: [f64; 2],
    pub(crate) settings: Settings,
    pub(crate) detect: overhang::Detect,
    /// Painted enforcement on vertical faces, as 3D points.
    pub(crate) vertical_points: Vec<[f64; 3]>,
    /// Print Z of each raft layer, and how far the object is lifted by the raft.
    pub(crate) raft_tops: Vec<f64>,
    pub(crate) raft_offset: f64,
    /// The raft's top contact area.
    pub(crate) raft_contact: Shapes,
    /// The walls and bottom-bridge surfaces of each region of an object layer, which bridge removal
    /// reads. Asked only for layers with overhang; without it they are approximated.
    pub(crate) regions: Option<&'a (dyn Fn(usize) -> Vec<overhang::RegionIn> + Sync)>,
}

/// Counts for the trace.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Stats {
    pub(crate) tips: usize,
    pub(crate) nodes: usize,
    pub(crate) branches: usize,
    /// Nodes that grew through the model's wall limit, and roots that lost their way.
    pub(crate) lost: usize,
}

/// The plan: one layer per object layer, and the branch areas through the raft layers.
pub(crate) struct Plan {
    pub(crate) layers: Vec<Layer>,
    pub(crate) raft: Vec<Shapes>,
}

struct Trace {
    on: bool,
    #[cfg(not(target_arch = "wasm32"))]
    at: std::time::Instant,
}

impl Trace {
    fn new() -> Self {
        Self {
            on: std::env::var_os("SX_ORGANIC2_TRACE").is_some(),
            #[cfg(not(target_arch = "wasm32"))]
            at: std::time::Instant::now(),
        }
    }

    #[allow(clippy::print_stderr, reason = "a trace asked for by environment variable")]
    fn stage(&mut self, name: &str) {
        if !self.on {
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let now = std::time::Instant::now();
            eprintln!("organic2 {name}: {:.3} s", (now - self.at).as_secs_f64());
            self.at = now;
        }
        #[cfg(target_arch = "wasm32")]
        eprintln!("organic2 {name}");
    }

    /// Depth, radius depth, widening and drawn radius of the nodes on the lowest layers, with
    /// `SX_ORGANIC2_TRACE=roots`.
    #[allow(clippy::print_stderr, reason = "a trace asked for by environment variable")]
    fn roots(&self, p: &params::Params, nodes: &[Vec<node::Node>]) {
        if !self.on || std::env::var("SX_ORGANIC2_TRACE").ok().as_deref() != Some("roots") {
            return;
        }
        if let Ok(range) = std::env::var("SX_ORGANIC2_CLASSES") {
            let mut it = range.split(',').filter_map(|v| v.parse::<usize>().ok());
            let (lo, hi) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
            for (l, layer) in nodes.iter().enumerate().skip(lo).take(hi.saturating_sub(lo)) {
                let bed = layer.iter().filter(|n| n.to_bed).count();
                let flat = layer.iter().filter(|n| n.flat && !n.to_bed).count();
                let gap = layer.iter().filter(|n| n.min_gap).count();
                eprintln!("organic2 layer {l} nodes {} bed {bed} flat-only {flat} min-gap {gap}", layer.len());
            }
            return;
        }
        for (l, layer) in nodes.iter().enumerate().take(20) {
            for n in layer {
                eprintln!(
                    "organic2 root layer {l} d {} e {:.2} f {:.2} drawn {:.3} rec {:.3}",
                    n.d,
                    n.e,
                    n.f,
                    p.drawn_radius(f64::from(n.d), n.e, n.f),
                    p.recommended_min_radius(l)
                );
            }
        }
    }

    /// Tip positions by print Z, with `SX_ORGANIC2_TRACE=tips`.
    #[allow(clippy::print_stderr, reason = "a trace asked for by environment variable")]
    fn tips_by_layer(&self, tips: &[(usize, node::Node)], tops: &[f64]) {
        if !self.on || std::env::var("SX_ORGANIC2_TRACE").ok().as_deref() != Some("tips") {
            return;
        }
        for (l, n) in tips {
            let z = tops.get(*l).copied().unwrap_or(f64::NAN);
            eprintln!(
                "organic2 tip z {z:.2} at {:.3} {:.3} bed {} flat {} safe {}",
                f64::from(n.target.x) / crate::geom::SCALE,
                f64::from(n.target.y) / crate::geom::SCALE,
                n.to_bed,
                n.flat,
                n.safe
            );
        }
    }

    #[allow(clippy::print_stderr, reason = "a trace asked for by environment variable")]
    fn stats(&self, s: &Stats) {
        if self.on {
            eprintln!(
                "organic2 tips {} nodes {} branches {} lost {}",
                s.tips, s.nodes, s.branches, s.lost
            );
        }
    }
}

/// Plans organic tree supports.
pub(crate) fn plan(inp: &Input<'_>) -> Plan {
    let mut trace = Trace::new();
    let raft_n = inp.raft_tops.len();
    let mut settings = inp.settings.clone();
    settings.raft_layers = raft_n;
    let p = params::Params::new(settings);
    let n_obj = inp.models.len();
    let total = raft_n + n_obj;
    let empty_plan = || Plan {
        layers: vec![Layer::default(); n_obj],
        raft: vec![Vec::new(); raft_n],
    };
    // Tree layers: the raft layers, then the object layers.
    let tops: Vec<f64> = inp
        .raft_tops
        .iter()
        .copied()
        .chain(inp.tops.iter().map(|t| t + inp.raft_offset))
        .collect();
    let lift = |v: &[Shapes]| -> Vec<Shapes> {
        std::iter::repeat_n(Vec::new(), raft_n)
            .chain(v.iter().cloned())
            .chain(std::iter::repeat(Vec::new()))
            .take(total)
            .collect()
    };
    let outlines = lift(inp.models);
    let blockers = lift(inp.block);
    let overhangs = {
        let obj = overhang::detect(&p, inp, &inp.detect);
        lift(&obj)
    };
    trace.stage("overhangs");
    let Some(highest) = overhangs.iter().rposition(|o| !o.is_empty()) else {
        return empty_plan();
    };
    let Some(top) = highest.checked_sub(p.z_top).filter(|&t| t > 0) else {
        return empty_plan();
    };
    let v = volumes::Volumes::new(&p, &outlines, blockers, inp.bed, top + 1);
    #[allow(clippy::cast_precision_loss, reason = "a layer count")]
    let max_r = p.radius(top as f64, 0.0) + p.recommended_min_radius(0);
    let radii: Vec<f64> = p
        .grid
        .iter()
        .copied()
        .filter(|&g| g <= max_r * 1.5 + 1e-9)
        .collect();
    v.precompute(&radii);
    trace.stage("volumes");
    let mut tips = tips::generate(&p, &v, &overhangs, top, inp.center);
    tips::drop_inside_raft(&p, &mut tips, &inp.raft_contact);
    let tip_count = tips.tips.len();
    trace.tips_by_layer(&tips.tips, &tops);
    trace.stage("tips");
    let mut nodes: Vec<Vec<node::Node>> = vec![Vec::new(); top + 1];
    for (l, n) in tips.tips {
        if let Some(layer) = nodes.get_mut(l) {
            layer.push(n);
        }
    }
    merge::descend(&p, &v, &mut nodes);
    trace.roots(&p, &nodes);
    trace.stage("growth");
    centers::choose(&p, &v, &mut nodes);
    let hs = draw::Heights { tops: &tops };
    draw::smooth(&p, &v, &hs, &mut nodes);
    trace.stage("centers");
    let branches = draw::branches(&nodes);
    let outs: Vec<assemble::BranchOut> = crate::par::map(&branches, |b| {
        draw::slice_branch(&p, &v, &hs, &nodes, b)
            .map(|s| assemble::finish_branch(&p, &v, &nodes, b, s))
            .unwrap_or_default()
    });
    trace.stage("drawing");
    let stats = Stats {
        tips: tip_count,
        nodes: nodes.iter().map(Vec::len).sum(),
        branches: branches.len(),
        lost: nodes.iter().flatten().filter(|n| n.lost || n.very_lost).count(),
    };
    let mut all = assemble::layers(&p, &v, total, outs, tips.roofs, &overhangs);
    trace.stage("layers");
    trace.stats(&stats);
    let object = all.split_off(raft_n.min(all.len()));
    let raft = all
        .into_iter()
        .map(|l| {
            ops::union_many(&[
                &l.base,
                &l.top_contact,
                &l.interface,
                &l.base_interface,
                &l.bottom_contact,
            ])
        })
        .collect();
    Plan { layers: object, raft }
}

impl Layer {
    /// The layer as the session's support layer, with the generic areas filled so travel, brim and island
    /// code reads them, and the layer itself for the organic toolpaths.
    pub(crate) fn into_support(self) -> (crate::support::SupportLayer, std::sync::Arc<Self>) {
        let interface = ops::union_many(&[
            &self.top_contact,
            &self.interface,
            &self.base_interface,
            &self.bottom_contact,
        ]);
        let sl = crate::support::SupportLayer {
            base: self.base.clone(),
            interface,
            contact: self.top_contact.clone(),
            hang: self.hang.clone(),
            bottom: self.bottom_contact.clone(),
            ..crate::support::SupportLayer::default()
        };
        (sl, std::sync::Arc::new(self))
    }
}
