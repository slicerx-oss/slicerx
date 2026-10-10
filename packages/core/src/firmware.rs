// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What firmware and hosts read out of the G-code besides the moves: object
//! labels (so a print can skip a failed object), progress and the statistics
//! footer.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::fm::Fm as _;
use crate::geom::Point;
use crate::output::{Feature, ObjectFootprint};
use crate::plate::Plate;
use std::fmt::Write as _;

// ------------------------------------------------------------ object labels

/// Convex hull of points, counterclockwise, no repeated last point.
pub(crate) fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    crate::sorting::sort_by(&mut pts, |a, b| {
        a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
    });
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross =
        |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut hull: Vec<[f64; 2]> = Vec::with_capacity(pts.len() * 2);
    for pass in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &[f64; 2]>> = if pass == 0 {
            Box::new(pts.iter())
        } else {
            Box::new(pts.iter().rev())
        };
        for &p in iter {
            while hull.len() >= start + 2 {
                let (Some(&b), Some(&a)) = (hull.last(), hull.get(hull.len() - 2)) else {
                    break;
                };
                if cross(a, b, p) <= 0.0 {
                    hull.pop();
                } else {
                    break;
                }
            }
            hull.push(p);
        }
        hull.pop();
    }
    hull
}

/// A footprint per plate object: the hull of every part's transformed vertices. The objects' hulls are worked
/// out side by side: on a part of millions of vertices each takes a good part of a second on one thread.
pub fn footprints(plate: &Plate) -> Vec<ObjectFootprint> {
    crate::par::map(&plate.objects, |obj| {
        let pts: Vec<[f64; 2]> = obj
            .mesh
            .parts
            .iter()
            .filter(|p| !p.triangles.is_empty())
            .flat_map(|p| p.positions.iter())
            .map(|&v| {
                let w = obj.apply(v);
                [w[0], w[1]]
            })
            .collect();
        let hull = convex_hull(pts);
        let bb = hull
            .iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            });
        let center = if hull.is_empty() {
            [0.0, 0.0]
        } else {
            [f64::midpoint(bb[0], bb[2]), f64::midpoint(bb[1], bb[3])]
        };
        let name = if obj.name.is_empty() {
            obj.mesh.name.clone()
        } else {
            obj.name.clone()
        };
        ObjectFootprint {
            id: obj.id.clone(),
            name,
            hull,
            center,
        }
    })
}

/// `printf("%g")`: six significant digits, no trailing zeros, exponent form for very large or small values.
pub fn fmt_g(v: f64) -> String {
    if v == 0.0 || !v.is_finite() {
        return "0".to_owned();
    }
    #[allow(clippy::cast_possible_truncation, reason = "a decimal exponent")]
    let exp = v.abs().m_log10().floor() as i32;
    if !(-4..6).contains(&exp) {
        let s = format!("{v:.5e}");
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let m = if m.contains('.') {
            m.trim_end_matches('0').trim_end_matches('.')
        } else {
            m
        };
        let e: i32 = e.parse().unwrap_or(0);
        return format!("{m}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    #[allow(clippy::cast_sign_loss, reason = "5 - exp is at least 0 here")]
    let decimals = (5 - exp).max(0) as usize;
    let s = format!("{v:.decimals$}");
    // Rounding can carry into a new digit (9.999999 to 10.0000): fine, the text is still six digits.
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    }
}

fn area(hull: &[[f64; 2]]) -> f64 {
    let n = hull.len();
    (0..n)
        .map(|i| match (hull.get(i), hull.get((i + 1) % n)) {
            (Some(a), Some(b)) => a[0] * b[1] - b[0] * a[1],
            _ => 0.0,
        })
        .sum::<f64>()
        .abs()
        / 2.0
}

pub(crate) fn inside(hull: &[[f64; 2]], x: f64, y: f64, grow: f64) -> bool {
    let n = hull.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut near = false;
    for i in 0..n {
        let (Some(a), Some(b)) = (hull.get(i), hull.get((i + 1) % n)) else {
            continue;
        };
        if grow > 0.0 {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let len2 = dx * dx + dy * dy;
            let t = if len2 == 0.0 {
                0.0
            } else {
                (((x - a[0]) * dx + (y - a[1]) * dy) / len2).clamp(0.0, 1.0)
            };
            if ((x - (a[0] + t * dx)).m_powi(2) + (y - (a[1] + t * dy)).m_powi(2)).sqrt() <= grow {
                near = true;
            }
        }
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
    }
    inside || near
}

/// Which firmware syntax marks an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Firmware {
    Klipper,
    Marlin,
    /// `RepRapFirmware`: `M486` with the name on the start line.
    RepRap,
    /// Bambu firmware: `M624` with a 64 bit mask of objects as base64 of eight little endian bytes,
    /// `M625` to end.
    Bambu,
}

/// Most objects Bambu firmware can skip: the label mask is 64 bits (Orca's `g_max_label_object`).
const BAMBU_MAX_LABELS: usize = 64;

/// A Bambu Lab printer: the `bambu` flavor, or a `printer_model` that starts with "Bambu Lab" (the rule
/// Orca's command line uses for `Print::is_BBL_printer`, since Bambu presets say `marlin`).
pub fn bambu_printer(cfg: &PrintConfig, flavor: GcodeFlavor) -> bool {
    flavor == GcodeFlavor::Bambu
        || cfg
            .raw
            .get("printer_model")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|m| m.starts_with("Bambu Lab"))
}

/// Object labels for one output: `OctoPrint` style comments (`gcode_label_objects`)
/// and firmware commands (`exclude_object`): `EXCLUDE_OBJECT_*` on Klipper and
/// `M486` on Marlin flavors. Bambu Lab printers always get theirs (`M624`), as Orca writes them.
pub struct Labels<'a> {
    objects: &'a [ObjectFootprint],
    areas: Vec<f64>,
    /// Bounds of each hull, `[min x, min y, max x, max y]`, mm: a point outside them is not inside the hull.
    bounds: Vec<[f64; 4]>,
    comments: bool,
    firmware: Option<Firmware>,
}

/// A boolean profile key: `true`, `1`, `"1"`, or a list starting with one of those.
pub fn truthy(cfg: &PrintConfig, key: &str) -> bool {
    match cfg.raw.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        Some(serde_json::Value::Array(a)) => a.first().is_some_and(|v| match v {
            serde_json::Value::String(s) => s == "1" || s.eq_ignore_ascii_case("true"),
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
            _ => false,
        }),
        _ => false,
    }
}

