// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A color change a project marks at a height (`Metadata/custom_gcode_per_layer.xml`, type 0) stops the print with
//! the printer's pause G-code (`M400 U1` on a Bambu Lab A1 or P1S) at the start of the first layer whose top reaches
//! the height, so the filament can be swapped by hand. Nothing else in the file changes: no `M600`, no added fan
//! line, and the layer keeps its usual lift. It does so whatever filament the mark names and on plates of one, two
//! or five filaments, and a plate printed by object stops once for each object at that height.
//!
//! The projects in tests/fixtures/color-change are the 20 x 20 x 10 mm box of tests/fixtures/layer-tools (50 layers
//! of 0.2 mm, stock A1 and P1S settings) with a color change at 5.0 mm (layer 25), and the same plates without it.
//! `f1` is one box on a plate of one filament, `f2` one box on filament 2 of two, `f5` one box on filament 4 of five
//! (`f5off`: prime tower off, `f5other`: the mark names filament 2), `two` boxes on filaments 2 and 4 of five, and
//! `byobj` two boxes on filament 4 printed by object. A name ending in `cc` has the mark (`byobjpause` has a pause,
//! type 1, instead); `f5`, `f5off`, `two` and `byobj` are compared with the layer-tools plates they were made from.

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixture(dir: &str, case: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(dir)
        .join(format!("{case}.3mf"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The G-code of a project's first plate.
fn slice(project: &Path) -> String {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = TempDir(std::env::temp_dir().join(format!("sx-color-change-{}-{n}", std::process::id())));
    std::fs::create_dir_all(&tmp.0).unwrap();
    let out = tmp.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(project)
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{}: {}",
        project.display(),
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// A line's command, comment and spaces left out.
fn code(line: &str) -> &str {
    line.split(';').next().unwrap_or("").trim()
}

/// The layers (1-based, counted through the whole file) whose lines include the command `cmd`.
fn layers_with(gcode: &str, cmd: &str) -> Vec<u32> {
    let mut layer = 0u32;
    let mut out = Vec::new();
    for line in gcode.lines() {
        if line.starts_with("; CHANGE_LAYER") || line.starts_with(";LAYER_CHANGE") {
            layer += 1;
        } else if code(line) == cmd {
            out.push(layer);
        }
    }
    out
}

/// The lines of a G-code without its progress lines (`M73`), which move with the time a pause adds.
fn without_progress(gcode: &str) -> Vec<&str> {
    gcode.lines().filter(|l| !l.starts_with("M73 ")).collect()
}

fn count(gcode: &str, prefix: &str) -> usize {
    gcode.lines().filter(|l| code(l).starts_with(prefix)).count()
}

/// Slices `case` (with the mark) and `plain` (without it) and checks the mark added the printer's pause on each of
/// `layers` and nothing else.
fn pauses_and_changes_nothing_else(case: &str, plain: (&str, &str), layers: &[u32]) {
    let marked = slice(&fixture("color-change", case));
    let base = slice(&fixture(plain.0, plain.1));
    assert_eq!(count(&marked, "M600"), 0, "{case}: M600");
    assert_eq!(
        layers_with(&base, "M400 U1"),
        Vec::<u32>::new(),
        "{case}: no pause without the mark"
    );
    assert_eq!(layers_with(&marked, "M400 U1"), layers, "{case}: the pause");
    assert_eq!(count(&marked, "M106"), count(&base, "M106"), "{case}: fan lines");
    let kept: Vec<&str> = without_progress(&marked)
        .into_iter()
        .filter(|l| code(l) != "M400 U1")
        .collect();
    let base = without_progress(&base);
    if kept != base {
        let at = kept
            .iter()
            .zip(&base)
            .position(|(a, b)| a != b)
            .unwrap_or(kept.len().min(base.len()));
        panic!(
            "{case}: lines other than the pause changed from line {at}:\nwith the mark: {:?}\nwithout it: {:?}",
            &kept[at.saturating_sub(3)..(at + 4).min(kept.len())],
            &base[at.saturating_sub(3)..(at + 4).min(base.len())]
        );
    }
}

#[test]
fn a_color_change_on_one_filament_pauses_at_its_layer() {
    for p in ["a1", "p1s"] {
        pauses_and_changes_nothing_else(&format!("{p}-f1cc"), ("color-change", &format!("{p}-f1")), &[25]);
    }
}

#[test]
fn a_color_change_on_two_filaments_pauses_at_its_layer() {
    for p in ["a1", "p1s"] {
        pauses_and_changes_nothing_else(&format!("{p}-f2cc"), ("color-change", &format!("{p}-f2")), &[25]);
    }
}

#[test]
fn a_color_change_on_five_filaments_pauses_with_the_tower_on_or_off() {
    for p in ["a1", "p1s"] {
        pauses_and_changes_nothing_else(&format!("{p}-f5cc"), ("layer-tools", &format!("{p}-s4")), &[25]);
        pauses_and_changes_nothing_else(
            &format!("{p}-f5offcc"),
            ("layer-tools", &format!("{p}-s4off")),
            &[25],
        );
    }
}

#[test]
fn a_color_change_naming_a_filament_that_is_not_printing_still_pauses() {
    pauses_and_changes_nothing_else("a1-f5othercc", ("layer-tools", "a1-s4"), &[25]);
}

#[test]
fn a_color_change_on_two_objects_pauses_once() {
    for p in ["a1", "p1s"] {
        pauses_and_changes_nothing_else(&format!("{p}-twocc"), ("layer-tools", &format!("{p}-two")), &[25]);
    }
}

#[test]
fn a_color_change_printed_by_object_pauses_once_for_each_object() {
    // 50 layers per box: the second box's layer 25 is the file's layer 75.
    pauses_and_changes_nothing_else("a1-byobjcc", ("layer-tools", "a1-s4byobj"), &[25, 75]);
}

#[test]
fn a_pause_printed_by_object_pauses_once_for_each_object() {
    pauses_and_changes_nothing_else("a1-byobjpause", ("layer-tools", "a1-s4byobj"), &[25, 75]);
}
