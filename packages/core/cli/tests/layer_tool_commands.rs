// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tool commands at layer changes. A tool command goes out only when the filament changes: a plate that prints
//! one filament from any slot selects it once, in the start G-code, and no layer selects it again, with the prime
//! tower on or off, by layer or by object. Every real change still runs the printer's change G-code (on a Bambu
//! Lab printer the AMS block, `M620 S<n>A` to `M621 S<n>A`) with the new tool inside it.
//!
//! The projects in tests/fixtures/layer-tools are a 20 x 20 x 10 mm box (50 layers of 0.2 mm) on stock A1 and P1S
//! settings with 5 filaments (flush volume 200 between any two). Each name says what the plate holds: `s<n>` one
//! box on filament n, `s4x2` two boxes on filament 4, `two` boxes on filaments 2 and 4, `off` with the prime tower
//! off, `byobj` printed by object.

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/layer-tools")
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(case: &str) -> TempDir {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = TempDir(std::env::temp_dir().join(format!("sx-layer-tools-{case}-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    dir
}

/// The G-code of a project's first plate.
fn slice(case: &str) -> String {
    let dir = temp_dir(case);
    let out = dir.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixtures().join(format!("{case}.3mf")))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{case}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// Where a tool command sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    /// Before the first layer change.
    Start,
    /// The layers.
    Body,
    /// From the machine end G-code on.
    End,
}

/// One tool command (`T<n>`, n under 255): where it sits, its layer (1-based, 0 in the start), the `M620 S<n>A`
/// block around it if any, and whether the tool was already the active one.
#[derive(Debug, Clone, Copy)]
struct Select {
    part: Part,
    layer: u32,
    tool: u32,
    wrap: Option<u32>,
    redundant: bool,
}

/// The `n` of a line that is `<prefix><n>` and an optional `A` (comments and spaces left out).
fn number_after(line: &str, prefix: &str) -> Option<u32> {
    let code = line.split(';').next().unwrap_or("").trim();
    let rest = code.strip_prefix(prefix)?;
    rest.strip_suffix('A').unwrap_or(rest).parse().ok()
}

fn selects(gcode: &str) -> Vec<Select> {
    let mut v = Vec::new();
    let (mut part, mut layer) = (Part::Start, 0u32);
    let mut wrap: Option<u32> = None;
    let mut active: Option<u32> = None;
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") {
            part = Part::Body;
            layer += 1;
        } else if line.starts_with("; MACHINE_END_GCODE_START") {
            part = Part::End;
        }
        if let Some(n) = number_after(line, "M620 S") {
            wrap = Some(n);
            continue;
        }
        if number_after(line, "M621 S").is_some() {
            wrap = None;
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let Some(t) = code
            .strip_prefix('T')
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|&t| t < 255)
        else {
            continue;
        };
        v.push(Select {
            part,
            layer,
            tool: t,
            wrap,
            redundant: active == Some(t),
        });
        active = Some(t);
    }
    v
}

/// The body's tool commands of a project and how many commands in the whole file select the tool already
/// active, after checking the start: one `T<k>` inside `M620 S<k>A`, for the plate's first filament (0-based
/// `k`).
fn body(case: &str, first: u32) -> (Vec<Select>, usize) {
    let all = selects(&slice(case));
    let start: Vec<&Select> = all.iter().filter(|s| s.part == Part::Start).collect();
    assert_eq!(start.len(), 1, "{case}: start selects {start:?}");
    assert_eq!(
        (start[0].tool, start[0].wrap),
        (first, Some(first)),
        "{case}: start select"
    );
    let redundant = all.iter().filter(|s| s.redundant).count();
    (
        all.into_iter().filter(|s| s.part == Part::Body).collect(),
        redundant,
    )
}