impl<'a> Labels<'a> {
    /// None when the profile asks for no labels or the plate has no objects.
    pub fn new(objects: &'a [ObjectFootprint], cfg: &PrintConfig, flavor: GcodeFlavor) -> Option<Self> {
        if objects.is_empty() {
            return None;
        }
        let comments = truthy(cfg, "gcode_label_objects");
        // Orca turns labels on for every Bambu Lab printer (`GCode::_do_export`), whatever `exclude_object`
        // says; a plate with more objects than the label mask holds gets none, where Orca's mask overflows.
        let firmware = if bambu_printer(cfg, flavor) {
            (objects.len() <= BAMBU_MAX_LABELS).then_some(Firmware::Bambu)
        } else {
            truthy(cfg, "exclude_object")
                .then_some(match flavor {
                    GcodeFlavor::Klipper => Some(Firmware::Klipper),
                    GcodeFlavor::Marlin | GcodeFlavor::Marlin2 => Some(Firmware::Marlin),
                    GcodeFlavor::RepRapFirmware => Some(Firmware::RepRap),
                    _ => None,
                })
                .flatten()
        };
        if !comments && firmware.is_none() {
            return None;
        }
        Some(Self {
            areas: objects.iter().map(|o| area(&o.hull)).collect(),
            bounds: objects
                .iter()
                .map(|o| {
                    o.hull
                        .iter()
                        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                            [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
                        })
                })
                .collect(),
            objects,
            comments,
            firmware,
        })
    }

    /// The object's number in the labels. On Bambu Lab printers it counts from 1: it is the printer's
    /// `identify_id`, where Bambu Studio reads 0 as no id, and the hosts send it back to skip the object.
    pub fn label_id(&self, i: usize) -> usize {
        if self.firmware == Some(Firmware::Bambu) {
            i + 1
        } else {
            i
        }
    }

    /// Orca's `; model label id:` header line on Bambu Lab printers: every label id in ascending order.
    /// The bit for an object in an `M624` mask is its place in this list.
    pub fn id_list(&self) -> Option<String> {
        (self.firmware == Some(Firmware::Bambu)).then(|| {
            let ids: Vec<String> = (0..self.objects.len())
                .map(|i| self.label_id(i).to_string())
                .collect();
            format!("; model label id: {}\n", ids.join(","))
        })
    }

    /// `M624` with the mask of the given objects (Orca's `GCode::_encode_label_ids_to_base64`).
    fn bambu_mask(objects: impl IntoIterator<Item = usize>) -> String {
        let bits = objects
            .into_iter()
            .filter(|&i| i < BAMBU_MAX_LABELS)
            .fold(0u64, |m, i| m | (1u64 << i));
        format!("M624 {}\n", crate::thumbnail::base64_encode(&bits.to_le_bytes()))
    }

    /// Orca's lines round the timelapse G-code of a layer on a Bambu Lab printer with several objects
    /// (`insert_timelapse_gcode` in `GCode::process_layer`): the mask of the objects printed on the layer
    /// (0-based `layer`), so the printer skips the block once all of them are skipped.
    pub fn layer_wrap(
        &self,
        layer: u32,
        objects: &std::collections::BTreeSet<usize>,
    ) -> Option<(String, String)> {
        if self.firmware != Some(Firmware::Bambu) || self.objects.len() < 2 || objects.is_empty() {
            return None;
        }
        let ids: Vec<String> = objects.iter().map(|&i| self.label_id(i).to_string()).collect();
        let (ids, n) = (ids.join(","), layer + 1);
        Some((
            format!(
                "; object ids of layer {n} start: {ids}\n{}",
                Self::bambu_mask(objects.iter().copied())
            ),
            format!("; object ids of this layer{n} end: {ids}\nM625\n"),
        ))
    }

    /// Name the firmware sees: safe characters only, and unique.
    fn fw_name(&self, i: usize) -> String {
        let base: String = self
            .objects
            .get(i)
            .map_or("object", |o| o.name.as_str())
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{base}_id_{i}_copy_0")
    }

    /// Lines for the header, before the start G-code.
    pub fn header(&self) -> String {
        let mut s = String::new();
        match self.firmware {
            Some(Firmware::Klipper) => {
                for (i, o) in self.objects.iter().enumerate() {
                    let poly: Vec<String> = o
                        .hull
                        .iter()
                        .chain(o.hull.first())
                        .map(|p| format!("[{},{}]", fmt_g(p[0]), fmt_g(p[1])))
                        .collect();
                    let _ = writeln!(
                        s,
                        "EXCLUDE_OBJECT_DEFINE NAME={} CENTER={},{} POLYGON=[{}]",
                        self.fw_name(i),
                        fmt_g(o.center[0]),
                        fmt_g(o.center[1]),
                        poly.join(",")
                    );
                }
            }
            Some(Firmware::Bambu) | None => {}
            Some(Firmware::Marlin) => {
                for i in 0..self.objects.len() {
                    let _ = writeln!(s, "M486 S{i}\nM486 A{}\nM486 S-1", self.fw_name(i));
                }
            }
            Some(Firmware::RepRap) => {
                for i in 0..self.objects.len() {
                    let _ = writeln!(s, "M486 S{i} A\"{}\"\nM486 S-1", self.fw_name(i));
                }
            }
        }
        s
    }

    /// The object a path belongs to, by where it starts. Brim, skirt and tower belong to none.
    pub fn object_of(&self, p: Point, feature: Feature) -> Option<usize> {
        if matches!(
            feature,
            Feature::Brim | Feature::Skirt | Feature::PrimeTower | Feature::Custom
        ) {
            return None;
        }
        let (x, y) = (p.x_mm(), p.y_mm());
        let pick = |grow: f64| {
            // A point farther than `grow` outside a hull's bounds is neither inside nor near it; the margin
            // covers rounding in the exact test.
            let reach = grow + 1e-6;
            self.objects
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    self.bounds.get(*i).is_none_or(|b| {
                        x >= b[0] - reach && y >= b[1] - reach && x <= b[2] + reach && y <= b[3] + reach
                    })
                })
                .filter(|(_, o)| inside(&o.hull, x, y, grow))
                .min_by(|(i, _), (j, _)| {
                    let (a, b) = (
                        self.areas.get(*i).copied().unwrap_or(0.0),
                        self.areas.get(*j).copied().unwrap_or(0.0),
                    );
                    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
        };
        // Supports and wipes can stray a little outside the hull.
        pick(0.0).or_else(|| pick(3.0))
    }

    /// Text before the retract that leaves an object (comment style).
    pub fn comment_end(&self, i: usize) -> Option<String> {
        self.comments.then(|| {
            format!(
                "; stop printing object {} id:{} copy 0\n",
                self.display(i),
                self.label_id(i)
            )
        })
    }

    /// Text before the retract that starts an object (comment style).
    pub fn comment_start(&self, i: usize) -> Option<String> {
        self.comments.then(|| {
            format!(
                "; printing object {} id:{} copy 0\n",
                self.display(i),
                self.label_id(i)
            )
        })
    }

    /// Text after the retract that leaves an object (firmware style).
    pub fn fw_end(&self, i: usize) -> Option<String> {
        match self.firmware? {
            Firmware::Klipper => Some(format!("EXCLUDE_OBJECT_END NAME={}\n", self.fw_name(i))),
            Firmware::Marlin | Firmware::RepRap => Some("M486 S-1\n".to_owned()),
            Firmware::Bambu => Some(format!(
                "; stop printing object, unique label id: {}\nM625\n",
                self.label_id(i)
            )),
        }
    }

    /// Text after the retract that starts an object (firmware style).
    pub fn fw_start(&self, i: usize) -> Option<String> {
        match self.firmware? {
            Firmware::Klipper => Some(format!("EXCLUDE_OBJECT_START NAME={}\n", self.fw_name(i))),
            Firmware::Marlin | Firmware::RepRap => Some(format!("M486 S{i}\n")),
            Firmware::Bambu => Some(format!(
                "; start printing object, unique label id: {}\n{}",
                self.label_id(i),
                Self::bambu_mask([i])
            )),
        }
    }

    fn display(&self, i: usize) -> &str {
        self.objects.get(i).map_or("object", |o| o.name.as_str())
    }
}

// ------------------------------------------------------------ substitutions

