// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! built-in stroke font for labels and embossed text

use crate::fm::Fm;
use crate::poly2d::Polygon;
use crate::vec3::V2;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;

const GRID_H: f64 = 6.0;

struct Glyph {
    width: u8,
    strokes: &'static str,
}

const fn g(width: u8, strokes: &'static str) -> Glyph {
    Glyph { width, strokes }
}

fn glyph(c: char) -> Glyph {
    match c.to_ascii_uppercase() {
        'A' => g(4, "00 04 16 36 44 40/03 43"),
        'B' => g(4, "00 06 36 45 44 33 03/33 42 41 30 00"),
        'C' => g(4, "41 30 10 01 05 16 36 45"),
        'D' => g(4, "00 06 26 45 41 20 00"),
        'E' => g(4, "40 00 06 46/03 33"),
        'F' => g(4, "00 06 46/03 33"),
        'G' => g(4, "45 36 16 05 01 10 30 41 43 23"),
        'H' => g(4, "00 06/40 46/03 43"),
        'I' => g(2, "00 20/10 16/06 26"),
        'J' => g(4, "46 41 30 10 01 02"),
        'K' => g(4, "00 06/46 03 40"),
        'L' => g(4, "06 00 40"),
        'M' => g(4, "00 06 23 46 40"),
        'N' => g(4, "00 06 40 46"),
        'O' => g(4, "10 30 41 45 36 16 05 01 10"),
        'P' => g(4, "00 06 36 45 44 33 03"),
        'Q' => g(4, "10 30 41 45 36 16 05 01 10/22 40"),
        'R' => g(4, "00 06 36 45 44 33 03/23 40"),
        'S' => g(4, "41 30 10 01 02 13 33 44 45 36 16 05"),
        'T' => g(4, "06 46/26 20"),
        'U' => g(4, "06 01 10 30 41 46"),
        'V' => g(4, "06 20 46"),
        'W' => g(4, "06 10 23 30 46"),
        'X' => g(4, "06 40/46 00"),
        'Y' => g(4, "06 23 46/23 20"),
        'Z' => g(4, "06 46 00 40"),
        '0' => g(4, "10 30 41 45 36 16 05 01 10/11 35"),
        '1' => g(4, "15 26 20/10 30"),
        '2' => g(4, "05 16 36 45 44 00 40"),
        '3' => g(4, "05 16 36 45 44 33 23/33 42 41 30 10 01"),
        '4' => g(4, "36 03 43/36 30"),
        '5' => g(4, "46 06 03 33 42 41 30 10 01"),
        '6' => g(4, "45 36 16 05 01 10 30 41 42 33 03"),
        '7' => g(4, "06 46 20"),
        '8' => g(4, "13 33 44 45 36 16 05 04 13 02 01 10 30 41 42 33"),
        '9' => g(4, "44 33 13 04 05 16 36 45 41 30 10"),
        ' ' => g(2, ""),
        '.' => g(0, "00 00"),
        ',' => g(1, "11 00"),
        ':' => g(0, "01 01/04 04"),
        '-' => g(3, "03 33"),
        '+' => g(4, "03 43/21 25"),
        '%' => g(4, "00 46/05 06 16 15 05/31 30 40 41 31"),
        '/' => g(4, "00 46"),
        '(' => g(2, "20 01 05 26"),
        ')' => g(2, "00 21 25 06"),
        '#' => g(4, "16 10/36 30/02 42/04 44"),
        '=' => g(4, "02 42/04 44"),
        _ => g(3, "00 04 34 30 00"),
    }
}

fn strokes(gl: &Glyph) -> impl Iterator<Item = Vec<V2>> + '_ {
    gl.strokes.split('/').filter(|s| !s.is_empty()).map(|run| {
        run.split_whitespace()
            .filter_map(|tok| {
                let b = tok.as_bytes();
                let x = b.first()?.checked_sub(b'0')?;
                let y = b.get(1)?.checked_sub(b'0')?;
                Some([f64::from(x), f64::from(y)])
            })
            .collect()
    })
}

fn segment_rect(a: V2, b: V2, half: f64) -> Vec<V2> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = dx.m_hypot(dy);
    let (ux, uy) = if l > 1e-12 { (dx / l, dy / l) } else { (1.0, 0.0) };
    let (nx, ny) = (-uy, ux);
    let (ex, ey) = (ux * half, uy * half);
    let (px, py) = (nx * half, ny * half);
    vec![
        [a[0] - ex - px, a[1] - ey - py],
        [b[0] + ex - px, b[1] + ey - py],
        [b[0] + ex + px, b[1] + ey + py],
        [a[0] - ex + px, a[1] - ey + py],
    ]
}

