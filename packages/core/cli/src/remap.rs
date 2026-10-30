// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx remap-toolheads`: moves the logical tools of a sliced U1 file onto other physical toolheads, offline, with the
//! rewrite and refusals the printer bridge uses for a prepared send. No printer, no bridge, nothing uploaded.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::ExitCode;

use serde_json::json;
use sx_connect::toolhead_map::Remapped;

use crate::{EXIT_INPUT, EXIT_USAGE, flag, has};

const USAGE: &str =
    "usage: sx remap-toolheads <in.gcode> --map <logical=physical,...> -o <out.gcode> [--json]";

/// `0=2,1=3`: logical tool to physical toolhead, each logical tool once.
fn parse_map(text: &str) -> Result<BTreeMap<u8, u8>, String> {
    let mut map = BTreeMap::new();
    for pair in text.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (logical, physical) = pair
            .split_once('=')
            .ok_or_else(|| format!("--map takes logical=physical pairs such as 0=2,1=3, not {pair}"))?;
        let number = |s: &str| {
            s.trim()
                .parse::<u8>()
                .map_err(|_| format!("--map takes tool numbers such as 0=2,1=3, not {pair}"))
        };
        if map.insert(number(logical)?, number(physical)?).is_some() {
            return Err(format!("--map names tool {} twice", logical.trim()));
        }
    }
    if map.is_empty() {
        return Err("--map needs at least one logical=physical pair".to_owned());
    }
    Ok(map)
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    let json_out = has(args, "--json");
    let usage = |msg: &str| {
        eprintln!("sx remap-toolheads: {msg}\n{USAGE}");
        ExitCode::from(EXIT_USAGE)
    };
    let refuse = |line: Option<usize>, reason: &str| {
        if json_out {
            println!(
                "{}",
                json!({"version": 1, "error": "remap_refused", "line": line, "reason": reason})
            );
        }
        match line {
            Some(line) => eprintln!("sx remap-toolheads: refused: line {line}: {reason}"),
            None => eprintln!("sx remap-toolheads: refused: {reason}"),
        }
        ExitCode::from(EXIT_INPUT)
    };
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        println!(
            "{USAGE}\n\nRewrites T, M104/M109/M116/M900 T, INDEX= on SM_PRINT_PREEXTRUDE_FILAMENT and SM_PRINT_FLOW_CALIBRATE,\nand EXTRUDER=extruderN for the map, and prints what changed and the output's SHA-256. Comments are kept.\nA file the rewrite cannot read safely is refused (exit 3) and nothing is written."
        );
        return ExitCode::SUCCESS;
    }
    let values = ["--map", "-o", "--output"];
    let mut inputs = Vec::new();
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
        } else if values.contains(&arg.as_str()) {
            skip = true;
        } else if arg.starts_with('-') && arg != "--json" {
            return usage(&format!("unknown option {arg}"));
        } else if arg != "--json" {
            inputs.push(arg);
        }
    }
    let [input] = inputs.as_slice() else {
        return usage("give one input G-code file");
    };
    let Some(map_text) = flag(args, "--map") else {
        return usage("--map is required");
    };
    let Some(output) = flag(args, "-o").or_else(|| flag(args, "--output")) else {
        return usage("-o <out.gcode> is required");
    };
    let map = match parse_map(map_text) {
        Ok(map) => map,
        Err(msg) => return usage(&msg),
    };
    let data = match std::fs::read(input) {
        Ok(data) => data,
        Err(e) => return refuse(None, &format!("cannot read {input}: {e}")),
    };
    // The original stays as it is: a mapped copy cannot be mapped again.
    if same_file(Path::new(input), Path::new(output)) {
        return usage("write the remapped copy to another file than the input");
    }
    let remapped = match sx_connect::toolhead_map::remap_gcode(&data, &map) {
        Ok(remapped) => remapped,
        Err(refusal) => return refuse(refusal.line, &refusal.reason),
    };
    if let Err(e) = std::fs::write(output, &remapped.data) {
        return refuse(None, &format!("cannot write {output}: {e}"));
    }
    report(&map, &remapped, output, json_out);
    ExitCode::SUCCESS
}

/// What changed, as text or as one JSON object.
fn report(map: &BTreeMap<u8, u8>, remapped: &Remapped, output: &str, json_out: bool) {
    let unused: Vec<u8> = map
        .keys()
        .copied()
        .filter(|tool| !remapped.used.contains(tool))
        .collect();
    let c = &remapped.counts;
    if json_out {
        let map_json: serde_json::Map<String, serde_json::Value> =
            map.iter().map(|(l, p)| (l.to_string(), json!(p))).collect();
        println!(
            "{}",
            json!({
                "version": 1,
                "output": output,
                "sha256": remapped.sha256,
                "sourceSha256": remapped.source_sha256,
                "bytes": remapped.data.len(),
                "map": map_json,
                "toolsUsed": remapped.used,
                "unusedMapTools": unused,
                "counts": c,
            })
        );
    } else {
        let pairs: Vec<String> = map.iter().map(|(l, p)| format!("{l}>{p}")).collect();
        println!("map {}", pairs.join(" "));
        println!(
            "changed {} lines: {} tool changes, {} temperatures, {} pre-extrude indexes, {} flow calibration indexes, {} extruder names",
            c.changed_lines,
            c.tool_changes,
            c.temperatures,
            c.preextrude_indexes,
            c.flow_calibrate_indexes,
            c.extruder_names
        );
        if !unused.is_empty() {
            let tools: Vec<String> = unused.iter().map(u8::to_string).collect();
            println!("not in the file: tool {}", tools.join(", "));
        }
        println!("sha256 {}  {output}", remapped.sha256);
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_map;

    #[test]
    fn reads_logical_to_physical_pairs() {
        assert_eq!(
            parse_map("0=2, 1=3,2=0,3=1")
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            [(0, 2), (1, 3), (2, 0), (3, 1)]
        );
        for bad in ["", "0", "0:2", "0=x", "0=2,0=3", "300=1"] {
            assert!(parse_map(bad).is_err(), "{bad}");
        }
    }
}