/// The profile's `gcode_substitutions` rules. What they write is linted like any other custom
/// G-code, so a rule cannot slip `M500` or a heater past the limits into the file.
pub fn substitution_rules(cfg: &PrintConfig) -> crate::error::Result<Vec<crate::subst::Rule>> {
    let list: Vec<String> = match cfg.raw.get("gcode_substitutions") {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        _ => return Ok(Vec::new()),
    };
    let rules = crate::subst::rules(&list);
    for r in &rules {
        crate::preflight::vet_custom(crate::gcode_lint::Section::Other, &r.replace, cfg)?;
    }
    Ok(rules)
}

/// Applies the substitutions to a finished file; the second value names rules that could not run.
pub fn substitute(gcode: Vec<u8>, cfg: &PrintConfig) -> crate::error::Result<(Vec<u8>, Vec<String>)> {
    let rules = substitution_rules(cfg)?;
    if rules.is_empty() {
        return Ok((gcode, Vec::new()));
    }
    Ok(crate::subst::apply(&gcode, &rules))
}

// ------------------------------------------------------------ machine limits

/// The first entry of a list setting (normal mode; the second is silent mode), or the number.
fn first_number(cfg: &PrintConfig, key: &str) -> Option<f64> {
    match cfg.raw.get(key)? {
        serde_json::Value::Array(a) => a.first().and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        }),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        v => v.as_f64(),
    }
}

/// `M201`, `M203`, `M204` and `M205` with the machine's limits (Orca's `GCode::print_machine_envelope`), for a
/// profile that asks for them (`emit_machine_limits_to_gcode`, on by default) on Marlin and `RepRapFirmware`, so
/// the printer and the time estimate agree. A limit the profile lacks is left out. Marlin before 2 takes the
/// extruding acceleration for travel too; `RepRapFirmware` counts speeds and jerk in mm/min and uses `M566`.
pub fn machine_limits_lines(cfg: &PrintConfig, flavor: GcodeFlavor) -> String {
    let asked = match cfg.raw.get("machine_limits_usage") {
        Some(serde_json::Value::String(s)) => s == "emit_to_gcode",
        _ => truthy_or(cfg, "emit_machine_limits_to_gcode", true),
    };
    let marlin = matches!(flavor, GcodeFlavor::Marlin | GcodeFlavor::Marlin2);
    if !asked || !(marlin || flavor == GcodeFlavor::RepRapFirmware) {
        return String::new();
    }
    let factor = if flavor == GcodeFlavor::RepRapFirmware {
        60.0
    } else {
        1.0
    };
    let n = |k: &str| first_number(cfg, k);
    let axes = |prefix: &str, decimals: usize, scale: f64| -> Option<String> {
        let mut s = String::new();
        for (axis, key) in [("X", "x"), ("Y", "y"), ("Z", "z"), ("E", "e")] {
            let v = n(&format!("{prefix}_{key}"))? * scale;
            let _ = write!(s, " {axis}{v:.decimals$}");
        }
        Some(s)
    };
    let mut out = String::new();
    if let Some(a) = axes("machine_max_acceleration", 0, 1.0) {
        let _ = writeln!(out, "M201{a}");
    }
    if let Some(a) = axes("machine_max_speed", 0, factor) {
        let _ = writeln!(out, "M203{a}");
    }
    if let (Some(p), Some(r), Some(t)) = (
        n("machine_max_acceleration_extruding"),
        n("machine_max_acceleration_retracting"),
        n("machine_max_acceleration_travel"),
    ) {
        match flavor {
            GcodeFlavor::RepRapFirmware => {
                let _ = writeln!(out, "M204 P{p:.0} T{t:.0} ; sets acceleration (P, T), mm/sec^2");
            }
            GcodeFlavor::Marlin => {
                let _ = writeln!(out, "M204 P{p:.0} R{r:.0} T{p:.0}");
            }
            _ => {
                let _ = writeln!(
                    out,
                    "M204 P{p:.0} R{r:.0} T{t:.0} ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2"
                );
            }
        }
    }
    if let Some(a) = axes("machine_max_jerk", 2, factor) {
        if flavor == GcodeFlavor::RepRapFirmware {
            let _ = writeln!(out, "M566{a} ; sets the jerk limits, mm/min");
        } else {
            let _ = writeln!(out, "M205{a} ; sets the jerk limits, mm/sec");
        }
    }
    if flavor == GcodeFlavor::Marlin2
        && let Some(j) = n("machine_max_junction_deviation").filter(|j| *j > 0.0)
    {
        let _ = writeln!(out, "M205 J{j:.3}");
    }
    out
}

/// A boolean setting, or `default` when the profile does not carry it.
fn truthy_or(cfg: &PrintConfig, key: &str, default: bool) -> bool {
    if cfg.raw.contains_key(key) {
        truthy(cfg, key)
    } else {
        default
    }
}

// ------------------------------------------------------ progress and totals

/// Hosts join shards into one file, and one shard cannot know the time before
/// it or the filaments of the layers in other shards. Each layer therefore ends
/// with a `;@L` line (its time, its extrusion per slot and the slots its paths
/// print with) and the file ends with a `;@F` line (the constants for the
/// totals). [`finalize`] reads them once the file is whole, writes `M73`
/// progress, the header's filament list and the statistics footer, and removes
/// the marker lines. Left in place they are plain comments.
pub fn layer_marker(time_s: f32, e_units: &[i64], tools: &[u8]) -> String {
    let e: Vec<String> = e_units.iter().map(i64::to_string).collect();
    let t: Vec<String> = tools.iter().map(u8::to_string).collect();
    format!(";@L {time_s:.3} {} {}\n", e.join(","), t.join(","))
}

/// Where the thumbnails go: `;@T` with the sizes the profile asks for. Nothing when it asks for none.
pub fn thumbnail_marker(cfg: &PrintConfig) -> String {
    let (ok, _) = crate::thumbnail::specs(cfg);
    if ok.is_empty() {
        return String::new();
    }
    let list: Vec<String> = ok
        .iter()
        .map(|s| {
            format!(
                "{}x{}/{}",
                s.width,
                s.height,
                match s.format {
                    crate::thumbnail::Format::Png => "PNG",
                    crate::thumbnail::Format::Jpg => "JPG",
                    crate::thumbnail::Format::Qoi => "QOI",
                    crate::thumbnail::Format::BttTft => "BTT_TFT",
                }
            )
        })
        .collect();
    format!(";@T {}\n", list.join(","))
}

/// The closing marker: filament constants per slot and whether the printer takes `M73`.
pub fn footer_marker(cfg: &PrintConfig, tools: u8, layer_count: u32, flavor: GcodeFlavor) -> String {
    let slots = 1..=tools.max(1);
    let list = |f: &dyn Fn(u8) -> f64| {
        slots
            .clone()
            .map(|s| format!("{}", f(s)))
            .collect::<Vec<_>>()
            .join(",")
    };
    // Orca's G-code processor writes `M73 P R` whatever the flavor (its normal time machine is always on).
    // Ultimaker's firmware shows its own progress from the header's print time.
    let m73 = !truthy(cfg, "disable_m73") && !flavor.is_ultimaker();
    // Absolute extruder distances on a flavor that never resets the extruder: finalize carries it on.
    let carry = crate::gcode::absolute_e_mode(cfg)
        && matches!(
            flavor,
            GcodeFlavor::Mach3 | GcodeFlavor::MakerWare | GcodeFlavor::Sailfish
        );
    format!(
        ";@F diam={} density={} cost={} layers={layer_count} m73={}{}{}\n",
        cfg.filament_diameter,
        list(&|s| cfg.density(s)),
        list(&|s| cfg.cost_per_kg(s)),
        u8::from(m73),
        if carry { " ecarry=1" } else { "" },
        if bambu_printer(cfg, flavor) {
            " blocks=1"
        } else {
            ""
        }
    )
}