fn build(text: &str, cap_height_mm: f64, stroke_mm: f64) -> Vec<Polygon> {
    let unit = cap_height_mm / GRID_H;
    let half = stroke_mm * 0.5;
    let gap = unit.max(stroke_mm * 1.6);
    let pitch = cap_height_mm * 1.4 + stroke_mm;
    let mut contours = Vec::new();
    for (line_no, line) in text.split('\n').enumerate() {
        let base_y = -(line_no as f64) * pitch;
        let mut x = 0.0;
        for c in line.chars() {
            let gl = glyph(c);
            for run in strokes(&gl) {
                let map = |p: V2| [x + p[0] * unit, base_y + p[1] * unit];
                if let [only] = run.as_slice() {
                    contours.push(segment_rect(map(*only), map(*only), half));
                }
                for w in run.windows(2) {
                    if let [a, b] = w {
                        contours.push(segment_rect(map(*a), map(*b), half));
                    }
                }
            }
            x += f64::from(gl.width) * unit + gap;
        }
    }
    if contours.is_empty() {
        return Vec::new();
    }
    let shapes: Vec<Vec<Vec<V2>>> = contours.simplify_shape(FillRule::NonZero);
    shapes
        .into_iter()
        .filter_map(|mut rings| {
            if rings.is_empty() {
                return None;
            }
            let outer = rings.remove(0);
            let mut p = Polygon { outer, holes: rings };
            p.normalize_orientation();
            (p.outer.len() >= 3).then_some(p)
        })
        .collect()
}

fn bounds(polys: &[Polygon]) -> Option<(V2, V2)> {
    let mut it = polys.iter().flat_map(|p| p.outer.iter()).copied();
    let first = it.next()?;
    Some(it.fold((first, first), |(lo, hi), p| {
        (
            [lo[0].min(p[0]), lo[1].min(p[1])],
            [hi[0].max(p[0]), hi[1].max(p[1])],
        )
    }))
}

pub fn text_polygons(text: &str, cap_height_mm: f64, stroke_mm: f64) -> Vec<Polygon> {
    if !(cap_height_mm.is_finite() && cap_height_mm > 0.0 && stroke_mm.is_finite() && stroke_mm > 0.0) {
        return Vec::new();
    }
    let mut polys = build(text, cap_height_mm, stroke_mm);
    if let Some((lo, hi)) = bounds(&polys) {
        let c = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])];
        for p in &mut polys {
            for v in p.outer.iter_mut().chain(p.holes.iter_mut().flatten()) {
                *v = [v[0] - c[0], v[1] - c[1]];
            }
        }
    }
    polys
}

pub fn text_size(text: &str, cap_height_mm: f64, stroke_mm: f64) -> [f64; 2] {
    let polys = text_polygons(text, cap_height_mm, stroke_mm);
    bounds(&polys).map_or([0.0, 0.0], |(lo, hi)| [hi[0] - lo[0], hi[1] - lo[1]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poly2d;

    const CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,-+%/:()#=?";

    #[test]
    fn every_glyph_parses_into_the_grid() {
        for c in CHARS.chars() {
            let gl = glyph(c);
            for run in strokes(&gl) {
                assert!(!run.is_empty(), "{c}");
                for p in run {
                    assert!(p[0] <= 4.0 && p[1] <= 6.0, "{c}");
                }
            }
        }
    }

    #[test]
    fn text_is_centered_and_oriented() {
        let polys = text_polygons("SX 42 A-1", 5.0, 0.8);
        let (lo, hi) = bounds(&polys).unwrap();
        assert!((lo[0] + hi[0]).abs() < 1e-9 && (lo[1] + hi[1]).abs() < 1e-9);
        for p in &polys {
            assert!(poly2d::signed_area(&p.outer) > 0.0);
            assert!(p.holes.iter().all(|h| poly2d::signed_area(h) < 0.0));
            assert!(poly2d::triangulate(p).is_ok());
        }
        let size = text_size("SX 42 A-1", 5.0, 0.8);
        assert!((size[0] - (hi[0] - lo[0])).abs() < 1e-6);
        assert!(size[1] > 5.8 && size[1] < 6.5, "{size:?}");
    }

    #[test]
    fn letters_with_loops_have_holes() {
        for c in ["O", "A", "B", "8", "D", "P", "R", "0", "4"] {
            let polys = text_polygons(c, 8.0, 1.2);
            let holes: usize = polys.iter().map(|p| p.holes.len()).sum();
            assert!(holes >= 1, "{c}");
        }
        assert_eq!(
            text_polygons("B", 8.0, 1.2)
                .iter()
                .map(|p| p.holes.len())
                .sum::<usize>(),
            2
        );
    }

    #[test]
    fn lowercase_matches_uppercase_and_lines_stack() {
        assert_eq!(text_polygons("abc", 6.0, 1.0), text_polygons("ABC", 6.0, 1.0));
        let one = text_size("AB", 6.0, 1.0);
        let two = text_size("AB\nAB", 6.0, 1.0);
        assert!(two[1] > one[1] * 1.9 && (two[0] - one[0]).abs() < 1e-6);
        assert!(text_polygons("", 6.0, 1.0).is_empty());
        assert!(text_polygons("   ", 6.0, 1.0).is_empty());
    }

    #[test]
    fn neighbors_stay_separate_and_unknown_is_a_box() {
        let polys = text_polygons("II", 6.0, 1.0);
        assert_eq!(polys.len(), 2);
        assert!(!text_polygons("?", 6.0, 1.0).is_empty());
    }
}
