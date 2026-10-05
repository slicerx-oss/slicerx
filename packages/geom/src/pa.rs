// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! pressure advance calibration as tool paths
// point tables index fixed-size arrays
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::too_many_lines,
    clippy::needless_range_loop
)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::vec3::V2;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMove {
    pub kind: &'static str,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_mm_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_width_mm: Option<f64>,
    /// extrusion multiplier for this move only (1 when absent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure_advance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceleration_mm_s2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLayer {
    pub z_mm: f64,
    pub layer_height_mm: f64,
    pub moves: Vec<PlanMove>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLabel {
    pub text: String,
    pub x: f64,
    pub y: f64,
    /// `pressureAdvance`, `flow` (mm^3/s) or `acceleration`
    pub meaning: &'static str,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPlan {
    pub layers: Vec<PlanLayer>,
    pub min: V2,
    pub max: V2,
    pub labels: Vec<PlanLabel>,
    pub values: Vec<f64>,
    pub suggested_settings: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaCommon {
    pub nozzle_diameter_mm: f64,
    pub layer_height_mm: f64,
    pub bed_width_mm: f64,
    pub bed_depth_mm: f64,
    pub bed_origin_mm: V2,
    pub draw_numbers: bool,
}

impl Default for PaCommon {
    fn default() -> Self {
        Self {
            nozzle_diameter_mm: 0.4,
            layer_height_mm: 0.2,
            bed_width_mm: 256.0,
            bed_depth_mm: 256.0,
            bed_origin_mm: [0.0, 0.0],
            draw_numbers: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaLineParams {
    #[serde(flatten)]
    pub common: PaCommon,
    pub start: f64,
    pub step: f64,
    pub count: usize,
    pub slow_speed_mm_s: f64,
    pub fast_speed_mm_s: f64,
}

impl Default for PaLineParams {
    fn default() -> Self {
        Self {
            common: PaCommon::default(),
            start: 0.0,
            step: 0.002,
            count: 50,
            slow_speed_mm_s: 20.0,
            fast_speed_mm_s: 100.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaPatternParams {
    #[serde(flatten)]
    pub common: PaCommon,
    pub start: f64,
    pub end: f64,
    pub step: f64,
    pub wall_count: usize,
    pub first_layer_height_mm: f64,
    pub first_layer_speed_mm_s: f64,
    pub outer_wall_speed_mm_s: f64,
    pub outer_wall_acceleration_mm_s2: f64,
    pub flow_ratio: f64,
}

impl Default for PaPatternParams {
    fn default() -> Self {
        Self {
            common: PaCommon::default(),
            start: 0.0,
            end: 0.08,
            step: 0.005,
            wall_count: 3,
            first_layer_height_mm: 0.2,
            first_layer_speed_mm_s: 30.0,
            outer_wall_speed_mm_s: 60.0,
            outer_wall_acceleration_mm_s2: 500.0,
            flow_ratio: 1.0,
        }
    }
}

const DIGIT_SEGMENT: f64 = 2.0;
const DIGIT_GAP: f64 = 1.0;
const MAX_NUMBER_LEN: usize = 5;

pub fn mm3_per_mm(width: f64, height: f64) -> f64 {
    (width - height * (1.0 - PI / 4.0)) * height
}

/// `%g`-style text with `sig` significant digits (6 when 0), like a C++ stream with `setprecision`
fn number_text(v: f64, sig: usize) -> String {
    let sig = if sig == 0 { 6 } else { sig };
    if v == 0.0 {
        return "0".to_owned();
    }
    let exp = v.abs().m_log10().floor() as i32;
    let decimals = (sig as i32 - 1 - exp).max(0) as usize;
    let mut s = format!("{v:.decimals$}");
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    s
}

struct Pen {
    moves: Vec<PlanMove>,
    pos: V2,
    speed: Option<f64>,
    width: Option<f64>,
    pa: Option<f64>,
    accel: Option<f64>,
    min: V2,
    max: V2,
}

impl Pen {
    fn new() -> Self {
        Self {
            moves: Vec::new(),
            pos: [f64::NAN; 2],
            speed: None,
            width: None,
            pa: None,
            accel: None,
            min: [f64::INFINITY; 2],
            max: [f64::NEG_INFINITY; 2],
        }
    }

    fn push(&mut self, kind: &'static str, to: V2, scale: Option<f64>, comment: &str) {
        self.moves.push(PlanMove {
            kind,
            x: to[0],
            y: to[1],
            speed_mm_s: self.speed.take(),
            line_width_mm: self.width.take(),
            flow_scale: scale,
            pressure_advance: self.pa.take(),
            acceleration_mm_s2: self.accel.take(),
            comment: (!comment.is_empty()).then(|| comment.to_owned()),
        });
        if kind == "extrude" {
            for p in [self.pos, to] {
                if p[0].is_finite() {
                    self.min = [self.min[0].min(p[0]), self.min[1].min(p[1])];
                    self.max = [self.max[0].max(p[0]), self.max[1].max(p[1])];
                }
            }
        }
        self.pos = to;
    }

    fn travel(&mut self, to: V2, comment: &str) {
        self.push("travel", to, None, comment);
    }

    fn extrude(&mut self, to: V2, comment: &str) {
        self.push("extrude", to, None, comment);
    }

    fn extrude_scaled(&mut self, to: V2, scale: f64, comment: &str) {
        self.push("extrude", to, Some(scale), comment);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Digits {
    LeftToRight,
    BottomToTop,
}

fn glyph(c: char, at: V2, mode: Digits, width: f64) -> Vec<Vec<V2>> {
    let (len, gap) = (DIGIT_SEGMENT, width / 2.0);
    let (x, y) = (at[0], at[1]);
    let (p0, p05, p1, p2, p3, p4, p45, p5, gap03, gap23, dot) = match mode {
        Digits::BottomToTop => (
            [x, y],
            [x, y + len / 2.0],
            [x, y + len],
            [x + len, y + len],
            [x + len, y],
            [x + 2.0 * len, y],
            [x + 2.0 * len, y + len / 2.0],
            [x + 2.0 * len, y + len],
            [x + gap, y],
            [x + len, y + len + gap],
            [-len / 2.0, 0.0],
        ),
        Digits::LeftToRight => (
            [x, y],
            [x + len / 2.0, y],
            [x + len, y],
            [x + len, y - len],
            [x, y - len],
            [x, y - 2.0 * len],
            [x + len / 2.0, y - 2.0 * len],
            [x + len, y - 2.0 * len],
            [x, y - gap],
            [x + len - gap, y - len],
            [0.0, len / 2.0],
        ),
    };
    match c {
        '0' => vec![vec![p0, p1, p5, p4, gap03]],
        '1' => vec![vec![p05, p45]],
        '2' => vec![vec![p0, p1, p2, p3, p4, p5]],
        '3' => vec![vec![p0, p1, p5, p4], vec![gap23, p3]],
        '4' => vec![vec![p0, p3, p2], vec![p1, p5]],
        '5' => vec![vec![p1, p0, p3, p2, p5, p4]],
        '6' => vec![vec![p1, p0, p4, p5, p2, p3]],
        '7' => vec![vec![p0, p1, p5]],
        '8' => vec![vec![p2, p3, p4, p5, p1, p0, p3]],
        '9' => vec![vec![p5, p1, p0, p3, p2]],
        '.' => vec![vec![p45, [p45[0] + dot[0], p45[1] + dot[1]]]],
        _ => Vec::new(),
    }
}

fn draw_text(pen: &mut Pen, start: V2, text: &str, mode: Digits, width: f64, speed: f64, max_len: usize) {
    pen.speed = Some(speed);
    pen.width = Some(width);
    let spacing = DIGIT_SEGMENT + DIGIT_GAP;
    for (i, c) in text.chars().take(max_len).enumerate() {
        let at = match mode {
            Digits::BottomToTop => [start[0], start[1] + i as f64 * spacing],
            Digits::LeftToRight => [start[0] + i as f64 * spacing, start[1]],
        };
        for run in glyph(c, at, mode, width) {
            for (k, p) in run.iter().enumerate() {
                if k == 0 {
                    pen.travel(*p, "");
                } else {
                    pen.extrude(*p, "");
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments, reason = "mirrors Orca's draw_box arguments")]
fn draw_box(
    pen: &mut Pen,
    min: V2,
    size: V2,
    perimeters: usize,
    height: f64,
    width: f64,
    speed: f64,
    filled: bool,
) {
    let spacing = width - height * (1.0 - PI / 4.0);
    let fit = |s: f64| ((s * (PI / 4.0).m_sin()).floor() / (spacing / (PI / 4.0).m_sin())) as usize;
    let perimeters = perimeters.min(fit(size[0])).min(fit(size[1])).max(1);
    pen.width = Some(width);
    pen.speed = Some(speed);
    pen.travel(min, "Move to box start");
    let (mut x, mut y) = (min[0], min[1]);
    for i in 0..perimeters {
        if i != 0 {
            x += spacing;
            y += spacing;
            pen.travel([x, y], "Step inwards");
        }
        let (w, h) = (
            size[0] - i as f64 * spacing * 2.0,
            size[1] - i as f64 * spacing * 2.0,
        );
        y += h;
        pen.extrude([x, y], "Perimeter up");
        x += w;
        pen.extrude([x, y], "Perimeter right");
        y -= h;
        pen.extrude([x, y], "Perimeter down");
        x -= w;
        pen.extrude([x, y], "Perimeter left");
    }
    if !filled {
        return;
    }
    let inset = spacing * (perimeters as f64 - 1.0) + width * (1.0 - 1.0 / 3.0);
    let (x0, x1) = (min[0] + inset, min[0] + size[0] - inset);
    let (y0, y1) = (min[1] + inset, min[1] + size[1] - inset);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let mut yy = y0;
    let mut left_to_right = true;
    pen.travel([x0, y0], "Move to fill start");
    while yy <= y1 + 1e-9 {
        let (a, b) = if left_to_right { (x0, x1) } else { (x1, x0) };
        pen.travel([a, yy], "");
        pen.extrude([b, yy], "Fill");
        left_to_right = !left_to_right;
        yy += spacing;
    }
}

fn check_common(c: &PaCommon) -> Result<()> {
    for (what, v) in [
        ("nozzleDiameterMm", c.nozzle_diameter_mm),
        ("layerHeightMm", c.layer_height_mm),
        ("bedWidthMm", c.bed_width_mm),
        ("bedDepthMm", c.bed_depth_mm),
    ] {
        if !(v.is_finite() && v > 0.0) {
            return Err(Error::invalid(what, "must be above 0"));
        }
    }
    Ok(())
}

fn finish(
    pens: Vec<(Pen, f64, f64)>,
    labels: Vec<PlanLabel>,
    values: Vec<f64>,
    suggested_settings: serde_json::Value,
) -> PathPlan {
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    let layers = pens
        .into_iter()
        .map(|(pen, z, h)| {
            for k in 0..2 {
                lo[k] = lo[k].min(pen.min[k]);
                hi[k] = hi[k].max(pen.max[k]);
            }
            PlanLayer {
                z_mm: z,
                layer_height_mm: h,
                moves: pen.moves,
            }
        })
        .collect();
    PathPlan {
        layers,
        min: lo,
        max: hi,
        labels,
        values,
        suggested_settings,
    }
}

pub fn pa_line(p: &PaLineParams) -> Result<PathPlan> {
    check_common(&p.common)?;
    let c = &p.common;
    for (what, v) in [
        ("slowSpeedMmS", p.slow_speed_mm_s),
        ("fastSpeedMmS", p.fast_speed_mm_s),
    ] {
        if !(v.is_finite() && v > 0.0) {
            return Err(Error::invalid(what, "must be above 0"));
        }
    }
    if !(p.start.is_finite() && p.start >= 0.0 && p.step.is_finite() && p.step > 0.0) {
        return Err(Error::invalid(
            "step",
            "start must not be negative and step must be above 0",
        ));
    }
    let space_y = 3.5;
    let (w, h) = (c.bed_width_mm, c.bed_depth_mm);
    let count = p.count.min(((h - 10.0) / space_y).floor().max(0.0) as usize);
    if count == 0 {
        return Err(Error::invalid("bedDepthMm", "the bed is too short for one line"));
    }
    let n = c.nozzle_diameter_mm;
    let line_width = if n < 0.51 { n * 1.5 } else { n * 1.05 };
    let number_width = n;
    let (short, long) = (20.0, 40.0 + (w - 120.0).min(0.0));
    let start_x = c.bed_origin_mm[0] + (w - short * 2.0 - long - 20.0) / 2.0;
    let start_y = c.bed_origin_mm[1] + (h - count as f64 * space_y) / 2.0;
    let height = c.layer_height_mm;
    let (slow, fast) = (p.slow_speed_mm_s, p.fast_speed_mm_s);
    let values: Vec<f64> = (0..count).map(|i| p.start + i as f64 * p.step).collect();

    let mut pen = Pen::new();
    let num = count as f64;
    pen.pa = Some(0.0);
    pen.travel([start_x, start_y + num * space_y], "Prime line start");
    pen.speed = Some(slow);
    pen.width = Some(line_width);
    pen.extrude_scaled([start_x, start_y], 1.2, "Prime line");
    for (i, v) in values.iter().enumerate() {
        let y = start_y + i as f64 * space_y;
        pen.pa = Some(*v);
        pen.travel([start_x, y], "");
        pen.speed = Some(slow);
        pen.extrude([start_x + short, y], "Slow");
        pen.speed = Some(fast);
        pen.extrude([start_x + short + long, y], "Fast");
        pen.speed = Some(slow);
        pen.extrude([start_x + short + long + short, y], "Slow");
        if i == 0 {
            pen.pa = Some(0.0);
            pen.extrude_scaled(
                [start_x + short + long + short, start_y + num * space_y],
                1.2,
                "Anchor line",
            );
        }
    }
    pen.pa = Some(0.0);
    let mut layers = vec![(pen, height, height)];
    let mut labels = Vec::new();
    if c.draw_numbers {
        let box_x = start_x + short + long + short + line_width;
        let spacing = DIGIT_SEGMENT + DIGIT_GAP;
        let mut pen = Pen::new();
        draw_box(
            &mut layers[0].0,
            [box_x, start_y - space_y],
            [spacing * 8.0, (num + 1.0) * space_y],
            2,
            height,
            line_width,
            fast,
            true,
        );
        for i in (0..count).step_by(2) {
            let text = number_text(values[i], MAX_NUMBER_LEN - 1);
            let at = [
                box_x + 3.0 + line_width,
                start_y + i as f64 * space_y + space_y / 2.0,
            ];
            draw_text(
                &mut pen,
                at,
                &text,
                Digits::LeftToRight,
                number_width,
                60.0,
                MAX_NUMBER_LEN,
            );
            labels.push(PlanLabel {
                text,
                x: at[0],
                y: at[1],
                meaning: "pressureAdvance",
                value: values[i],
            });
        }
        layers.push((pen, height * 2.0, height));
    }
    Ok(finish(
        layers,
        labels,
        values,
        serde_json::json!({ "line_width": line_width, "initial_layer_print_height": height }),
    ))
}

pub fn pa_pattern(p: &PaPatternParams) -> Result<PathPlan> {
    check_common(&p.common)?;
    let c = &p.common;
    for (what, v) in [
        ("firstLayerHeightMm", p.first_layer_height_mm),
        ("firstLayerSpeedMmS", p.first_layer_speed_mm_s),
        ("outerWallSpeedMmS", p.outer_wall_speed_mm_s),
        ("outerWallAccelerationMmS2", p.outer_wall_acceleration_mm_s2),
        ("flowRatio", p.flow_ratio),
    ] {
        if !(v.is_finite() && v > 0.0) {
            return Err(Error::invalid(what, "must be above 0"));
        }
    }
    let valid = p.start.is_finite()
        && p.start >= 0.0
        && p.end.is_finite()
        && p.end > p.start
        && p.step.is_finite()
        && p.step > 0.0
        && (1..=8).contains(&p.wall_count);
    if !valid {
        return Err(Error::invalid(
            "end",
            "needs 0 <= start < end, a positive step and 1 to 8 walls",
        ));
    }
    let num_patterns = ((p.end - p.start) / p.step + 1.0).ceil() as usize;
    if num_patterns > 50 {
        return Err(Error::invalid("step", "more than 50 patterns"));
    }
    let n = c.nozzle_diameter_mm;
    let (line_w, first_w) = (n * 1.125, n * 1.4);
    let (h, h1) = (c.layer_height_mm, p.first_layer_height_mm);
    let walls = p.wall_count;
    let (side, angle, pattern_spacing, padding_h, padding_v, layers_n) =
        (30.0, 90.0_f64.to_radians(), 2.0, 1.0, 1.0, 4usize);
    let spacing = |w: f64, hh: f64| w - hh * (1.0 - PI / 4.0);
    let (line_spacing, line_spacing_first) = (spacing(line_w, h), spacing(first_w, h1));
    let line_spacing_angle = line_spacing / (angle / 2.0).m_sin();
    let values: Vec<f64> = (0..num_patterns).map(|j| p.start + j as f64 * p.step).collect();

    let text_of = |v: f64| number_text(v, 0);
    let number_len = values
        .iter()
        .step_by(2)
        .map(|v| text_of(*v).len())
        .chain(std::iter::once(text_of(p.outer_wall_acceleration_mm_s2).len()))
        .max()
        .unwrap_or(1)
        .min(MAX_NUMBER_LEN);
    let numbering_height = number_len as f64 * DIGIT_SEGMENT + (number_len as f64 - 1.0) * DIGIT_GAP;
    let pattern_shift = (walls as f64 - 1.0) * line_spacing_first + first_w + padding_h;
    let object_x = num_patterns as f64 * ((walls as f64 - 1.0) * line_spacing_angle)
        + (num_patterns as f64 - 1.0) * (pattern_spacing + line_w)
        + (angle / 2.0).m_cos() * side
        + line_spacing_first * walls as f64;
    let print_size_x = object_x + pattern_shift;
    let frame_y = (angle / 2.0).m_sin() * side * 2.0;
    let object_y = frame_y + numbering_height + padding_v * 2.0 + first_w;
    let start = [
        c.bed_origin_mm[0] + (c.bed_width_mm - print_size_x) / 2.0,
        c.bed_origin_mm[1] + (c.bed_depth_mm - object_y) / 2.0,
    ];
    if print_size_x > c.bed_width_mm || object_y > c.bed_depth_mm {
        return Err(Error::invalid("step", "the pattern does not fit on the bed"));
    }
    let glyph_length_x = line_w + 2.0 * DIGIT_SEGMENT;
    let glyph_start_x = |i: usize| {
        start[0]
            + pattern_shift
            + i as f64 * (walls as f64 - 1.0) * line_spacing_angle
            + i as f64 * line_w
            + i as f64 * pattern_spacing
            + walls as f64 * line_spacing_angle / 2.0
            - glyph_length_x / 2.0
    };
    let speed1 = p.first_layer_speed_mm_s;
    let speed = p.outer_wall_speed_mm_s;
    let flow_number = speed * mm3_per_mm(line_w, h) * p.flow_ratio;
    let tab_y = start[1] + frame_y + line_spacing_first;

    let mut out: Vec<(Pen, f64, f64)> = Vec::new();
    let mut labels = Vec::new();
    for i in 0..layers_n {
        let z = h1 + i as f64 * h;
        let mut pen = Pen::new();
        pen.accel = Some(p.outer_wall_acceleration_mm_s2);
        if i == 0 {
            pen.pa = Some(p.start);
            draw_box(
                &mut pen,
                start,
                [print_size_x, frame_y],
                walls,
                h1,
                first_w,
                speed1,
                false,
            );
            draw_box(
                &mut pen,
                [start[0], tab_y],
                [
                    print_size_x,
                    numbering_height + line_spacing_first + padding_v * 2.0,
                ],
                walls,
                h1,
                first_w,
                speed1,
                true,
            );
        }
        if i == 1 {
            pen.pa = Some(p.start);
            let y = start[1] + frame_y + padding_v + line_w;
            for j in (0..num_patterns).step_by(2) {
                let text = number_text(values[j], number_len.saturating_sub(1).max(1));
                let at = [glyph_start_x(j), y];
                draw_text(
                    &mut pen,
                    at,
                    &text,
                    Digits::BottomToTop,
                    line_w,
                    speed1,
                    number_len,
                );
                labels.push(PlanLabel {
                    text,
                    x: at[0],
                    y: at[1],
                    meaning: "pressureAdvance",
                    value: values[j],
                });
            }
            for (idx, meaning, value) in [
                (num_patterns + 2, "flow", flow_number),
                (num_patterns + 4, "acceleration", p.outer_wall_acceleration_mm_s2),
            ] {
                let text = number_text(value, number_len.saturating_sub(1).max(1));
                let at = [glyph_start_x(idx), y];
                draw_text(
                    &mut pen,
                    at,
                    &text,
                    Digits::BottomToTop,
                    line_w,
                    speed1,
                    number_len,
                );
                labels.push(PlanLabel {
                    text,
                    x: at[0],
                    y: at[1],
                    meaning,
                    value,
                });
            }
        }
        let (mut to_x, mut to_y) = (start[0] + pattern_shift, start[1]);
        let mut side_length = side;
        if i == 0 {
            let shrink = (line_spacing_first * (walls as f64 - 1.0) + first_w * (1.0 - 1.0 / 3.0))
                / (angle / 2.0).m_sin();
            side_length = side - shrink;
            to_x += shrink * (90.0_f64.to_radians() - angle / 2.0).m_sin();
            to_y += line_spacing_first * (walls as f64 - 1.0) + first_w * (1.0 - 1.0 / 3.0);
        } else {
            pen.travel(start, "Move to starting point");
            pen.speed = Some((speed - 1.0).max(1.0));
            pen.width = Some(line_w);
            pen.extrude([start[0], start[1] + frame_y], "Accel and flow trick line");
        }
        let (initial_x, initial_y) = (to_x, to_y);
        pen.travel([to_x, to_y], "Move to pattern start");
        let (line_width_i, speed_i) = (line_w, if i == 0 { speed1 } else { speed });
        for (j, value) in values.iter().enumerate() {
            pen.pa = Some(*value);
            for k in 0..walls {
                to_x += (angle / 2.0).m_cos() * side_length;
                to_y += (angle / 2.0).m_sin() * side_length;
                pen.width = Some(line_width_i);
                pen.speed = Some(speed_i);
                pen.extrude([to_x, to_y], "Print pattern wall");
                to_x -= (angle / 2.0).m_cos() * side_length;
                to_y += (angle / 2.0).m_sin() * side_length;
                pen.extrude([to_x, to_y], "Print pattern wall");
                to_y = initial_y;
                if k != walls - 1 {
                    to_x += line_spacing_angle;
                    pen.travel([to_x, to_y], "Move to next pattern wall");
                } else if j != num_patterns - 1 {
                    to_x += pattern_spacing + line_w;
                    pen.travel([to_x, to_y], "Move to next pattern");
                } else if i != layers_n - 1 {
                    to_x = initial_x;
                    pen.travel([to_x, to_y], "Move back to start");
                }
            }
        }
        out.push((pen, z, if i == 0 { h1 } else { h }));
    }
    Ok(finish(
        out,
        labels,
        values,
        serde_json::json!({
            "initial_layer_speed": 30,
            "line_width": "112.5%",
            "initial_layer_line_width": "140%",
            "skirt_loops": 0,
            "wall_loops": 3,
            "brim_type": "no_brim",
        }),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Flavor {
    Klipper,
    Marlin,
    RepRapFirmware,
    Repetier,
    Bambu,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GcodeOptions {
    pub flavor: Flavor,
    pub filament_diameter_mm: f64,
    pub flow_ratio: f64,
    pub retraction_mm: f64,
    pub retraction_speed_mm_s: f64,
    pub travel_speed_mm_s: f64,
}

impl Default for GcodeOptions {
    fn default() -> Self {
        Self {
            flavor: Flavor::Klipper,
            filament_diameter_mm: 1.75,
            flow_ratio: 1.0,
            retraction_mm: 0.8,
            retraction_speed_mm_s: 30.0,
            travel_speed_mm_s: 150.0,
        }
    }
}

pub fn pa_command(flavor: Flavor, pa: f64) -> String {
    match flavor {
        Flavor::Klipper => format!("SET_PRESSURE_ADVANCE ADVANCE={pa:.4}"),
        Flavor::RepRapFirmware => format!("M572 D0 S{pa:.4}"),
        Flavor::Repetier => format!("M233 X{pa:.4} Y{pa:.4}"),
        Flavor::Bambu => format!("M900 K{pa:.4} L1000 M10"),
        Flavor::Marlin => format!("M900 K{pa:.4}"),
    }
}

fn accel_command(flavor: Flavor, a: f64) -> String {
    match flavor {
        Flavor::Klipper => format!("SET_VELOCITY_LIMIT ACCEL={a:.0}"),
        _ => format!("M204 S{a:.0}"),
    }
}

pub fn render_gcode(plan: &PathPlan, o: &GcodeOptions) -> Result<String> {
    if !(o.filament_diameter_mm.is_finite() && o.filament_diameter_mm > 0.0 && o.flow_ratio > 0.0) {
        return Err(Error::invalid("filamentDiameterMm", "must be above 0"));
    }
    let area = PI * (o.filament_diameter_mm / 2.0).m_powi(2);
    let mut g = String::from("; pressure advance test from sx-geom\nM83 ; relative extrusion\n");
    let (mut pos, mut width, mut speed) = ([f64::NAN; 2], 0.4, 0.0_f64);
    let mut last_f: Option<f64> = None;
    for layer in &plan.layers {
        let _ = writeln!(g, "G1 Z{:.3} F600 ; layer at {:.3}", layer.z_mm, layer.z_mm);
        for m in &layer.moves {
            if let Some(v) = m.pressure_advance {
                let _ = writeln!(g, "{}", pa_command(o.flavor, v));
            }
            if let Some(a) = m.acceleration_mm_s2 {
                let _ = writeln!(g, "{}", accel_command(o.flavor, a));
            }
            if let Some(w) = m.line_width_mm {
                width = w;
            }
            if let Some(s) = m.speed_mm_s {
                speed = s;
            }
            let c = m
                .comment
                .as_deref()
                .map_or_else(String::new, |c| format!(" ; {c}"));
            let to = [m.x, m.y];
            let len = if pos[0].is_finite() {
                (to[0] - pos[0]).m_hypot(to[1] - pos[1])
            } else {
                0.0
            };
            if m.kind == "extrude" {
                let e = len
                    * mm3_per_mm(width, layer.layer_height_mm)
                    * o.flow_ratio
                    * m.flow_scale.unwrap_or(1.0)
                    / area;
                let f = speed * 60.0;
                let f_text = if last_f == Some(f) {
                    String::new()
                } else {
                    format!(" F{f:.0}")
                };
                last_f = Some(f);
                let _ = writeln!(g, "G1 X{:.3} Y{:.3} E{e:.5}{f_text}{c}", to[0], to[1]);
            } else {
                let far = len > 1.5 || !pos[0].is_finite();
                if far && o.retraction_mm > 0.0 {
                    let _ = writeln!(
                        g,
                        "G1 E-{:.2} F{:.0}",
                        o.retraction_mm,
                        o.retraction_speed_mm_s * 60.0
                    );
                }
                let f = o.travel_speed_mm_s * 60.0;
                last_f = Some(f);
                let _ = writeln!(g, "G0 X{:.3} Y{:.3} F{f:.0}{c}", to[0], to[1]);
                if far && o.retraction_mm > 0.0 {
                    let _ = writeln!(
                        g,
                        "G1 E{:.2} F{:.0}",
                        o.retraction_mm,
                        o.retraction_speed_mm_s * 60.0
                    );
                    last_f = Some(o.retraction_speed_mm_s * 60.0);
                }
            }
            pos = to;
        }
    }
    let _ = writeln!(g, "{}", pa_command(o.flavor, 0.0));
    Ok(g)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;

    fn moves(plan: &PathPlan, layer: usize) -> &[PlanMove] {
        &plan.layers[layer].moves
    }

    #[test]
    fn number_text_matches_a_cpp_stream() {
        assert_eq!(number_text(0.002, 4), "0.002");
        assert_eq!(number_text(0.05, 4), "0.05");
        assert_eq!(number_text(0.0, 4), "0");
        assert_eq!(number_text(0.098, 4), "0.098");
        assert_eq!(number_text(1234.5, 6), "1234.5");
        assert_eq!(number_text(500.0, 0), "500");
    }

    #[test]
    fn line_test_has_a_line_per_value_with_slow_fast_slow_runs() {
        let p = PaLineParams::default();
        let plan = pa_line(&p).unwrap();
        assert_eq!(plan.values.len(), 50);
        assert!((plan.values[49] - 0.098).abs() < 1e-12);
        assert_eq!(plan.layers.len(), 2);
        let first = moves(&plan, 0);
        let set: Vec<f64> = first.iter().filter_map(|m| m.pressure_advance).collect();
        assert!(set.len() >= 52, "{}", set.len());
        for v in &plan.values {
            assert!(set.iter().any(|s| (s - v).abs() < 1e-12), "{v}");
        }
        let fast = first
            .iter()
            .zip(first.iter().skip(1))
            .filter(|(_, b)| b.kind == "extrude" && b.speed_mm_s == Some(100.0))
            .count();
        assert_eq!(fast, 50);
        assert!(plan.min[0] > 0.0 && plan.max[0] < 256.0 && plan.min[1] > 0.0 && plan.max[1] < 256.0);
        assert!((plan.layers[1].z_mm - 0.4).abs() < 1e-12);
        assert_eq!(plan.labels.len(), 25);
        assert_eq!(plan.labels[1].text, "0.004");
        let none = pa_line(&PaLineParams {
            common: PaCommon {
                draw_numbers: false,
                ..PaCommon::default()
            },
            ..p.clone()
        })
        .unwrap();
        assert_eq!(none.layers.len(), 1);
        let short = pa_line(&PaLineParams {
            common: PaCommon {
                bed_depth_mm: 100.0,
                ..PaCommon::default()
            },
            ..p
        })
        .unwrap();
        assert_eq!(short.values.len(), 25);
    }

    #[test]
    fn pattern_test_prints_chevrons_for_every_value_over_four_layers() {
        let p = PaPatternParams::default();
        let plan = pa_pattern(&p).unwrap();
        assert_eq!(plan.values.len(), 17);
        assert_eq!(plan.layers.len(), 4);
        assert!((plan.layers[3].z_mm - (0.2 + 3.0 * 0.2)).abs() < 1e-12);
        for layer in &plan.layers[1..] {
            let set: Vec<f64> = layer.moves.iter().filter_map(|m| m.pressure_advance).collect();
            for v in &plan.values {
                assert!(
                    set.iter().any(|s| (s - v).abs() < 1e-12),
                    "layer {} value {v}",
                    layer.z_mm
                );
            }
        }
        let walls = plan.layers[2]
            .moves
            .iter()
            .filter(|m| m.comment.as_deref() == Some("Print pattern wall"))
            .count();
        assert_eq!(walls, 17 * 3 * 2);
        assert_eq!(plan.labels.len(), 9 + 2);
        assert!(plan.labels.iter().any(|l| l.meaning == "flow" && l.value > 0.0));
        assert!(
            plan.labels
                .iter()
                .any(|l| l.meaning == "acceleration" && l.value == 500.0)
        );
        assert!(plan.min[0] >= 0.0 && plan.max[0] <= 256.0 && plan.max[1] <= 256.0);
        assert_eq!(plan.suggested_settings["wall_loops"], 3);
        assert!(
            pa_pattern(&PaPatternParams {
                step: 0.0001,
                ..p.clone()
            })
            .is_err()
        );
        assert!(
            pa_pattern(&PaPatternParams {
                end: 0.0,
                ..p.clone()
            })
            .is_err()
        );
        let tiny = PaCommon {
            bed_width_mm: 40.0,
            ..PaCommon::default()
        };
        assert!(pa_pattern(&PaPatternParams { common: tiny, ..p }).is_err());
    }

    #[test]
    fn gcode_uses_the_flavor_and_extrudes_by_length() {
        let plan = pa_line(&PaLineParams::default()).unwrap();
        for (flavor, needle) in [
            (Flavor::Klipper, "SET_PRESSURE_ADVANCE ADVANCE=0.0020"),
            (Flavor::Marlin, "M900 K0.0020"),
            (Flavor::RepRapFirmware, "M572 D0 S0.0020"),
            (Flavor::Bambu, "M900 K0.0020 L1000 M10"),
        ] {
            let g = render_gcode(
                &plan,
                &GcodeOptions {
                    flavor,
                    ..GcodeOptions::default()
                },
            )
            .unwrap();
            assert!(g.contains(needle), "{flavor:?}");
            assert!(g.ends_with(&format!("{}\n", pa_command(flavor, 0.0))));
        }
        let g = render_gcode(&plan, &GcodeOptions::default()).unwrap();
        let e = 20.0 * mm3_per_mm(0.6, 0.2) / (PI * 0.875 * 0.875);
        assert!(g.contains(&format!("E{e:.5}")), "{e}");
        assert!(!g.contains("NaN"));
        assert!(
            render_gcode(
                &plan,
                &GcodeOptions {
                    filament_diameter_mm: 0.0,
                    ..GcodeOptions::default()
                }
            )
            .is_err()
        );
    }
}
