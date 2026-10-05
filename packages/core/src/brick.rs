// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Brick layers (`brick_layers`): the inner walls are printed half a layer higher than the outer wall, so
//! the joints between their layers fall in the middle of the outer wall's layers, like courses of
//! bricks. The first shifted layer lays a bead one and a half layers tall to fill the gap under it
//! (extra flow), and the first layer after the run lays half a bead, because the shifted wall already
//! filled the lower half of its height. The top shell layers stay as they are, so the visible top is
//! printed on a level surface.
//!
//! Orca has no such feature (it asks for one in `OrcaSlicer` issue 7282; the technique is the
//! `BrickLayers` post-processor). The layer plan here is our own.

use crate::config::PrintConfig;
use crate::output::{Feature, LayerPaths};

/// How a layer takes part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    /// Inner walls half a layer up, at full flow.
    Shifted,
    /// The first shifted layer: a bead one and a half layers tall.
    First,
    /// The layer after the run: half a bead on top of the shifted one below.
    Settle,
}

/// The role of `layer` of `count`, or None.
pub(crate) fn role(cfg: &PrintConfig, layer: u32, count: u32, top_layers: u32) -> Option<Role> {
    if !crate::firmware::truthy(cfg, "brick_layers") || cfg.wall_loops < 2 || crate::spiral::enabled(cfg) {
        return None;
    }
    let first = 1;
    let last = count.checked_sub(2 + top_layers)?;
    if last < first {
        return None;
    }
    if layer == first {
        Some(Role::First)
    } else if layer > first && layer <= last {
        Some(Role::Shifted)
    } else if layer == last + 1 {
        Some(Role::Settle)
    } else {
        None
    }
}

/// Lifts the inner walls of a planned layer and sets their flow. A layer with a top surface keeps its walls.
pub(crate) fn apply(out: &mut LayerPaths, role: Role) {
    if out.paths.iter().any(|p| p.feature == Feature::TopSurface) {
        return;
    }
    let half = out.height / 2.0;
    for p in &mut out.paths {
        if p.feature != Feature::InnerWall {
            continue;
        }
        match role {
            Role::Shifted => p.dz = half,
            Role::First => {
                p.dz = half;
                p.flow *= 1.5;
            }
            Role::Settle => p.flow *= 0.5,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PrintConfig {
        let mut c = PrintConfig::default();
        c.raw.insert("brick_layers".into(), serde_json::json!(true));
        c.wall_loops = 3;
        c
    }

    #[test]
    fn the_run_starts_on_layer_one_and_leaves_the_top_shell_alone() {
        let c = cfg();
        let roles: Vec<Option<Role>> = (0..30).map(|l| role(&c, l, 30, 5)).collect();
        assert_eq!(roles[0], None);
        assert_eq!(roles[1], Some(Role::First));
        assert_eq!(roles[2], Some(Role::Shifted));
        assert_eq!(roles[23], Some(Role::Shifted));
        assert_eq!(roles[24], Some(Role::Settle));
        assert!(roles[25..].iter().all(Option::is_none));
    }

    #[test]
    fn one_wall_prints_are_left_alone() {
        let mut c = cfg();
        c.wall_loops = 1;
        assert_eq!(role(&c, 3, 30, 5), None);
    }
}
