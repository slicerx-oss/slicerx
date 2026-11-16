// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! how detailed a saved body is, as its text declares it: what a body sent as text between calls is limited by

/// A saved body's edges, and the control points of its spline curves and surfaces, as its text declares them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Detail {
    pub edges: u64,
    pub control_points: u64,
}

/// the kernel's type numbers of a spline surface and a spline curve, as its text names them
const SPLINE_SURFACE: &str = "15002";
const SPLINE_CURVE: &str = "14033";

/// How detailed the body `text` (as `save` writes it) is. Text that declares none of it counts nothing.
#[must_use]
pub fn detail(text: &str) -> Detail {
    let mut d = Detail::default();
    let mut lines = text.lines();
    // the kind of the curve or surface being read
    let mut kind = "";
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("Object Type ") {
            kind = rest.trim();
            // a spline surface's next line is its grid of control points, across and along
            if kind == SPLINE_SURFACE {
                let mut grid = lines
                    .next()
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(|n| n.parse::<u64>().unwrap_or(0));
                let (across, along) = (grid.next().unwrap_or(0), grid.next().unwrap_or(0));
                d.control_points = d.control_points.saturating_add(across.saturating_mul(along));
            }
        } else if let Some(n) = counted(line, "Number of Control Points") {
            if kind == SPLINE_CURVE {
                d.control_points = d.control_points.saturating_add(n);
            }
        } else if let Some(n) = counted(line, "Edges In Brep") {
            d.edges = n;
        }
    }
    d
}

/// the number a line starts with, when the rest of it is `what`
fn counted(line: &str, what: &str) -> Option<u64> {
    let (n, rest) = line.split_once(' ')?;
    (rest.trim_end() == what).then(|| n.parse().ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_edges_and_the_control_points_of_splines_only() {
        let text = "3 Composite Edges In Brep\n4 Edges In Brep\nObject Type 15002\n6 5\n3 3\nObject Type 14033\nCurve Dim 3\n\
                    7 Number of Control Points \nObject Type 14010\n2 Number of Control Points \n";
        assert_eq!(
            detail(text),
            Detail {
                edges: 4,
                control_points: 37
            }
        );
        assert_eq!(detail("not a body"), Detail::default());
    }

    #[test]
    fn counts_a_saved_body() {
        // a block with one round hole, with 16 spline curves
        assert_eq!(
            detail(include_str!("../tests/fixtures/holed-cube.smb")),
            Detail {
                edges: 15,
                control_points: 30
            }
        );
    }
}