/// The settings as `; key = value` lines in key order, the way Orca writes its configuration block
/// (`GCode::append_full_config`, values serialized as `ConfigOption::serialize`): a switch as 1 or 0, a list of
/// numbers joined by commas, a list of points as `XxY` joined by commas, a list of texts joined by semicolons
/// with a text quoted when it holds a space, tab, quote, backslash or line break (`escape_strings_cstyle`),
/// and a single text with its line breaks, quotes and backslashes escaped (`escape_string_cstyle`). Escaping
/// keeps every value on its own comment line. A percent setting (Orca's `coPercent` and `coPercents`) given as
/// a number gets its `%`, as Orca writes it.
pub fn config_lines(cfg: &PrintConfig) -> String {
    const PERCENT_KEYS: &str = include_str!(concat!(env!("OUT_DIR"), "/percent_keys.txt"));
    fn escape(s: &str) -> String {
        let mut o = String::with_capacity(s.len());
        for ch in s.chars() {
            match ch {
                '\r' => o.push_str("\\r"),
                '\n' => o.push_str("\\n"),
                '\\' | '"' => {
                    o.push('\\');
                    o.push(ch);
                }
                c if c.is_control() => o.push(' '),
                c => o.push(c),
            }
        }
        o
    }
    fn scalar(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::Bool(b) => Some(if *b { "1" } else { "0" }.to_owned()),
            serde_json::Value::Number(n) => Some(match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{f:.0}"),
                Some(f) => format!("{f}"),
                None => n.to_string(),
            }),
            _ => None,
        }
    }
    let mut keys: Vec<&String> = cfg.raw.keys().collect();
    keys.sort_unstable();
    let mut out = String::new();
    for k in keys {
        let Some(v) = cfg.raw.get(k) else { continue };
        let value = match v {
            serde_json::Value::String(s) => escape(s),
            serde_json::Value::Array(items) => {
                if items.iter().all(|i| matches!(i, serde_json::Value::String(_))) {
                    let one = items.len() == 1;
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(|s| {
                            let quote = (one && s.is_empty())
                                || s.chars()
                                    .any(|c| matches!(c, ' ' | '\t' | '\\' | '"' | '\r' | '\n'));
                            if quote {
                                format!("\"{}\"", escape(s))
                            } else {
                                s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(";")
                } else if items
                    .iter()
                    .all(|i| matches!(i, serde_json::Value::Array(p) if p.len() == 2))
                {
                    items
                        .iter()
                        .filter_map(|i| match i {
                            serde_json::Value::Array(p) => {
                                Some(format!("{}x{}", scalar(p.first()?)?, scalar(p.get(1)?)?))
                            }
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(",")
                } else {
                    items.iter().filter_map(scalar).collect::<Vec<_>>().join(",")
                }
            }
            serde_json::Value::Null | serde_json::Value::Object(_) => continue,
            other => scalar(other).unwrap_or_default(),
        };
        let percent = PERCENT_KEYS.lines().any(|p| p == k.as_str());
        let value = match v {
            serde_json::Value::Number(_) if percent => format!("{value}%"),
            serde_json::Value::Array(items)
                if percent && !items.is_empty() && items.iter().all(serde_json::Value::is_number) =>
            {
                value
                    .split(',')
                    .map(|x| format!("{x}%"))
                    .collect::<Vec<_>>()
                    .join(",")
            }
            _ => value,
        };
        let key: String = k
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let _ = writeln!(out, "; {key} = {value}");
    }
    out
}

/// Time as slicers print it: `1d 2h 3m 4s`, leaving off the leading zero units.
pub fn format_time(total_s: f64) -> String {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a print lasts far less than 2^63 seconds"
    )]
    let t = total_s.max(0.0).round() as u64;
    let (d, h, m, s) = (t / 86_400, t % 86_400 / 3600, t % 3600 / 60, t % 60);
    if d > 0 {
        format!("{d}d {h}h {m}m {s}s")
    } else if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

struct Footer {
    diameter: f64,
    density: Vec<f64>,
    cost: Vec<f64>,
    m73: bool,
    e_carry: bool,
    /// Orca's block markers for a Bambu Lab printer: the file closes its executable block.
    blocks: bool,
}

fn num_list(v: &str) -> Vec<f64> {
    v.split(',').filter_map(|x| x.parse().ok()).collect()
}

fn parse_footer(line: &str) -> Footer {
    let mut f = Footer {
        diameter: 1.75,
        density: Vec::new(),
        cost: Vec::new(),
        m73: false,
        e_carry: false,
        blocks: false,
    };
    for kv in line.split_ascii_whitespace().skip(1) {
        match kv.split_once('=') {
            Some(("diam", v)) => f.diameter = v.parse().unwrap_or(1.75),
            Some(("density", v)) => f.density = num_list(v),
            Some(("cost", v)) => f.cost = num_list(v),
            Some(("m73", v)) => f.m73 = v == "1",
            Some(("ecarry", v)) => f.e_carry = v == "1",
            Some(("blocks", v)) => f.blocks = v == "1",
            _ => {}
        }
    }
    f
}

/// Writes `M73` progress and the statistics footer from the markers in a whole
/// file and removes them. A file without markers comes back unchanged.
pub fn finalize(gcode: &[u8]) -> Vec<u8> {
    finalize_with(gcode, None)
}

/// [`finalize`] with the image to write as thumbnails, when the profile asks for them.
pub fn finalize_with(gcode: &[u8], thumbnail: Option<&crate::thumbnail::Thumb>) -> Vec<u8> {
    finalize_with_config(gcode, thumbnail, None)
}

/// [`finalize_with`] that also renders the layers whose G-code reads the filament used so far
/// (`extruded_weight_total` and the like, see `weight.rs`), with the profile `cfg` when given.
/// Marks the start G-code carries for `print_time_sec` and `used_filament_length`; the finished file
/// has the print time (seconds) and the filament used (meters) in their place, as in Orca's G-code processor.
pub(crate) const TIME_MARK: &str = "_GP_PRINT_TIME_SEC_PLACEHOLDER";
pub(crate) const LENGTH_MARK: &str = "_GP_USED_FILAMENT_LENGTH_PLACEHOLDER";
/// The header line that becomes Bambu Lab's `; model printing time: ...; total estimated time: ...`
/// (Orca's `Estimated_Printing_Time_Placeholder`); the model time leaves out the time before the first layer.
pub(crate) const ESTIMATE_MARK: &str = ";_GP_ESTIMATED_PRINTING_TIME_PLACEHOLDER";
/// The header line that becomes Bambu Lab's `; filament: 1,2,...`, the slots the plate's paths print with.
/// The shard with the header holds only its own layers, so finalize writes it from every layer's `;@L` line.
pub(crate) const FILAMENT_MARK: &str = ";_SX_USED_FILAMENTS_PLACEHOLDER";

fn replace_mark(line: &[u8], mark: &str, text: &str) -> Option<Vec<u8>> {
    let m = mark.as_bytes();
    let at = line.windows(m.len()).position(|w| w == m)?;
    let mut v = Vec::with_capacity(line.len() + text.len());
    v.extend_from_slice(line.get(..at)?);
    v.extend_from_slice(text.as_bytes());
    v.extend_from_slice(line.get(at + m.len()..)?);
    Some(v)
}

/// `cfg` with the `filament_map` of the file's configuration block (`; filament_map = 2,1`), on a printer
/// with a filament map whose settings do not already carry that map.
fn map_from_gcode(gcode: &[u8], cfg: &crate::config::PrintConfig) -> Option<crate::config::PrintConfig> {
    if !crate::nozzles::shared(cfg) {
        return None;
    }
    let line = gcode
        .split(|&b| b == b'\n')
        .take_while(|l| !l.starts_with(b";LAYER_CHANGE"))
        .find_map(|l| l.strip_prefix(b"; filament_map = "))?;
    let map: Vec<serde_json::Value> = String::from_utf8_lossy(line)
        .split(',')
        .filter_map(|t| t.trim().parse::<u32>().ok())
        .map(|v| serde_json::json!(v))
        .collect();
    if map.is_empty() || cfg.raw.get("filament_map") == Some(&serde_json::Value::Array(map.clone())) {
        return None;
    }
    let mut c = cfg.clone();
    c.raw.insert("filament_map".into(), serde_json::Value::Array(map));
    Some(c)
}

pub fn finalize_with_config(
    gcode: &[u8],
    thumbnail: Option<&crate::thumbnail::Thumb>,
    cfg: Option<&crate::config::PrintConfig>,
) -> Vec<u8> {
    finalize_timed(gcode, thumbnail, cfg).0
}

/// How a finished file's print time divides: the part before the first layer (heating, homing, leveling, the
/// purge line: the start G-code) and each layer's own seconds, the last one with the end G-code. The two add
/// up to the time the footer states, so a preview that plays these times ends where the estimate does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Timing {
    pub prepare_s: f64,
    pub layer_s: Vec<f64>,
}

/// [`finalize_with_config`] that also returns the file's [`Timing`] (empty for a file without layer markers).
pub fn finalize_timed(
    gcode: &[u8],
    thumbnail: Option<&crate::thumbnail::Thumb>,
    cfg: Option<&crate::config::PrintConfig>,
) -> (Vec<u8>, Timing) {
    // Orca's preheat before tool changes needs the whole file (it looks back across layers).
    let preheated;
    let gcode = match cfg.filter(|c| crate::preheat::wanted(c)) {
        Some(c) => {
            preheated = crate::preheat::apply(gcode, c);
            preheated.as_slice()
        }
        None => gcode,
    };
    let mut times: Vec<f64> = Vec::new();
    let mut extruded: Vec<i64> = Vec::new();
    let mut per_layer: Vec<Vec<i64>> = Vec::new();
    let mut used = std::collections::BTreeSet::new();
    let mut footer: Option<Footer> = None;
    for line in gcode.split(|&b| b == b'\n') {
        if let Some(rest) = line.strip_prefix(b";@L ") {
            let text = String::from_utf8_lossy(rest);
            let mut it = text.split_ascii_whitespace();
            times.push(it.next().and_then(|t| t.parse().ok()).unwrap_or(0.0));
            per_layer.push(Vec::new());
            for (i, e) in it.next().unwrap_or("").split(',').enumerate() {
                let v: i64 = e.parse().unwrap_or(0);
                if let Some(l) = per_layer.last_mut() {
                    l.push(v);
                }
                if let Some(slot) = extruded.get_mut(i) {
                    *slot += v;
                } else {
                    extruded.push(v);
                }
            }
            used.extend(
                it.next()
                    .unwrap_or("")
                    .split(',')
                    .filter_map(|t| t.parse::<u8>().ok()),
            );
        } else if line.starts_with(b";@F ") && footer.is_none() {
            footer = Some(parse_footer(&String::from_utf8_lossy(line)));
        }
    }
    if times.is_empty() && footer.is_none() {
        return (gcode.to_vec(), Timing::default());
    }
    // With the settings at hand, the times come from reading the whole file the way Orca's G-code
    // processor does (`printtime`); the layer markers' own times are the fallback.
    let mut first_layer = times.first().copied().unwrap_or(0.0);
    // Seconds into the print at the end of each line, for progress after every move (Orca's
    // `GCodeProcessor::post_process`), and the time before the first layer (its `prepare_time`).
    let mut line_times: Vec<f64> = Vec::new();
    let mut prepare = 0.0;
    // The filament map the file was written with, from its configuration block, when the settings at hand
    // leave the engine's pick out (the shards of a slice are finished with the request's own settings).
    let mapped = cfg.and_then(|c| map_from_gcode(gcode, c));
    if let Some(c) = mapped.as_ref().or(cfg) {
        let est = crate::printtime::estimate(gcode, c, true);
        if let Some(i) = gcode
            .split(|&b| b == b'\n')
            .position(|l| l.starts_with(b";LAYER_CHANGE"))
        {
            prepare = est.lines.get(i).copied().unwrap_or(0.0);
        }
        line_times = est.lines;
        let n = times.len();
        for (i, t) in times.iter_mut().enumerate() {
            *t = est.segments.get(i).copied().unwrap_or(0.0);
            // What follows the last marker (the end G-code) counts with the last layer.
            if i + 1 == n {
                *t += est.segments.iter().skip(n).sum::<f64>();
            }
        }
        first_layer = est.first_layer;
    }
    let total: f64 = times.iter().sum();
    // The first layer's time as read from the file runs from the top of the file, the start G-code included.
    let timing = Timing {
        prepare_s: prepare.min(times.first().copied().unwrap_or(0.0)),
        layer_s: times
            .iter()
            .enumerate()
            .map(|(i, &t)| if i == 0 { (t - prepare).max(0.0) } else { t })
            .collect(),
    };
    let footer = footer.unwrap_or(Footer {
        diameter: 1.75,
        density: Vec::new(),
        cost: Vec::new(),
        m73: false,
        e_carry: false,
        blocks: false,
    });
    let carried;
    let gcode = if footer.e_carry {
        carried = crate::gcode::carry_e(gcode);
        carried.as_slice()
    } else {
        gcode
    };
    // Ultimaker's header: the print time, filament volumes, extent and slice id only the whole file knows.
    let griffin = crate::griffin::has_header(gcode).then(|| {
        let area = std::f64::consts::PI * (footer.diameter / 2.0).m_powi(2);
        let (min, max) = crate::griffin::extent(gcode);
        #[allow(clippy::cast_precision_loss, reason = "extrusion totals stay far below 2^52")]
        crate::griffin::Totals {
            time_s: total,
            volume: extruded.iter().map(|&e| e as f64 / 1e5 * area).collect(),
            used: used.clone(),
            min,
            max,
            uuid: crate::griffin::uuid(gcode),
        }
    });
    let mut in_head = griffin.is_some();
    let mut out = Vec::with_capacity(gcode.len() + times.len() * 16 + 512);
    let (mut layer, mut done) = (0usize, 0.0f64);
    let mut last = (u32::MAX, u32::MAX);
    let mut lines = gcode.split(|&b| b == b'\n').enumerate().peekable();
    // Orca's progress pair: the share done, rounded down, and the minutes left (`time_in_minutes`).
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a percentage and minutes"
    )]
    let progress = |done: f64| -> (u32, u32) {
        (
            ((done / total * 100.0).floor() as u32).min(100),
            ((total - done).max(0.0) + 0.5).div_euclid(60.0) as u32,
        )
    };
    let per_move = footer.m73 && total > 0.0 && !line_times.is_empty();
    while let Some((li, line)) = lines.next() {
        // The piece after the final newline has none of its own.
        let newline = lines.peek().is_some();
        if line.starts_with(b";@L ") {
            continue;
        }
        if let Some(t) = griffin.as_ref().filter(|_| in_head) {
            if line.starts_with(b";LAYER_CHANGE") {
                in_head = false;
            } else if line.windows(3).any(|w| w == b";@U")
                || line
                    .windows(crate::griffin::MARK.len())
                    .any(|w| w == crate::griffin::MARK.as_bytes())
            {
                if let Some(v) = crate::griffin::fill(line, t) {
                    out.extend_from_slice(&v);
                    if newline {
                        out.push(b'\n');
                    }
                }
                continue;
            }
        }
        if line == b";@P" {
            // The first progress line, at the top of the executable block.
            if footer.m73 && total > 0.0 {
                let (_, r) = progress(0.0);
                write_line(&mut out, &format!("M73 P0 R{r}"));
                last = (0, r);
            }
            continue;
        }
        if line == FILAMENT_MARK.as_bytes() {
            let list: Vec<String> = used.iter().map(u8::to_string).collect();
            let list = if list.is_empty() {
                "1".to_owned()
            } else {
                list.join(",")
            };
            write_line(&mut out, &format!("; filament: {list}"));
            continue;
        }
        if line == ESTIMATE_MARK.as_bytes() {
            write_line(
                &mut out,
                &format!(
                    "; model printing time: {}; total estimated time: {}",
                    format_time(total - prepare),
                    format_time(total)
                ),
            );
            write_line(
                &mut out,
                &format!(
                    "; estimated first layer printing time (normal mode) = {}",
                    format_time(prepare)
                ),
            );
            continue;
        }
        if let Some(doc) = line.strip_prefix(crate::weight::MARKER) {
            // Filament used before this layer: the layers counted so far, less the one just opened.
            let before = layer.saturating_sub(1);
            let area = std::f64::consts::PI * (footer.diameter / 2.0).m_powi(2);
            let slots = per_layer.iter().map(Vec::len).max().unwrap_or(0);
            let (mut weight, mut volume) = (vec![0.0; slots], vec![0.0; slots]);
            for l in per_layer.iter().take(before) {
                for (i, &e) in l.iter().enumerate() {
                    #[allow(clippy::cast_precision_loss, reason = "extrusion totals stay far below 2^52")]
                    let v = e as f64 / 1e5 * area;
                    let density = footer
                        .density
                        .get(i)
                        .or(footer.density.last())
                        .copied()
                        .unwrap_or(crate::config::DEFAULT_DENSITY);
                    if let (Some(w), Some(vol)) = (weight.get_mut(i), volume.get_mut(i)) {
                        *vol += v;
                        *w += v * density * 0.001;
                    }
                }
            }
            let used = crate::weight::Used { weight, volume };
            out.extend_from_slice(
                crate::weight::render(&String::from_utf8_lossy(doc), &used, cfg).as_bytes(),
            );
            continue;
        }
        if let Some(rest) = line.strip_prefix(b";@T ") {
            if let Some(img) = thumbnail {
                let list: Vec<String> = String::from_utf8_lossy(rest)
                    .split(',')
                    .map(str::to_owned)
                    .collect();
                let (specs, _) = crate::thumbnail::parse_specs(&list, "PNG");
                out.extend_from_slice(crate::thumbnail::comment_blocks(&specs, img).as_bytes());
            }
            continue;
        }
        if line.starts_with(b";@F ") {
            if footer.m73 {
                write_line(&mut out, "M73 P100 R0");
            }
            if footer.blocks {
                write_line(&mut out, "; EXECUTABLE_BLOCK_END");
                write_line(&mut out, "");
            }
            out.extend_from_slice(stats_block(&extruded, &footer, layer, total, first_layer).as_bytes());
            continue;
        }
        if line.starts_with(b";LAYER_CHANGE") {
            if footer.m73 && total > 0.0 && !per_move {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a percentage and minutes"
                )]
                let (p, r) = (
                    ((done / total * 100.0).floor() as u32).min(99),
                    ((total - done).max(0.0) / 60.0).floor() as u32,
                );
                if (p, r) != last {
                    write_line(&mut out, &format!("M73 P{p} R{r}"));
                    last = (p, r);
                }
            }
            done += times.get(layer).copied().unwrap_or(0.0);
            layer += 1;
        }
        if line.windows(4).any(|w| w == b"_GP_") {
            let mut v = line.to_vec();
            #[allow(clippy::cast_precision_loss, reason = "extrusion totals stay far below 2^52")]
            let used_mm: f64 = extruded.iter().map(|&e| e as f64 / 1e5).sum();
            for (mark, text) in [
                (TIME_MARK, format!("{total:.2}")),
                (LENGTH_MARK, format!("{:.2}", used_mm / 1000.0)),
            ] {
                while let Some(r) = replace_mark(&v, mark, &text) {
                    v = r;
                }
            }
            out.extend_from_slice(&v);
        } else if let Some(tag) = footer.blocks.then(|| bbl_tag(line)).flatten() {
            out.extend_from_slice(&tag);
        } else {
            out.extend_from_slice(line);
        }
        if newline {
            out.push(b'\n');
        }
        // Progress after every move whose pair changed, as Orca's post-processing writes it.
        if per_move
            && matches!(line.get(..3), Some(b"G0 " | b"G1 " | b"G2 " | b"G3 "))
            && let Some(&at) = line_times.get(li)
        {
            let pair = progress(at);
            if pair != last {
                write_line(&mut out, &format!("M73 P{} R{}", pair.0, pair.1));
                last = pair;
            }
        }
    }
    (out, timing)
}

