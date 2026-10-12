// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Choosing branch centers bottom-up (spec section 6). Growing down only kept the areas a center may lie
//! in; here each root takes a point and passes it up to the nodes it carries, and branches that end in
//! the air are removed.

use super::node::Node;
use super::ops;
use super::params::Params;
use super::volumes::Volumes;

fn get(layers: &[Vec<Node>], l: usize, k: usize) -> Option<&Node> {
    layers.get(l).and_then(|v| v.get(k))
}

fn get_mut(layers: &mut [Vec<Node>], l: usize, k: usize) -> Option<&mut Node> {
    layers.get_mut(l).and_then(|v| v.get_mut(k))
}

/// Marks a node deleted and frees the nodes it carried to be placed on their own.
fn delete(layers: &mut [Vec<Node>], l: usize, k: usize) {
    let parents = match get_mut(layers, l, k) {
        Some(n) => {
            n.deleted = true;
            n.parents.clone()
        }
        None => return,
    };
    for q in parents {
        if let Some(par) = get_mut(layers, l + 1, q) {
            par.center = None;
            par.reached = false;
            par.child = None;
        }
    }
}

/// A flat-resting root: the highest layer of its single-parent chain (from layer `l` up) whose area
/// meets the placeable area, if any.
fn flat_root(
    p: &Params,
    v: &Volumes<'_>,
    layers: &[Vec<Node>],
    l: usize,
    k: usize,
) -> Option<(usize, usize)> {
    let meets = |l: usize, n: &Node| {
        let r = p.collision_radius(n.e, n.f);
        !ops::inter(&n.area, &v.placeable(r, l)).is_empty()
    };
    let mut best = None;
    let (mut cl, mut ck) = (l, k);
    while let Some(n) = get(layers, cl, ck) {
        if !meets(cl, n) {
            break;
        }
        best = Some((cl, ck));
        match n.parents.as_slice() {
            [only] => {
                cl += 1;
                ck = *only;
            }
            _ => break,
        }
    }
    best
}

/// Picks every center and removes the nodes that hold nothing up.
pub(crate) fn choose(p: &Params, v: &Volumes<'_>, layers: &mut [Vec<Node>]) {
    for layer in layers.iter_mut() {
        for n in layer.iter_mut() {
            n.center = None;
            n.reached = false;
        }
    }
    let k_model = u32::try_from(p.model_min_layers).unwrap_or(u32::MAX);
    for l in 0..layers.len() {
        let count = layers.get(l).map_or(0, Vec::len);
        for k in 0..count {
            let Some(n) = get(layers, l, k) else { continue };
            if n.deleted {
                continue;
            }
            if !n.reached {
                if l == 0 {
                    if let Some(n) = get_mut(layers, l, k) {
                        n.center = Some(ops::move_inside(&n.area, n.hint));
                        n.reached = true;
                    }
                } else if n.d == 0 || n.to_bed || (n.d < k_model && !n.supports_roof) {
                    // A lone tip, a bed branch that lost its way, or a model branch too short to stand.
                    delete(layers, l, k);
                    continue;
                } else if n.flat {
                    match flat_root(p, v, layers, l, k) {
                        Some((rl, rk)) => {
                            // Start the branch at the highest placeable layer; drop the nodes below it.
                            let (mut cl, mut ck) = (l, k);
                            while cl < rl {
                                let next = get(layers, cl, ck).and_then(|n| n.parents.first().copied());
                                if let Some(n) = get_mut(layers, cl, ck) {
                                    n.deleted = true;
                                }
                                match next {
                                    Some(q) => {
                                        cl += 1;
                                        ck = q;
                                    }
                                    None => break,
                                }
                            }
                            if let Some(n) = get_mut(layers, rl, rk) {
                                n.center = Some(ops::move_inside(&n.area, n.hint));
                                n.reached = true;
                                n.child = None;
                            }
                            if rl != l {
                                continue;
                            }
                        }
                        None => {
                            if let Some(n) = get_mut(layers, l, k) {
                                n.flat = false;
                                n.center = Some(ops::move_inside(&n.area, n.hint));
                                n.reached = true;
                            }
                        }
                    }
                } else if let Some(n) = get_mut(layers, l, k) {
                    n.center = Some(ops::move_inside(&n.area, n.hint));
                    n.reached = true;
                }
            }
            // Pass the center up.
            let (center, parents) = match get(layers, l, k) {
                Some(n) if !n.deleted => (n.center, n.parents.clone()),
                _ => continue,
            };
            let Some(c) = center else { continue };
            for q in parents {
                if let Some(par) = get_mut(layers, l + 1, q) {
                    if !par.deleted && !par.reached {
                        par.center = Some(ops::move_inside(&par.area, c));
                        par.reached = true;
                        par.child = Some(k);
                    }
                }
            }
        }
    }
    compact(layers);
}

/// Removes deleted nodes and renumbers the links.
fn compact(layers: &mut [Vec<Node>]) {
    let maps: Vec<Vec<Option<usize>>> = layers
        .iter()
        .map(|layer| {
            let mut next = 0;
            layer
                .iter()
                .map(|n| {
                    if n.deleted {
                        None
                    } else {
                        next += 1;
                        Some(next - 1)
                    }
                })
                .collect()
        })
        .collect();
    let remap = |map: Option<&Vec<Option<usize>>>, k: usize| map.and_then(|m| m.get(k).copied().flatten());
    for (l, layer) in layers.iter_mut().enumerate() {
        layer.retain(|n| !n.deleted);
        let above = maps.get(l + 1);
        let below = l.checked_sub(1).and_then(|b| maps.get(b));
        for n in layer.iter_mut() {
            n.parents = n.parents.iter().filter_map(|&q| remap(above, q)).collect();
            n.child = n.child.and_then(|c| remap(below, c));
        }
    }
    // A node whose child went away is a root; parents whose child is gone lose the link too.
    for l in 0..layers.len() {
        let Some((lower, upper)) = split_pair(layers, l) else {
            continue;
        };
        for (k, n) in lower.iter().enumerate() {
            for &q in &n.parents {
                if let Some(par) = upper.get_mut(q) {
                    par.child = Some(k);
                }
            }
        }
    }
}

/// Layer `l` and the one above it, borrowed together.
fn split_pair(layers: &mut [Vec<Node>], l: usize) -> Option<(&Vec<Node>, &mut Vec<Node>)> {
    let (lo, hi) = layers.split_at_mut_checked(l + 1)?;
    Some((lo.last()?, hi.first_mut()?))
}
