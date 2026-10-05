// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! parametric calibration and reference models
// counts, step numbers and layer numbers are small and non-negative
#![allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use crate::build;
use crate::convex::{Region, intersect};
use crate::emboss::{EmbossMode, EmbossSpec, attach_solid, emboss_text};
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::poly2d::{self, Polygon};
use crate::vec3::{Frame, Plane, V2, V3};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_4};

const DEBOSS_MM: f64 = 0.6;
const MAX_STEPS: usize = 64;
const CHORD_MM: f64 = 0.02;

mod more;

type Settings = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "test", rename_all = "kebab-case")]
pub enum CalibRequest {
    TempTower(TempTowerParams),
    Flow(FlowParams),
    PressureAdvance(PressureAdvanceParams),
    Retraction(RetractionParams),
    MaxVolumetric(MaxVolumetricParams),
    Tolerance(ToleranceParams),
    Shrinkage(ShrinkageParams),
    #[serde(alias = "x-reference")]
    FeaturePiece(FeaturePieceParams),
    PaLine(more::PaLineRequest),
    PaPattern(more::PaPatternRequest),
    Vfa(more::VfaParams),
    InputShapingFreq(more::InputShapingFreqParams),
    InputShapingDamp(more::InputShapingDampParams),
    Cornering(more::CorneringParams),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TempTowerParams {
    /// temperature of the bottom block in degrees C
    pub from_c: f64,
    pub to_c: f64,
    /// step between blocks in degrees C
    pub step_c: f64,
    /// height of one block in mm (at least 8)
    pub block_mm: f64,
    pub depth_mm: f64,
    pub labels: bool,
}

impl Default for TempTowerParams {
    fn default() -> Self {
        Self {
            from_c: 230.0,
            to_c: 190.0,
            step_c: 5.0,
            block_mm: 10.0,
            depth_mm: 14.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FlowParams {
    pub from: f64,
    pub to: f64,
    pub step: f64,
    pub pad_mm: f64,
    pub height_mm: f64,
    pub labels: bool,
}

impl Default for FlowParams {
    fn default() -> Self {
        Self {
            from: 0.93,
            to: 1.01,
            step: 0.02,
            pad_mm: 20.0,
            height_mm: 3.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PressureAdvanceParams {
    pub from: f64,
    pub to: f64,
    pub step: f64,
    pub size_mm: f64,
    pub height_mm: f64,
    pub labels: bool,
}

impl Default for PressureAdvanceParams {
    fn default() -> Self {
        Self {
            from: 0.0,
            to: 0.1,
            step: 0.01,
            size_mm: 30.0,
            height_mm: 40.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RetractionParams {
    pub from_mm: f64,
    pub to_mm: f64,
    pub step_mm: f64,
    pub height_mm: f64,
    pub tower_mm: f64,
    pub gap_mm: f64,
    pub speed_mm_s: Option<f64>,
    pub labels: bool,
}

impl Default for RetractionParams {
    fn default() -> Self {
        Self {
            from_mm: 0.2,
            to_mm: 1.2,
            step_mm: 0.2,
            height_mm: 40.0,
            tower_mm: 6.0,
            gap_mm: 30.0,
            speed_mm_s: None,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MaxVolumetricParams {
    pub from_mm3_s: f64,
    pub to_mm3_s: f64,
    pub step_mm3_s: f64,
    pub layer_height_mm: f64,
    pub line_width_mm: f64,
    pub band_mm: f64,
    pub diameter_mm: f64,
    pub labels: bool,
}

impl Default for MaxVolumetricParams {
    fn default() -> Self {
        Self {
            from_mm3_s: 5.0,
            to_mm3_s: 25.0,
            step_mm3_s: 1.0,
            layer_height_mm: 0.2,
            line_width_mm: 0.45,
            band_mm: 2.0,
            diameter_mm: 30.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToleranceParams {
    pub nominal_mm: f64,
    pub clearances_mm: Vec<f64>,
    pub thickness_mm: f64,
    pub pegs: usize,
    pub labels: bool,
}

impl Default for ToleranceParams {
    fn default() -> Self {
        Self {
            nominal_mm: 8.0,
            clearances_mm: vec![0.0, 0.1, 0.2, 0.3, 0.4, 0.5],
            thickness_mm: 5.0,
            pegs: 2,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShrinkageParams {
    pub arm_mm: f64,
    pub width_mm: f64,
    pub thickness_mm: f64,
    pub post_mm: f64,
    pub labels: bool,
}

impl Default for ShrinkageParams {
    fn default() -> Self {
        Self {
            arm_mm: 100.0,
            width_mm: 10.0,
            thickness_mm: 4.0,
            post_mm: 50.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeaturePieceParams {
    pub size_mm: f64,
    pub base_mm: f64,
    pub hole_mm: f64,
    pub labels: bool,
}

impl Default for FeaturePieceParams {
    fn default() -> Self {
        Self {
            size_mm: 60.0,
            base_mm: 4.0,
            hole_mm: 5.0,
            labels: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibModel {
    pub name: String,
    pub objects: Vec<CalibObject>,
    /// setting overrides by height, in mm above the bed
    pub ranges: Vec<RangeOverride>,
    pub instructions: Vec<String>,
    pub expected: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibObject {
    pub name: String,
    pub mesh: TriMesh,
    pub offset_mm: [f64; 2],
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeOverride {
    pub z_from_mm: f64,
    pub z_to_mm: f64,
    pub settings: Settings,
}

pub fn generate(req: &CalibRequest) -> Result<CalibModel> {
    match req {
        CalibRequest::TempTower(p) => temp_tower(p),
        CalibRequest::Flow(p) => flow(p),
        CalibRequest::PressureAdvance(p) => pressure_advance(p),
        CalibRequest::Retraction(p) => retraction(p),
        CalibRequest::MaxVolumetric(p) => max_volumetric(p),
        CalibRequest::Tolerance(p) => tolerance(p),
        CalibRequest::Shrinkage(p) => shrinkage(p),
        CalibRequest::FeaturePiece(p) => feature_piece(p),
        CalibRequest::PaLine(p) => more::pa_line(p),
        CalibRequest::PaPattern(p) => more::pa_pattern(p),
        CalibRequest::Vfa(p) => more::vfa(p),
        CalibRequest::InputShapingFreq(p) => more::input_shaping_freq(p),
        CalibRequest::InputShapingDamp(p) => more::input_shaping_damp(p),
        CalibRequest::Cornering(p) => more::cornering(p),
    }
}

fn settings(pairs: &[(&str, Value)]) -> Settings {
    pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect()
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

fn num(v: f64) -> Value {
    if v.fract().abs() < 1e-9 && v.abs() < 1e9 {
        json!(v.round() as i64)
    } else {
        json!(round6(v))
    }
}

fn fmt_num(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" {
        "0".to_string()
    } else {
        s.to_string()
    }
}

fn positive(what: &'static str, v: f64) -> Result<()> {
    if v.is_finite() && v > 0.0 {
        Ok(())
    } else {
        Err(Error::invalid(
            what,
            format!("must be a positive number, got {v}"),
        ))
    }
}

fn steps(what: &'static str, from: f64, to: f64, step: f64) -> Result<Vec<f64>> {
    if !(from.is_finite() && to.is_finite() && step.is_finite()) || step.abs() < 1e-9 {
        return Err(Error::invalid(
            what,
            "from, to and step must be numbers and step nonzero",
        ));
    }
    let step = step.abs();
    let n = ((to - from).abs() / step + 1e-9).floor();
    if n >= MAX_STEPS as f64 {
        return Err(Error::invalid(what, format!("more than {MAX_STEPS} steps")));
    }
    let dir = if to >= from { 1.0 } else { -1.0 };
    Ok((0..=n as usize)
        .map(|i| round6(from + dir * step * i as f64))
        .collect())
}

fn bands(height: f64, n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            (
                round6(height * i as f64 / n as f64),
                round6(height * (i + 1) as f64 / n as f64),
            )
        })
        .collect()
}

fn object(name: &str, mesh: TriMesh, offset: [f64; 2], s: Settings) -> CalibObject {
    CalibObject {
        name: name.to_string(),
        mesh: to_origin(mesh),
        offset_mm: offset,
        settings: s,
    }
}

fn to_origin(mut m: TriMesh) -> TriMesh {
    if let Some(b) = m.bounds() {
        m.translate([-b.min[0], -b.min[1], 0.0]);
    }
    m
}

fn xz_extrude(polys: &[Polygon], y0: f64, y1: f64) -> Result<TriMesh> {
    let frame = Frame {
        origin: [0.0, y1, 0.0],
        u: [1.0, 0.0, 0.0],
        v: [0.0, 0.0, 1.0],
        w: [0.0, -1.0, 0.0],
    };
    build::extrude(polys, &frame, 0.0, y1 - y0)
}

fn extrude_z(polys: &[Polygon], z0: f64, z1: f64) -> Result<TriMesh> {
    build::extrude(polys, &Frame::WORLD, z0, z1)
}

fn hole(center: V2, r: f64) -> Vec<V2> {
    let mut c = poly2d::circle(center, r, build::circle_segments(r, CHORD_MM));
    c.reverse();
    c
}

fn rotate_place(m: &mut TriMesh, deg: f64, d: V3) {
    let (s, c) = deg.to_radians().m_sin_cos();
    m.map_positions(|p| {
        [
            c * p[0] - s * p[1] + d[0],
            s * p[0] + c * p[1] + d[1],
            p[2] + d[2],
        ]
    });
}

fn stand_on(mesh: &TriMesh, solid: &TriMesh, point: V3, z: f64) -> Result<TriMesh> {
    let Some(bounds) = solid.bounds() else {
        return Ok(mesh.clone());
    };
    let above = Plane {
        normal: [0.0, 0.0, -1.0],
        offset: -z,
    };
    let mut cut = if bounds.min[2] < z - 1e-9 {
        intersect(solid, &Region::halfspace(above, &bounds))?
    } else {
        solid.clone()
    };
    cut.map_positions(|p| {
        if (p[2] - z).abs() < 1e-7 {
            [p[0], p[1], z]
        } else {
            p
        }
    });
    attach_solid(mesh, &cut, [point[0], point[1], z], Some([0.0, 0.0, 1.0]))
}

#[cfg(test)]
thread_local! {
    static LABEL_RETRIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

struct Label {
    text: String,
    point: V3,
    normal: V3,
    up: V3,
    size_mm: f64,
}

impl Label {
    fn new(text: impl Into<String>, point: V3, normal: V3, up: V3, size_mm: f64) -> Self {
        Self {
            text: text.into(),
            point,
            normal,
            up,
            size_mm,
        }
    }
}

fn apply_labels(mut mesh: TriMesh, labels: &[Label]) -> TriMesh {
    for l in labels {
        for scale in [1.0, 0.94, 0.88, 0.82, 0.76] {
            let spec = EmbossSpec {
                text: l.text.clone(),
                point: l.point,
                normal: Some(l.normal),
                up: Some(l.up),
                size_mm: l.size_mm * scale,
                stroke_mm: None,
                depth_mm: DEBOSS_MM,
                mode: EmbossMode::Deboss,
            };
            if let Ok(m) = emboss_text(&mesh, &spec)
                && m.edge_report().is_watertight()
            {
                mesh = m;
                break;
            }
            #[cfg(test)]
            LABEL_RETRIES.with(|c| c.set(c.get() + 1));
        }
    }
    mesh
}

fn instr(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|s| (*s).to_string()).collect()
}

const TT_PLATE: f64 = 1.2;
const TT_COL: f64 = 12.0;
const TT_GAP: f64 = 8.0;
const TT_PILLAR: f64 = 6.0;
const TT_WEDGE: f64 = 5.0;
const TT_LEFT: f64 = 8.0;
const TT_RIGHT: f64 = 6.0;

fn temp_tower(p: &TempTowerParams) -> Result<CalibModel> {
    let temps = steps("temp-tower", p.from_c, p.to_c, p.step_c)?;
    if !(p.block_mm.is_finite() && p.block_mm >= 8.0) {
        return Err(Error::invalid("temp-tower", "blockMm must be at least 8"));
    }
    positive("temp-tower depthMm", p.depth_mm)?;
    let n = temps.len();
    let bh = p.block_mm;
    let height = TT_PLATE + n as f64 * bh;
    let x_pillar = TT_COL + TT_GAP;
    let x_right = x_pillar + TT_PILLAR;

    let mut outline: Vec<V2> = vec![
        [-TT_LEFT, 0.0],
        [x_right + TT_RIGHT, 0.0],
        [x_right + TT_RIGHT, TT_PLATE],
        [x_right, TT_PLATE],
        [x_right, height],
        [0.0, height],
    ];
    let mut holes: Vec<Vec<V2>> = Vec::new();
    for i in (0..n).rev() {
        let zb = TT_PLATE + i as f64 * bh;
        let top = zb + bh - 1.0;
        outline.extend([
            [0.0, top],
            [-TT_WEDGE, top],
            [-TT_WEDGE, zb + 1.0 + TT_WEDGE],
            [0.0, zb + 1.0],
        ]);
        let mut w = poly2d::rect([TT_COL, zb], [x_pillar, zb + bh - 2.0]);
        w.reverse();
        holes.push(w);
    }
    outline.extend([[0.0, TT_PLATE], [-TT_LEFT, TT_PLATE]]);
    let windows = Polygon {
        outer: outline,
        holes,
    };
    let mut mesh = xz_extrude(&[windows], 0.0, p.depth_mm)?;

    let mut labels = Vec::new();
    if p.labels {
        for (i, t) in temps.iter().enumerate() {
            let zc = TT_PLATE + (i as f64 + 0.5) * bh;
            labels.push(Label::new(
                fmt_num(*t),
                [TT_COL / 2.0, 0.0, zc],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                3.6,
            ));
        }
    }
    mesh = apply_labels(mesh, &labels);

    let ranges = temps
        .iter()
        .enumerate()
        .map(|(i, t)| RangeOverride {
            z_from_mm: if i == 0 {
                0.0
            } else {
                round6(TT_PLATE + i as f64 * bh)
            },
            z_to_mm: round6(TT_PLATE + (i + 1) as f64 * bh),
            settings: settings(&[("nozzle_temperature", num(*t))]),
        })
        .collect();
    let blocks: Vec<Value> = temps
        .iter()
        .enumerate()
        .map(|(i, t)| {
            json!({
                "temperatureC": num(*t),
                "zFromMm": round6(TT_PLATE + i as f64 * bh),
                "zToMm": round6(TT_PLATE + (i + 1) as f64 * bh),
            })
        })
        .collect();
    Ok(CalibModel {
        name: "temp-tower".into(),
        objects: vec![object("temp-tower", mesh, [0.0, 0.0], Settings::new())],
        ranges,
        instructions: instr(&[
            "Print the tower with the temperature changes applied at the block heights.",
            "Blocks run from the hottest at the bottom to the coolest at the top.",
            "Compare the 45 degree overhang on the left of each block, the bridge across the gap on the right, and stringing between the column and the pillar.",
            "Pick the block with the cleanest bridge and overhang and the best layer bonding. Its label is the temperature.",
        ]),
        expected: json!({
            "blocks": blocks,
            "blockHeightMm": bh,
            "plateMm": TT_PLATE,
            "heightMm": round6(height),
            "overhangAngleDeg": 45,
            "bridgeGapMm": TT_GAP,
        }),
    })
}

const FLOW_STRIP: f64 = 5.0;

fn flow(p: &FlowParams) -> Result<CalibModel> {
    let ratios = steps("flow", p.from, p.to, p.step)?;
    if ratios.iter().any(|r| *r <= 0.0) {
        return Err(Error::invalid("flow", "flow ratios must be positive"));
    }
    positive("flow padMm", p.pad_mm)?;
    positive("flow heightMm", p.height_mm)?;
    let depth = p.pad_mm + FLOW_STRIP;
    let pitch_x = p.pad_mm + 6.0;
    let pitch_y = depth + 6.0;
    let mut objects = Vec::new();
    for (i, r) in ratios.iter().enumerate() {
        let mut pad = extrude_z(
            &[Polygon::simple(poly2d::rect([0.0, 0.0], [p.pad_mm, depth]))],
            0.0,
            p.height_mm,
        )?;
        if p.labels {
            let label = Label::new(
                fmt_num(*r),
                [p.pad_mm / 2.0, FLOW_STRIP / 2.0, p.height_mm],
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0],
                3.0,
            );
            pad = apply_labels(pad, &[label]);
        }
        let (col, row) = (i % 6, i / 6);
        objects.push(object(
            &format!("flow-{}", fmt_num(*r)),
            pad,
            [col as f64 * pitch_x, row as f64 * pitch_y],
            settings(&[("filament_flow_ratio", json!(*r))]),
        ));
    }
    Ok(CalibModel {
        name: "flow".into(),
        objects,
        ranges: Vec::new(),
        instructions: instr(&[
            "Print every pad with the flow ratio stored on its object.",
            "Look at the top surface of each pad in raking light. Pick the pad whose top is smooth, gap free and without ridges.",
            "Gaps between lines mean the ratio is too low. Ridges and a rough top mean it is too high.",
            "Multiply your current flow ratio by the winning pad's ratio if you tested relative values, otherwise use the label directly.",
        ]),
        expected: json!({
            "flowRatios": ratios,
            "padMm": p.pad_mm,
            "heightMm": p.height_mm,
            "judgingAreaMm": [p.pad_mm, p.pad_mm],
        }),
    })
}

fn pressure_advance(p: &PressureAdvanceParams) -> Result<CalibModel> {
    let values = steps("pressure-advance", p.from, p.to, p.step)?;
    if values.iter().any(|v| *v < 0.0) {
        return Err(Error::invalid("pressure-advance", "values must not be negative"));
    }
    positive("pressure-advance sizeMm", p.size_mm)?;
    positive("pressure-advance heightMm", p.height_mm)?;
    let n = values.len();
    let band = p.height_mm / n as f64;
    let mut mesh = build::box_mesh([0.0, 0.0, 0.0], [p.size_mm, p.size_mm, p.height_mm]);
    if p.labels && n >= 2 {
        let size = (band * 0.7).clamp(1.5, 3.0);
        let mk = |v: f64, z: f64| {
            Label::new(
                fmt_num(v),
                [p.size_mm / 2.0, 0.0, z],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                size,
            )
        };
        if let (Some(&first), Some(&last)) = (values.first(), values.last()) {
            mesh = apply_labels(mesh, &[mk(first, band * 0.5), mk(last, p.height_mm - band * 0.5)]);
        }
    }
    let spans = bands(p.height_mm, n);
    let ranges = spans
        .iter()
        .zip(&values)
        .map(|(&(a, b), v)| RangeOverride {
            z_from_mm: a,
            z_to_mm: b,
            settings: settings(&[
                ("enable_pressure_advance", json!(true)),
                ("pressure_advance", json!(*v)),
            ]),
        })
        .collect();
    let table: Vec<Value> = spans
        .iter()
        .zip(&values)
        .map(|(&(a, b), v)| json!({"pressureAdvance": v, "zFromMm": a, "zToMm": b}))
        .collect();
    Ok(CalibModel {
        name: "pressure-advance".into(),
        objects: vec![object(
            "pressure-advance",
            mesh,
            [0.0, 0.0],
            settings(&[
                ("wall_loops", json!(1)),
                ("sparse_infill_density", json!("0%")),
                ("top_shell_layers", json!(0)),
            ]),
        )],
        ranges,
        instructions: instr(&[
            "Print the tower with a single wall and no infill, at the speeds you normally print outer walls.",
            "Pressure advance rises with height in equal bands.",
            "Inspect the four vertical corners. Bulging corners mean too little advance, gaps and rounded corners mean too much.",
            "Measure the height of the band with the sharpest, fullest corners and read its value from the table in expected.",
        ]),
        expected: json!({
            "bands": table,
            "sizeMm": p.size_mm,
            "heightMm": p.height_mm,
            "bandHeightMm": round6(band),
            "valueAtHeight": "value = from + step * floor(z / bandHeightMm)",
        }),
    })
}

const RT_BASE: f64 = 2.0;
const RT_MARGIN: f64 = 8.0;
const RT_STRIP: f64 = 8.0;

fn retraction(p: &RetractionParams) -> Result<CalibModel> {
    let values = steps("retraction", p.from_mm, p.to_mm, p.step_mm)?;
    if values.iter().any(|v| *v < 0.0) {
        return Err(Error::invalid("retraction", "lengths must not be negative"));
    }
    positive("retraction heightMm", p.height_mm)?;
    positive("retraction towerMm", p.tower_mm)?;
    positive("retraction gapMm", p.gap_mm)?;
    let width = 2.0 * RT_MARGIN + 2.0 * p.tower_mm + p.gap_mm;
    let depth = RT_STRIP + p.tower_mm + 4.0;
    let mut base = build::box_mesh([0.0, 0.0, 0.0], [width, depth, RT_BASE]);
    let r = p.tower_mm / 2.0;
    let cy = RT_STRIP + r;
    let segs = build::circle_segments(r, CHORD_MM);
    for cx in [RT_MARGIN + r, RT_MARGIN + p.tower_mm + p.gap_mm + r] {
        let frame = Frame {
            origin: [cx, cy, RT_BASE],
            ..Frame::WORLD
        };
        let tower = build::cylinder(&frame, r, 0.0, (p.height_mm - RT_BASE).max(0.1), segs);
        base = stand_on(&base, &tower, [cx, cy, RT_BASE], RT_BASE)?;
    }
    if p.labels {
        let text = format!("{} {}", fmt_num(p.from_mm), fmt_num(p.to_mm));
        base = apply_labels(
            base,
            &[Label::new(
                text,
                [width / 2.0, RT_STRIP / 2.0, RT_BASE],
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 0.0],
                3.0,
            )],
        );
    }
    let n = values.len();
    let spans = bands(p.height_mm, n);
    let ranges = spans
        .iter()
        .zip(&values)
        .map(|(&(a, b), v)| RangeOverride {
            z_from_mm: a,
            z_to_mm: b,
            settings: settings(&[("retraction_length", json!(*v))]),
        })
        .collect();
    let mut obj_settings = Settings::new();
    if let Some(s) = p.speed_mm_s {
        positive("retraction speedMmS", s)?;
        obj_settings.insert("retraction_speed".into(), json!(s));
    }
    let table: Vec<Value> = spans
        .iter()
        .zip(&values)
        .map(|(&(a, b), v)| json!({"retractionMm": v, "zFromMm": a, "zToMm": b}))
        .collect();
    Ok(CalibModel {
        name: "retraction".into(),
        objects: vec![object("retraction", base, [0.0, 0.0], obj_settings)],
        ranges,
        instructions: instr(&[
            "Print the two towers with travel moves enabled between them.",
            "Retraction length rises with height in equal bands.",
            "Look for strings and blobs between the towers. Find the lowest band without strings and use its length.",
            "Fine hairs that remain at every height point to a temperature or wet filament problem instead.",
        ]),
        expected: json!({
            "bands": table,
            "heightMm": p.height_mm,
            "towerGapMm": p.gap_mm,
            "towerDiameterMm": p.tower_mm,
        }),
    })
}

fn max_volumetric(p: &MaxVolumetricParams) -> Result<CalibModel> {
    let flows = steps("max-volumetric", p.from_mm3_s, p.to_mm3_s, p.step_mm3_s)?;
    positive("max-volumetric fromMm3S", p.from_mm3_s)?;
    positive("max-volumetric layerHeightMm", p.layer_height_mm)?;
    positive("max-volumetric lineWidthMm", p.line_width_mm)?;
    positive("max-volumetric bandMm", p.band_mm)?;
    positive("max-volumetric diameterMm", p.diameter_mm)?;
    let n = flows.len();
    let height = p.band_mm * n as f64;
    let r = p.diameter_mm / 2.0;
    let frame = Frame {
        origin: [r, r, 0.0],
        ..Frame::WORLD
    };
    let mesh = build::cylinder(&frame, r, 0.0, height, build::circle_segments(r, CHORD_MM));
    let area = p.layer_height_mm * p.line_width_mm;
    let speeds: Vec<f64> = flows.iter().map(|q| (q / area * 10.0).round() / 10.0).collect();
    let spans = bands(height, n);
    let ranges = spans
        .iter()
        .zip(&speeds)
        .map(|(&(a, b), s)| RangeOverride {
            z_from_mm: a,
            z_to_mm: b,
            settings: settings(&[("outer_wall_speed", json!(*s))]),
        })
        .collect();
    let table: Vec<Value> = spans
        .iter()
        .zip(flows.iter().zip(&speeds))
        .map(|(&(a, b), (q, s))| {
            json!({"zFromMm": a, "zToMm": b, "volumetricMm3S": q, "outerWallSpeedMmS": s})
        })
        .collect();
    let cap = (p.to_mm3_s * 2.0).ceil();
    Ok(CalibModel {
        name: "max-volumetric".into(),
        objects: vec![object(
            "max-volumetric",
            mesh,
            [0.0, 0.0],
            settings(&[
                ("wall_loops", json!(1)),
                ("layer_height", json!(p.layer_height_mm)),
                ("line_width", json!(p.line_width_mm)),
                ("filament_max_volumetric_speed", json!(cap)),
                ("bottom_shell_layers", json!(3)),
                ("top_shell_layers", json!(0)),
                ("sparse_infill_density", json!("0%")),
                // thin layers finish fast at these speeds; cooling must not slow them
                ("slow_down_for_layer_cooling", json!(false)),
            ]),
        )],
        ranges,
        instructions: instr(&[
            "Print the tube with one wall (no vase mode) and a solid base. The filament volumetric speed limit is raised and layer cooling slowdown is off so neither caps the test.",
            "The outer wall speed rises with height so the flow steps up in equal bands.",
            "Watch for the height where the wall turns rough, under filled or the extruder clicks. The band just below it is the limit.",
            "Read that band's flow in mm^3/s from the table in expected and set the filament limit slightly under it.",
        ]),
        expected: json!({
            "bands": table,
            "layerHeightMm": p.layer_height_mm,
            "lineWidthMm": p.line_width_mm,
            "heightMm": height,
            "formula": "volumetric flow (mm^3/s) = outer wall speed (mm/s) * layer height (mm) * line width (mm)",
        }),
    })
}

fn tolerance(p: &ToleranceParams) -> Result<CalibModel> {
    positive("tolerance nominalMm", p.nominal_mm)?;
    positive("tolerance thicknessMm", p.thickness_mm)?;
    let clear = &p.clearances_mm;
    if clear.is_empty() || clear.len() > 12 || clear.iter().any(|c| !c.is_finite() || *c < 0.0) {
        return Err(Error::invalid(
            "tolerance",
            "clearancesMm needs 1 to 12 values, none negative",
        ));
    }
    if p.pegs == 0 || p.pegs > 8 {
        return Err(Error::invalid("tolerance", "pegs must be 1 to 8"));
    }
    let max_c = clear.iter().copied().fold(0.0, f64::max);
    let d_max = p.nominal_mm + max_c;
    let pitch = d_max + 6.0;
    let strip = 8.0;
    let width = pitch * clear.len() as f64 + 2.0;
    let depth = strip + d_max + 6.0;
    let cy = strip + 3.0 + d_max / 2.0;
    let holes = clear
        .iter()
        .enumerate()
        .map(|(i, c)| hole([1.0 + pitch * (i as f64 + 0.5), cy], (p.nominal_mm + c) / 2.0))
        .collect();
    let plate_poly = Polygon {
        outer: poly2d::rect([0.0, 0.0], [width, depth]),
        holes,
    };
    let mut plate = extrude_z(&[plate_poly], 0.0, p.thickness_mm)?;
    if p.labels {
        let labels: Vec<Label> = clear
            .iter()
            .enumerate()
            .map(|(i, c)| {
                Label::new(
                    fmt_num(*c),
                    [1.0 + pitch * (i as f64 + 0.5), strip / 2.0, p.thickness_mm],
                    [0.0, 0.0, 1.0],
                    [0.0, 1.0, 0.0],
                    3.0,
                )
            })
            .collect();
        plate = apply_labels(plate, &labels);
    }
    let mut objects = vec![object("tolerance-plate", plate, [0.0, 0.0], Settings::new())];
    let r = p.nominal_mm / 2.0;
    for i in 0..p.pegs {
        let frame = Frame {
            origin: [r, r, 0.0],
            ..Frame::WORLD
        };
        let peg = build::cylinder(
            &frame,
            r,
            0.0,
            p.thickness_mm + 4.0,
            build::circle_segments(r, CHORD_MM),
        );
        objects.push(object(
            &format!("tolerance-peg-{}", i + 1),
            peg,
            [i as f64 * (p.nominal_mm + 4.0), depth + 6.0],
            Settings::new(),
        ));
    }
    let hole_table: Vec<Value> = clear
        .iter()
        .map(|c| json!({"clearanceMm": c, "holeDiameterMm": round6(p.nominal_mm + c)}))
        .collect();
    Ok(CalibModel {
        name: "tolerance".into(),
        objects,
        ranges: Vec::new(),
        instructions: instr(&[
            "Print the plate flat and the pegs upright.",
            "Try a peg in each hole. Note the smallest clearance where a peg drops in without force and without wobble.",
            "Use that clearance as the extra diameter for holes in your own designs, and half of it as the gap between mating faces.",
            "A peg that will not fit any hole means the model prints oversize. Measure the peg and compare it with the nominal diameter.",
        ]),
        expected: json!({
            "nominalDiameterMm": p.nominal_mm,
            "holes": hole_table,
            "pegDiameterMm": p.nominal_mm,
            "plateThicknessMm": p.thickness_mm,
        }),
    })
}

fn shrinkage(p: &ShrinkageParams) -> Result<CalibModel> {
    positive("shrinkage armMm", p.arm_mm)?;
    positive("shrinkage widthMm", p.width_mm)?;
    positive("shrinkage thicknessMm", p.thickness_mm)?;
    positive("shrinkage postMm", p.post_mm)?;
    if p.arm_mm < 3.0 * p.width_mm {
        return Err(Error::invalid(
            "shrinkage",
            "armMm must be at least 3 times widthMm",
        ));
    }
    if p.post_mm <= p.thickness_mm {
        return Err(Error::invalid("shrinkage", "postMm must be above thicknessMm"));
    }
    let (a, w) = (p.arm_mm, p.width_mm);
    let l = Polygon::simple(vec![[0.0, 0.0], [a, 0.0], [a, w], [w, w], [w, a], [0.0, a]]);
    let mut mesh = extrude_z(&[l], 0.0, p.thickness_mm)?;
    if p.labels && a >= 40.0 && w >= 6.0 {
        let label = Label::new(
            fmt_num(a),
            [a / 2.0, w / 2.0, p.thickness_mm],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            (w * 0.4).min(4.0),
        );
        mesh = apply_labels(mesh, &[label]);
    }
    // the post stands a millimeter in from the arm edges so it joins the top face
    let inset = (w * 0.15).min(1.0);
    let post = build::box_mesh([inset, inset, p.thickness_mm], [w - inset, w - inset, p.post_mm]);
    mesh = stand_on(&mesh, &post, [w / 2.0, w / 2.0, p.thickness_mm], p.thickness_mm)?;
    Ok(CalibModel {
        name: "shrinkage".into(),
        objects: vec![object("shrinkage", mesh, [0.0, 0.0], Settings::new())],
        ranges: Vec::new(),
        instructions: instr(&[
            "Print the L with the post standing at the corner. Let it cool to room temperature before measuring.",
            "Measure the outer length of each arm along X and Y, and the height of the post, with calipers.",
            "Divide each nominal length by the measured length to get the scale factor for that axis.",
            "Apply the factors as a scale on the model or in the slicer's shrinkage compensation.",
        ]),
        expected: json!({
            "nominalMm": {"x": num(a), "y": num(a), "z": num(p.post_mm)},
            "armWidthMm": w,
            "armThicknessMm": p.thickness_mm,
            "scaleFactor": "scale = nominal / measured, per axis, for example 100 / 99.2 = 1.008",
            "shrinkagePercent": "shrinkage % = (nominal - measured) / nominal * 100",
        }),
    })
}

const XR_START: f64 = 12.0;
const XR_MIN_SIZE: f64 = 56.0;
const XR_FEATURE_H: f64 = 12.0;

fn x_outline(size: f64) -> Vec<V2> {
    let h = size * 0.1;
    let l = size * FRAC_1_SQRT_2 - h;
    let plus: [V2; 12] = [
        [l, -h],
        [l, h],
        [h, h],
        [h, l],
        [-h, l],
        [-h, h],
        [-l, h],
        [-l, -h],
        [-h, -h],
        [-h, -l],
        [h, -l],
        [h, -h],
    ];
    let (s, c) = FRAC_PI_4.m_sin_cos();
    plus.iter()
        .map(|q| [c * q[0] - s * q[1], s * q[0] + c * q[1]])
        .collect()
}

#[allow(clippy::too_many_lines, reason = "one construction sequence, arm by arm")]
fn feature_piece(p: &FeaturePieceParams) -> Result<CalibModel> {
    if !(p.size_mm.is_finite() && p.size_mm >= XR_MIN_SIZE) {
        return Err(Error::invalid(
            "feature-piece",
            format!("sizeMm must be at least {XR_MIN_SIZE}"),
        ));
    }
    positive("feature-piece baseMm", p.base_mm)?;
    if !(p.hole_mm.is_finite() && p.hole_mm > 0.0 && p.hole_mm < p.size_mm * 0.15) {
        return Err(Error::invalid(
            "feature-piece",
            "holeMm must be positive and small next to the arm width",
        ));
    }
    let c = p.size_mm / 2.0;
    let z0 = p.base_mm - 0.2;
    let body = Polygon {
        outer: x_outline(p.size_mm),
        holes: vec![hole([0.0, 0.0], p.hole_mm / 2.0)],
    };
    let mut mesh = extrude_z(&[body], 0.0, p.base_mm)?;
    let overhang = Polygon::simple(vec![
        [0.0, z0],
        [10.0, z0],
        [10.0, z0 + 4.0],
        [18.0, z0 + XR_FEATURE_H],
        [0.0, z0 + XR_FEATURE_H],
    ]);
    let r = FRAC_1_SQRT_2;
    let mut over = xz_extrude(&[overhang], -5.0, 5.0)?;
    rotate_place(&mut over, 45.0, [XR_START * r, XR_START * r, 0.0]);
    let bridge = Polygon::simple(vec![
        [0.0, z0],
        [3.0, z0],
        [3.0, z0 + 8.0],
        [13.0, z0 + 8.0],
        [13.0, z0],
        [16.0, z0],
        [16.0, z0 + 10.0],
        [0.0, z0 + 10.0],
    ]);
    let mut br = xz_extrude(&[bridge], -5.0, 5.0)?;
    rotate_place(&mut br, 135.0, [-XR_START * r, XR_START * r, 0.0]);
    let mut wall = build::box_mesh([0.0, -0.4, z0], [16.0, 0.4, z0 + XR_FEATURE_H]);
    rotate_place(&mut wall, 225.0, [-XR_START * r, -XR_START * r, 0.0]);
    for (feature, anchor) in [
        (&over, [XR_START * r + 3.5, XR_START * r + 3.5]),
        (&br, [-XR_START * r - 5.7, XR_START * r + 5.7]),
        (&wall, [-XR_START * r - 5.7, -XR_START * r - 5.7]),
    ] {
        mesh = stand_on(&mesh, feature, [anchor[0], anchor[1], p.base_mm], p.base_mm)?;
    }
    if p.labels {
        let d = r * 22.0;
        let label = Label::new("SX", [d, -d, p.base_mm], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0], 4.0);
        mesh = apply_labels(mesh, &[label]);
    }
    mesh.translate([c, c, 0.0]);
    Ok(CalibModel {
        name: "feature-piece".into(),
        objects: vec![object("feature-piece", mesh, [0.0, 0.0], Settings::new())],
        ranges: Vec::new(),
        instructions: instr(&[
            "Slice and print the X with your normal profile.",
            "The center hole checks round hole accuracy, the northeast arm has a 45 degree overhang, and the northwest arm has a 10 mm bridge.",
            "The southwest arm is a 0.8 mm wall for thin wall handling and the southeast arm carries small text.",
            "Compare against a reference print of the same model to spot regressions after a profile or slicer change.",
        ]),
        expected: json!({
            "sizeMm": p.size_mm,
            "bodyThicknessMm": p.base_mm,
            "throughHoleMm": p.hole_mm,
            "armWidthMm": round6(p.size_mm * 0.2),
            "features": {
                "overhang": {"arm": "northeast", "angleDeg": 45, "widthMm": 10, "heightMm": XR_FEATURE_H},
                "bridge": {"arm": "northwest", "spanMm": 10, "beamMm": 2, "heightMm": 10},
                "thinWall": {"arm": "southwest", "thicknessMm": 0.8, "lengthMm": 16, "heightMm": XR_FEATURE_H},
                "text": {"arm": "southeast", "text": "SX", "sizeMm": 4},
            },
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn all_requests() -> Vec<CalibRequest> {
        [
            "temp-tower",
            "flow",
            "pressure-advance",
            "retraction",
            "max-volumetric",
            "tolerance",
            "shrinkage",
            "feature-piece",
        ]
        .iter()
        .map(|t| serde_json::from_value(json!({ "test": t })).unwrap())
        .collect()
    }

    fn check_model(m: &CalibModel) {
        assert!(!m.objects.is_empty(), "{}", m.name);
        for o in &m.objects {
            assert_eq!(
                o.mesh.components().len(),
                1,
                "{} {} is not one shell",
                m.name,
                o.name
            );
            assert!(o.mesh.edge_report().is_watertight(), "{} {}", m.name, o.name);
            assert!(o.mesh.volume() > 0.0, "{} {}", m.name, o.name);
            let b = o.mesh.bounds().unwrap();
            assert!(b.min[2].abs() < 1e-9, "{} {} min z", m.name, o.name);
            assert!(
                b.min[0].abs() < 1e-9 && b.min[1].abs() < 1e-9,
                "{} {} footprint",
                m.name,
                o.name
            );
        }
        for w in m.ranges.windows(2) {
            assert!((w[0].z_to_mm - w[1].z_from_mm).abs() < 1e-9, "{} gap", m.name);
            assert!(w[0].z_to_mm > w[0].z_from_mm);
        }
        let text = serde_json::to_string(&m.instructions).unwrap() + &m.name;
        assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}'));
    }

    fn top(m: &CalibModel) -> f64 {
        m.objects
            .iter()
            .map(|o| o.mesh.bounds().unwrap().max[2])
            .fold(0.0, f64::max)
    }

    #[test]
    fn defaults_are_solid_and_timed() {
        LABEL_RETRIES.with(|c| c.set(0));
        for r in all_requests() {
            let t = Instant::now();
            let m = generate(&r).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1e3;
            eprintln!("{} {:.1} ms (debug)", m.name, ms);
            check_model(&m);
        }
        assert_eq!(
            LABEL_RETRIES.with(std::cell::Cell::get),
            0,
            "a label shrank or was dropped"
        );
    }

    #[test]
    fn feature_piece_label_is_cut() {
        let with = generate(&CalibRequest::FeaturePiece(FeaturePieceParams::default())).unwrap();
        let without = generate(&CalibRequest::FeaturePiece(FeaturePieceParams {
            labels: false,
            ..FeaturePieceParams::default()
        }))
        .unwrap();
        let cut = without.objects[0].mesh.volume() - with.objects[0].mesh.volume();
        assert!(cut > 2.0 && cut < 20.0, "{cut}");
    }

    #[test]
    fn json_round_trip_of_bare_request() {
        let r: CalibRequest = serde_json::from_str(r#"{"test":"temp-tower"}"#).unwrap();
        assert_eq!(r, CalibRequest::TempTower(TempTowerParams::default()));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("\"test\":\"temp-tower\"") && s.contains("\"fromC\":230"));
        assert_eq!(serde_json::from_str::<CalibRequest>(&s).unwrap(), r);
        let r: CalibRequest =
            serde_json::from_str(r#"{"test":"retraction","fromMm":0.5,"toMm":1.5}"#).unwrap();
        let CalibRequest::Retraction(p) = r else {
            panic!("variant")
        };
        assert!((p.from_mm - 0.5).abs() < 1e-12 && (p.step_mm - 0.2).abs() < 1e-12);
    }

    #[test]
    fn response_serializes_camel_case() {
        let m = generate(&all_requests()[0]).unwrap();
        let v = serde_json::to_value(&m).unwrap();
        assert!(v["objects"][0]["offsetMm"].is_array());
        assert!(v["ranges"][0]["zFromMm"].is_number());
        assert!(v["ranges"][0]["settings"]["nozzle_temperature"].is_number());
        let back: CalibModel = serde_json::from_value(v).unwrap();
        assert_eq!(back.ranges.len(), m.ranges.len());
    }

    #[test]
    fn temp_tower_blocks_and_ranges() {
        let m = generate(&CalibRequest::TempTower(TempTowerParams::default())).unwrap();
        assert_eq!(m.ranges.len(), 9);
        assert!(m.ranges[0].z_from_mm.abs() < 1e-9);
        let h = 1.2 + 90.0;
        assert!((m.ranges[8].z_to_mm - h).abs() < 1e-9);
        assert!((top(&m) - h).abs() < 1e-9);
        assert_eq!(m.ranges[0].settings["nozzle_temperature"], json!(230));
        assert_eq!(m.ranges[8].settings["nozzle_temperature"], json!(190));
        let b = m.objects[0].mesh.bounds().unwrap();
        assert!((b.size()[0] - 40.0).abs() < 1e-9 && (b.size()[1] - 14.0).abs() < 1e-9);
    }

    #[test]
    fn flow_pads_carry_ratios() {
        let m = generate(&CalibRequest::Flow(FlowParams::default())).unwrap();
        assert_eq!(m.objects.len(), 5);
        assert_eq!(m.objects[0].settings["filament_flow_ratio"], json!(0.93));
        assert_eq!(m.objects[4].settings["filament_flow_ratio"], json!(1.01));
        let s = m.objects[0].mesh.bounds().unwrap().size();
        assert!((s[0] - 20.0).abs() < 1e-9 && (s[2] - 3.0).abs() < 1e-9);
        assert!(m.ranges.is_empty());
    }

    #[test]
    fn pressure_advance_bands() {
        let m = generate(&CalibRequest::PressureAdvance(PressureAdvanceParams::default())).unwrap();
        assert_eq!(m.ranges.len(), 11);
        assert!((m.ranges[10].z_to_mm - 40.0).abs() < 1e-9);
        assert_eq!(m.ranges[3].settings["enable_pressure_advance"], json!(true));
        assert_eq!(m.ranges[3].settings["pressure_advance"], json!(0.03));
        assert_eq!(m.objects[0].settings["wall_loops"], json!(1));
        assert_eq!(m.objects[0].settings["sparse_infill_density"], json!("0%"));
        assert_eq!(m.objects[0].settings["top_shell_layers"], json!(0));
    }

    #[test]
    fn retraction_two_towers() {
        let m = generate(&CalibRequest::Retraction(RetractionParams::default())).unwrap();
        assert_eq!(m.ranges.len(), 6);
        assert_eq!(m.objects[0].mesh.components().len(), 1);
        assert!((top(&m) - 40.0).abs() < 1e-9);
        assert_eq!(m.ranges[0].settings["retraction_length"], json!(0.2));
    }

    #[test]
    fn max_volumetric_mapping() {
        let m = generate(&CalibRequest::MaxVolumetric(MaxVolumetricParams::default())).unwrap();
        assert_eq!(m.ranges.len(), 21);
        assert!(!m.objects[0].settings.contains_key("spiral_mode"));
        assert_eq!(m.objects[0].settings["wall_loops"], json!(1));
        assert_eq!(m.objects[0].settings["slow_down_for_layer_cooling"], json!(false));
        let speed = m.ranges[0].settings["outer_wall_speed"].as_f64().unwrap();
        assert!((speed * 0.2 * 0.45 - 5.0).abs() < 0.05);
        let last = m.ranges[20].settings["outer_wall_speed"].as_f64().unwrap();
        assert!((last * 0.2 * 0.45 - 25.0).abs() < 0.05);
        assert_eq!(m.expected["bands"].as_array().unwrap().len(), 21);
        assert!((top(&m) - 42.0).abs() < 1e-9);
    }

    #[test]
    fn tolerance_holes_and_pegs() {
        let m = generate(&CalibRequest::Tolerance(ToleranceParams::default())).unwrap();
        assert_eq!(m.objects.len(), 3);
        assert_eq!(m.expected["holes"].as_array().unwrap().len(), 6);
        let plate = &m.objects[0].mesh;
        assert_eq!(plate.components().len(), 1);
        let peg = m.objects[1].mesh.bounds().unwrap().size();
        assert!((peg[0] - 8.0).abs() < 0.05 && (peg[2] - 9.0).abs() < 1e-9);
    }

    #[test]
    fn shrinkage_dimensions() {
        let m = generate(&CalibRequest::Shrinkage(ShrinkageParams::default())).unwrap();
        let s = m.objects[0].mesh.bounds().unwrap().size();
        assert!((s[0] - 100.0).abs() < 1e-9 && (s[1] - 100.0).abs() < 1e-9 && (s[2] - 50.0).abs() < 1e-9);
        assert_eq!(m.expected["nominalMm"]["x"], json!(100));
    }

    #[test]
    fn feature_piece_size() {
        let old: CalibRequest = serde_json::from_value(json!({ "test": "x-reference" })).unwrap();
        assert!(matches!(old, CalibRequest::FeaturePiece(_)));
        let m = generate(&CalibRequest::FeaturePiece(FeaturePieceParams::default())).unwrap();
        let b = m.objects[0].mesh.bounds().unwrap();
        assert!((b.size()[0] - 60.0).abs() < 1e-6 && (b.size()[1] - 60.0).abs() < 1e-6);
        assert!((b.max[2] - 15.8).abs() < 1e-9);
        assert!(
            generate(&CalibRequest::FeaturePiece(FeaturePieceParams {
                size_mm: 40.0,
                ..FeaturePieceParams::default()
            }))
            .is_err()
        );
        let big = generate(&CalibRequest::FeaturePiece(FeaturePieceParams {
            size_mm: 90.0,
            ..FeaturePieceParams::default()
        }))
        .unwrap();
        check_model(&big);
    }

    #[test]
    fn bad_input_is_an_error() {
        let bad = CalibRequest::TempTower(TempTowerParams {
            step_c: 0.0,
            ..TempTowerParams::default()
        });
        assert!(generate(&bad).is_err());
        let many = CalibRequest::Flow(FlowParams {
            from: 0.1,
            to: 9.0,
            step: 0.01,
            ..FlowParams::default()
        });
        assert!(generate(&many).is_err());
    }

    #[test]
    fn labels_off_still_valid() {
        for r in all_requests() {
            let r = match r {
                CalibRequest::TempTower(p) => CalibRequest::TempTower(TempTowerParams { labels: false, ..p }),
                CalibRequest::Flow(p) => CalibRequest::Flow(FlowParams { labels: false, ..p }),
                other => other,
            };
            check_model(&generate(&r).unwrap());
        }
    }
}