/// `gcode_add_line_number` (Orca's `gcode_add_line_number` in GCode/PostProcessor.cpp): every command line
/// gets `N<n> ` in front, counting from 1. Unlike Orca, comment and empty lines are left as they are and not
/// counted, as G-code line numbers go on commands only.
pub fn number_lines(gcode: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(gcode.len() + gcode.len() / 4);
    let mut n: u64 = 0;
    let mut lines = gcode.split(|&b| b == b'\n').peekable();
    while let Some(line) = lines.next() {
        let body = line.trim_ascii_start();
        if !body.is_empty() && !body.starts_with(b";") {
            n += 1;
            out.push(b'N');
            out.extend_from_slice(n.to_string().as_bytes());
            out.push(b' ');
        }
        out.extend_from_slice(line);
        if lines.peek().is_some() {
            out.push(b'\n');
        }
    }
    out
}

/// The print time a finished file's footer states, seconds (`; estimated printing time (normal mode)`).
pub fn footer_time(gcode: &[u8]) -> Option<f64> {
    let key = b"; estimated printing time (normal mode) = ";
    let tail = gcode.get(gcode.len().saturating_sub(4096)..)?;
    let at = tail.windows(key.len()).rposition(|w| w == key)?;
    let text = String::from_utf8_lossy(tail.get(at + key.len()..)?);
    let line = text.lines().next()?;
    let mut t = 0.0;
    for part in line.split_ascii_whitespace() {
        let (n, unit) = part.split_at(part.len().saturating_sub(1));
        let n: f64 = n.parse().ok()?;
        t += n * match unit {
            "d" => 86_400.0,
            "h" => 3600.0,
            "m" => 60.0,
            "s" => 1.0,
            _ => return None,
        };
    }
    Some(t)
}