/// Per case: the layers' tool commands, and those that select the active tool.
fn one_filament(cases: &[(&'static str, u32)]) {
    let got: Vec<(&str, usize, usize)> = cases
        .iter()
        .map(|&(case, first)| {
            let (b, redundant) = body(case, first);
            (case, b.len(), redundant)
        })
        .collect();
    let want: Vec<(&str, usize, usize)> = cases.iter().map(|&(case, _)| (case, 0, 0)).collect();
    assert_eq!(got, want);
}

#[test]
fn one_filament_from_any_slot_is_selected_once_in_the_start() {
    one_filament(&[
        ("a1-s1", 0),
        ("a1-s2", 1),
        ("a1-s4", 3),
        ("a1-s4off", 3),
        ("a1-s4x2", 3),
        ("p1s-s4", 3),
        ("p1s-s4off", 3),
    ]);
}

#[test]
fn one_filament_by_object_is_selected_once_in_the_start() {
    one_filament(&[("a1-s4byobj", 3)]);
}

#[test]
fn two_filaments_change_on_every_layer_inside_the_change_gcode() {
    for case in ["a1-two", "a1-twooff", "p1s-two"] {
        let (b, redundant) = body(case, 1);
        assert_eq!(redundant, 0, "{case}");
        let bare: Vec<&Select> = b.iter().filter(|s| s.wrap != Some(s.tool)).collect();
        assert!(bare.is_empty(), "{case}: unwrapped selects {bare:?}");
        let to = |t: u32| b.iter().filter(|s| s.tool == t).count();
        assert_eq!((b.len(), to(3), to(1)), (50, 25, 25), "{case}");
        // One change per layer, the layer starting on the filament the layer below ended on.
        for (k, s) in b.iter().enumerate() {
            assert_eq!(s.layer, u32::try_from(k).unwrap() + 1, "{case}: {s:?}");
        }
    }
}

#[test]
fn two_filaments_by_object_change_once_inside_the_change_gcode() {
    let (b, redundant) = body("a1-twobyobj", 1);
    assert_eq!(redundant, 0);
    assert_eq!(b.len(), 1, "{b:?}");
    assert_eq!((b[0].tool, b[0].wrap), (3, Some(3)), "{b:?}");
}

/// A request without the printer's start G-code: the first layer selects the filament itself, with a bare tool
/// command, and no layer after it selects it again.
#[test]
fn a_request_without_a_start_selects_the_filament_on_the_first_layer_only() {
    let dir = temp_dir("request");
    let mut got = Vec::new();
    for tower in ["1", "0"] {
        let req = serde_json::json!({
            "schemaVersion": 1,
            "meshes": {"m": format!("{}#1", fixtures().join("p1s-s4.3mf").display())},
            "plate": {"objects": [{"id": "m", "mesh": "m", "settings": {"extruder": 4}}]},
            "config": {
                "printer_model": "Bambu Lab P1S",
                "filament_colour": ["#FFFFFF", "#FF0000", "#00A0FF", "#202020", "#F0C000"],
                "enable_prime_tower": tower,
                "layer_height": "0.2",
                "initial_layer_print_height": "0.2",
            },
            "options": {"emitGcode": true},
        });
        let file = dir.0.join(format!("request-{tower}.json"));
        std::fs::write(&file, req.to_string()).unwrap();
        let out = dir.0.join(format!("out-{tower}"));
        let o = Command::new(env!("CARGO_BIN_EXE_sx"))
            .args(["slice", "--request"])
            .arg(&file)
            .arg("--out-dir")
            .arg(&out)
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "tower {tower}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        let gcode = std::fs::read_to_string(out.join("slice.gcode")).unwrap();
        let all = selects(&gcode);
        // (tower, tool commands, the first one's layer, tool and M620 block)
        got.push((tower, all.len(), all.first().map(|s| (s.layer, s.tool, s.wrap))));
    }
    assert_eq!(
        got,
        vec![("1", 1, Some((1, 3, None))), ("0", 1, Some((1, 3, None)))]
    );
}