/// the processor tags orca writes for a bambu lab printer (`GCodeProcessor::Reserved_Tags`) in place of
/// the compatible ones the writer uses, and `; Z_HEIGHT:` from `GCode::change_layer`
fn bbl_tag(line: &[u8]) -> Option<Vec<u8>> {
    const TAGS: [(&[u8], &[u8]); 9] = [
        (b";LAYER_CHANGE", b"; CHANGE_LAYER"),
        (b";Z:", b"; Z_HEIGHT: "),
        (b";HEIGHT:", b"; LAYER_HEIGHT: "),
        (b";TYPE:", b"; FEATURE: "),
        (b";WIDTH:", b"; LINE_WIDTH: "),
        (b";WIPE_START", b"; WIPE_START"),
        (b";WIPE_END", b"; WIPE_END"),
        (b";COLOR_CHANGE", b"; COLOR_CHANGE"),
        (b";PAUSE_PRINT", b"; PAUSE_PRINTING"),
    ];
    if line.first() != Some(&b';') {
        return None;
    }
    let (from, to) = TAGS.iter().find(|(from, _)| line.starts_with(from))?;
    let mut v = to.to_vec();
    v.extend_from_slice(line.get(from.len()..)?);
    Some(v)
}

fn write_line(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
    out.push(b'\n');
}

fn stats_block(extruded: &[i64], f: &Footer, layers: usize, total: f64, first: f64) -> String {
    let area = std::f64::consts::PI * (f.diameter / 2.0).m_powi(2);
    let (mut mm, mut cm3, mut grams, mut cost) = (Vec::new(), Vec::new(), Vec::new(), 0.0);
    for (i, &e) in extruded.iter().enumerate() {
        #[allow(clippy::cast_precision_loss, reason = "extrusion totals stay far below 2^52")]
        let len = e as f64 / 1e5;
        let volume = len * area / 1000.0;
        let g = volume
            * f.density
                .get(i)
                .or(f.density.last())
                .copied()
                .unwrap_or(crate::config::DEFAULT_DENSITY);
        cost += g / 1000.0 * f.cost.get(i).or(f.cost.last()).copied().unwrap_or(0.0);
        mm.push(len);
        cm3.push(volume);
        grams.push(g);
    }
    let join = |v: &[f64]| v.iter().map(|x| format!("{x:.2}")).collect::<Vec<_>>().join(", ");
    let mut s = String::new();
    let _ = writeln!(s, "; filament used [mm] = {}", join(&mm));
    let _ = writeln!(s, "; filament used [cm3] = {}", join(&cm3));
    let _ = writeln!(s, "; filament used [g] = {}", join(&grams));
    let _ = writeln!(s, "; total filament used [g] = {:.2}", grams.iter().sum::<f64>());
    let _ = writeln!(s, "; total filament cost = {cost:.2}");
    let _ = writeln!(s, "; total layers count = {layers}");
    let _ = writeln!(
        s,
        "; estimated printing time (normal mode) = {}",
        format_time(total)
    );
    let _ = writeln!(
        s,
        "; estimated first layer printing time (normal mode) = {}",
        format_time(first)
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_reads_like_a_slicer_footer() {
        assert_eq!(format_time(709.0), "11m 49s");
        assert_eq!(format_time(1.0), "1s");
        assert_eq!(format_time(3723.0), "1h 2m 3s");
        assert_eq!(format_time(90_061.0), "1d 1h 1m 1s");
    }

    #[test]
    fn finalize_writes_progress_and_totals_and_drops_the_markers() {
        let cfg = PrintConfig::default();
        let mut g = String::from("; header\nG28\n");
        for i in 0..3 {
            let _ = write!(g, ";LAYER_CHANGE\n;Z:{}\nG1 X1 Y1 E1\n", i + 1);
            g += &layer_marker(120.0, &[100_000], &[1]);
        }
        g += "M104 S0\n";
        g += &footer_marker(&cfg, 1, 3, GcodeFlavor::Marlin2);
        let out = String::from_utf8(finalize(g.as_bytes())).unwrap();
        assert!(!out.contains(";@"), "{out}");
        assert!(out.contains("M73 P0 R6\n;LAYER_CHANGE"));
        assert!(out.contains("M73 P33 R4\n") && out.contains("M73 P66 R2\n"));
        assert!(out.contains("M104 S0\nM73 P100 R0\n; filament used [mm] = 3.00\n"));
        assert!(out.contains("; total layers count = 3\n; estimated printing time (normal mode) = 6m 0s\n"));
        assert!(
            out.ends_with("first layer printing time (normal mode) = 2m 0s\n"),
            "{out}"
        );
        assert_eq!(finalize(b"G28\n"), b"G28\n");
    }

    #[test]
    fn m73_on_every_flavor_unless_disabled() {
        let mut cfg = PrintConfig::default();
        assert!(footer_marker(&cfg, 1, 1, GcodeFlavor::Klipper).contains("m73=1"));
        assert!(footer_marker(&cfg, 1, 1, GcodeFlavor::RepRapFirmware).contains("m73=1"));
        cfg.raw.insert("disable_m73".into(), serde_json::json!(true));
        assert!(footer_marker(&cfg, 1, 1, GcodeFlavor::Marlin2).contains("m73=0"));
    }

    #[test]
    fn machine_limits_are_written_only_when_asked_on_marlin() {
        let mut cfg = PrintConfig::default();
        for (k, v) in [
            ("machine_max_acceleration_x", serde_json::json!(["1000", "1000"])),
            ("machine_max_acceleration_y", serde_json::json!(["1000", "1000"])),
            ("machine_max_acceleration_z", serde_json::json!(["500", "200"])),
            ("machine_max_acceleration_e", serde_json::json!(["5000", "5000"])),
            ("machine_max_speed_x", serde_json::json!(["500", "200"])),
            ("machine_max_speed_y", serde_json::json!(["500", "200"])),
            ("machine_max_speed_z", serde_json::json!(["12", "12"])),
            ("machine_max_speed_e", serde_json::json!(["120", "120"])),
            (
                "machine_max_acceleration_extruding",
                serde_json::json!(["10000", "10000"]),
            ),
            (
                "machine_max_acceleration_retracting",
                serde_json::json!(["1500", "1500"]),
            ),
            (
                "machine_max_acceleration_travel",
                serde_json::json!(["10000", "10000"]),
            ),
            ("machine_max_jerk_x", serde_json::json!(["10", "10"])),
            ("machine_max_jerk_y", serde_json::json!(["10", "10"])),
            ("machine_max_jerk_z", serde_json::json!(["0.2", "0.4"])),
            ("machine_max_jerk_e", serde_json::json!(["2.5", "2.5"])),
            ("machine_max_junction_deviation", serde_json::json!(["0.01"])),
        ] {
            cfg.raw.insert(k.into(), v);
        }
        // Orca's `emit_machine_limits_to_gcode` is on by default; off, nothing is written.
        let marlin2 = "M201 X1000 Y1000 Z500 E5000\nM203 X500 Y500 Z12 E120\nM204 P10000 R1500 T10000 ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2\nM205 X10.00 Y10.00 Z0.20 E2.50 ; sets the jerk limits, mm/sec\nM205 J0.010\n";
        assert_eq!(machine_limits_lines(&cfg, GcodeFlavor::Marlin2), marlin2);
        cfg.raw
            .insert("emit_machine_limits_to_gcode".into(), serde_json::json!("0"));
        assert_eq!(machine_limits_lines(&cfg, GcodeFlavor::Marlin2), "");
        cfg.raw
            .insert("emit_machine_limits_to_gcode".into(), serde_json::json!("1"));
        assert_eq!(machine_limits_lines(&cfg, GcodeFlavor::Marlin2), marlin2);
        assert_eq!(machine_limits_lines(&cfg, GcodeFlavor::Klipper), "");
        // Marlin before 2 uses the extruding acceleration for travel and has no junction deviation line.
        assert_eq!(
            machine_limits_lines(&cfg, GcodeFlavor::Marlin),
            "M201 X1000 Y1000 Z500 E5000\nM203 X500 Y500 Z12 E120\nM204 P10000 R1500 T10000\nM205 X10.00 Y10.00 Z0.20 E2.50 ; sets the jerk limits, mm/sec\n"
        );
        // RepRapFirmware counts speeds and jerk per minute.
        assert_eq!(
            machine_limits_lines(&cfg, GcodeFlavor::RepRapFirmware),
            "M201 X1000 Y1000 Z500 E5000\nM203 X30000 Y30000 Z720 E7200\nM204 P10000 T10000 ; sets acceleration (P, T), mm/sec^2\nM566 X600.00 Y600.00 Z12.00 E150.00 ; sets the jerk limits, mm/min\n"
        );
    }

    #[test]
    #[allow(clippy::unreadable_literal, reason = "the values are printf cases")]
    fn fmt_g_matches_printf() {
        for (v, want) in [
            (118.0, "118"),
            (138.6734, "138.673"),
            (160.8516, "160.852"),
            (0.5, "0.5"),
            (83.78521, "83.7852"),
            (-3.25, "-3.25"),
            (1234567.0, "1.23457e+06"),
            (0.000012345, "1.2345e-05"),
            (100000.0, "100000"),
        ] {
            assert_eq!(fmt_g(v), want, "{v}");
        }
    }

    #[test]
    fn hull_of_a_square_with_interior_points() {
        let h = convex_hull(vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [0.0, 10.0],
            [5.0, 5.0],
            [5.0, 0.0],
        ]);
        assert_eq!(h.len(), 4);
        assert!((area(&h) - 100.0).abs() < 1e-9);
    }

    fn square(name: &str, x: f64, y: f64) -> ObjectFootprint {
        ObjectFootprint {
            id: name.into(),
            name: name.into(),
            hull: vec![[x, y], [x + 20.0, y], [x + 20.0, y + 20.0], [x, y + 20.0]],
            center: [x + 10.0, y + 10.0],
        }
    }

    #[test]
    fn paths_map_to_their_object_and_brim_to_none() {
        let objs = [square("a b.stl", 0.0, 0.0), square("c.stl", 40.0, 0.0)];
        let mut cfg = PrintConfig::default();
        cfg.raw.insert("exclude_object".into(), serde_json::json!(true));
        let l = Labels::new(&objs, &cfg, GcodeFlavor::Klipper).unwrap();
        assert_eq!(l.object_of(Point::from_mm(5.0, 5.0), Feature::OuterWall), Some(0));
        assert_eq!(
            l.object_of(Point::from_mm(50.0, 5.0), Feature::SparseInfill),
            Some(1)
        );
        assert_eq!(l.object_of(Point::from_mm(5.0, 5.0), Feature::Brim), None);
        assert_eq!(l.object_of(Point::from_mm(30.0, 5.0), Feature::OuterWall), None);
        assert_eq!(l.object_of(Point::from_mm(21.5, 5.0), Feature::Support), Some(0));
        let h = l.header();
        assert!(h.starts_with("EXCLUDE_OBJECT_DEFINE NAME=a_b.stl_id_0_copy_0 CENTER=10,10 POLYGON=[[0,0],[20,0],[20,20],[0,20],[0,0]]"), "{h}");
        assert_eq!(
            l.fw_start(1).as_deref(),
            Some("EXCLUDE_OBJECT_START NAME=c.stl_id_1_copy_0\n")
        );
    }

    #[test]
    fn bambu_uses_m624_with_a_base64_mask() {
        let objs = [square("a.stl", 0.0, 0.0), square("b.stl", 40.0, 0.0)];
        let mut cfg = PrintConfig::default();
        let l = Labels::new(&objs, &cfg, GcodeFlavor::Bambu).unwrap();
        assert_eq!(l.header(), "");
        assert_eq!(l.id_list().as_deref(), Some("; model label id: 1,2\n"));
        // Label ids count from 1; the mask has the bit of the object's place in the id list.
        assert_eq!(
            l.fw_start(0).as_deref(),
            Some("; start printing object, unique label id: 1\nM624 AQAAAAAAAAA=\n")
        );
        assert_eq!(
            l.fw_start(1).as_deref(),
            Some("; start printing object, unique label id: 2\nM624 AgAAAAAAAAA=\n")
        );
        assert_eq!(
            l.fw_end(1).as_deref(),
            Some("; stop printing object, unique label id: 2\nM625\n")
        );
        // A Bambu Lab preset says marlin; the printer model decides, and `exclude_object` is not needed.
        cfg.raw
            .insert("printer_model".into(), serde_json::json!("Bambu Lab X1 Carbon"));
        let m = Labels::new(&objs, &cfg, GcodeFlavor::Marlin).unwrap();
        assert_eq!(m.header(), "");
        assert_eq!(
            m.fw_end(0).as_deref(),
            Some("; stop printing object, unique label id: 1\nM625\n")
        );
        assert_eq!(m.comment_start(0), None);
        // The timelapse block of a layer carries the mask of the layer's objects.
        let both: std::collections::BTreeSet<usize> = [0, 1].into_iter().collect();
        assert_eq!(
            m.layer_wrap(4, &both),
            Some((
                "; object ids of layer 5 start: 1,2\nM624 AwAAAAAAAAA=\n".to_owned(),
                "; object ids of this layer5 end: 1,2\nM625\n".to_owned()
            ))
        );
        assert_eq!(m.layer_wrap(4, &std::collections::BTreeSet::new()), None);
        // More objects than the mask holds: no firmware labels.
        let many: Vec<ObjectFootprint> = (0..65).map(|i| square("p", f64::from(i) * 30.0, 0.0)).collect();
        assert!(Labels::new(&many, &cfg, GcodeFlavor::Marlin).is_none());
        // Another printer with marlin gets none unless asked.
        let plain = PrintConfig::default();
        assert!(Labels::new(&objs, &plain, GcodeFlavor::Marlin).is_none());
    }

    #[test]
    fn marlin_uses_m486_and_no_labels_when_off() {
        let objs = [square("a.stl", 0.0, 0.0)];
        let mut cfg = PrintConfig::default();
        assert!(Labels::new(&objs, &cfg, GcodeFlavor::Marlin2).is_none());
        cfg.raw.insert("exclude_object".into(), serde_json::json!("1"));
        let l = Labels::new(&objs, &cfg, GcodeFlavor::Marlin2).unwrap();
        assert_eq!(l.header(), "M486 S0\nM486 Aa.stl_id_0_copy_0\nM486 S-1\n");
        assert_eq!(l.fw_start(0).as_deref(), Some("M486 S0\n"));
        assert_eq!(l.fw_end(0).as_deref(), Some("M486 S-1\n"));
        // RepRapFirmware names the object on the start line.
        let rrf = Labels::new(&objs, &cfg, GcodeFlavor::RepRapFirmware).unwrap();
        assert_eq!(rrf.header(), "M486 S0 A\"a.stl_id_0_copy_0\"\nM486 S-1\n");
        assert_eq!(rrf.fw_start(0).as_deref(), Some("M486 S0\n"));
        assert!(Labels::new(&objs, &cfg, GcodeFlavor::Smoothie).is_none());
    }
}
