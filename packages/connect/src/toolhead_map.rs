// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Filament choices for a four-tool printer, without printer side effects.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAP_HEADER: &str = "; slicerx_toolhead_map = ";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedToolheadMap {
    pub version: u8,
    pub source_sha256: String,
    pub needs: Vec<ToolheadNeed>,
    pub selected: BTreeMap<u8, u8>,
    pub selected_heads: Vec<LoadedToolhead>,
}

impl PreparedToolheadMap {
    pub fn matches_loaded(&self, heads: &[LoadedToolhead]) -> bool {
        let selected: BTreeSet<_> = self.selected.values().copied().collect();
        self.selected_heads.len() == selected.len()
            && selected.iter().all(|tool| {
                let original = self.selected_heads.iter().find(|head| head.tool == *tool);
                let current = heads.iter().find(|head| head.tool == *tool);
                original.is_some() && original == current
            })
    }
}

/// The mapping carried by a prepared file. The start operation must establish an identity firmware map.
pub fn prepared_map(data: &[u8]) -> Result<Option<PreparedToolheadMap>, String> {
    let first = data.split(|b| *b == b'\n').next().unwrap_or_default();
    if !first.starts_with(MAP_HEADER.as_bytes()) {
        return Ok(None);
    }
    if first.len() > 16_384 {
        return Err("The toolhead mapping header is too large".to_owned());
    }
    let text = std::str::from_utf8(first).map_err(|_| "Invalid toolhead mapping header")?;
    let map: PreparedToolheadMap = serde_json::from_str(text.trim_start_matches(MAP_HEADER))
        .map_err(|_| "Invalid toolhead mapping header")?;
    if map.version != 1
        || map.source_sha256.len() != 64
        || !map.source_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Unsupported toolhead mapping header".to_owned());
    }
    Ok(Some(map))
}

/// Rewrites a copy for the selected physical tools. Nothing is uploaded or started.
pub fn prepare_toolhead_file(
    mut file: crate::JobFile,
    needs: &[ToolheadNeed],
    heads: &[LoadedToolhead],
    selected: &BTreeMap<u8, u8>,
) -> Result<(crate::JobFile, ToolheadPlan), String> {
    if file.kind != crate::JobKind::Gcode {
        return Err("Toolhead mapping requires a plain G-code file".to_owned());
    }
    if file.data.len() > 512 * 1024 * 1024 {
        return Err("The G-code file is too large to prepare".to_owned());
    }
    let text = std::str::from_utf8(&file.data).map_err(|_| "Toolhead mapping requires UTF-8 G-code")?;
    if text.contains(MAP_HEADER) {
        return Err("This file is already mapped; prepare again from the original file".to_owned());
    }
    let source_sha256 = crate::types::hex(&Sha256::digest(&file.data));
    if source_sha256 != file.sha256.to_ascii_lowercase() {
        return Err("The source file hash does not match its bytes".to_owned());
    }
    let plan = plan_toolheads(needs, heads, selected)?;
    if selected.len() != needs.len() || !plan.ready {
        return Err("Choose a loaded toolhead for every job filament before preparing the file".to_owned());
    }
    let mut used = BTreeSet::new();
    let mut body = String::with_capacity(text.len());
    for (line_no, line) in text.split_inclusive('\n').enumerate() {
        body.push_str(
            &rewrite_line(line, selected, &mut used)
                .map_err(|reason| format!("Line {}: {reason}", line_no + 1))?,
        );
    }
    let declared: BTreeSet<_> = needs.iter().map(|need| need.tool).collect();
    if used != declared {
        return Err("The declared job filaments do not match the G-code tool selections".to_owned());
    }
    let map = PreparedToolheadMap {
        version: 1,
        source_sha256,
        needs: needs.to_vec(),
        selected: selected.clone(),
        selected_heads: heads
            .iter()
            .filter(|head| selected.values().any(|tool| *tool == head.tool))
            .cloned()
            .collect(),
    };
    let header = serde_json::to_string(&map).map_err(|_| "Could not encode toolhead mapping")?;
    file.data = format!("{MAP_HEADER}{header}\n{body}").into_bytes();
    file.sha256 = crate::types::hex(&Sha256::digest(&file.data));
    Ok((file, plan))
}

fn mapped(index: &str, selected: &BTreeMap<u8, u8>) -> Result<u8, String> {
    let index: u8 = index.parse().map_err(|_| "Invalid tool index")?;
    selected
        .get(&index)
        .copied()
        .ok_or_else(|| format!("Tool {index} has no selected loaded toolhead"))
}

fn checked_tool_command(code: &str, command: &str) -> Result<bool, String> {
    if code.contains(['{', '}', '*'])
        || (command.starts_with('N')
            && command
                .get(1..2)
                .is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit())))
    {
        return Err("Resolve templates and remove line numbers/checksums before toolhead mapping".to_owned());
    }
    if ["M104", "M109", "M900"]
        .iter()
        .any(|prefix| command.starts_with(prefix) && command != *prefix)
    {
        return Err(
            "Separate indexed temperature commands and parameters with spaces before mapping".to_owned(),
        );
    }
    let upper = command.to_ascii_uppercase();
    if upper != command
        && (upper.starts_with('T')
            || upper.starts_with("SET_PRINT_EXTRUDER_MAP")
            || matches!(
                upper.as_str(),
                "M104"
                    | "M109"
                    | "M900"
                    | "SET_PRESSURE_ADVANCE"
                    | "SM_PRINT_PREEXTRUDE_FILAMENT"
                    | "SM_PRINT_FLOW_CALIBRATE"
                    | "SET_PRINT_TASK_PARAMETERS"
                    | "LOAD_PRINT_TASK_CONFIG"
                    | "RESET_PRINT_TASK_CONFIG"
                    | "SET_PRINT_USED_EXTRUDERS"
            ))
    {
        return Err("Use uppercase tool commands before mapping".to_owned());
    }
    let tool_command = command.starts_with('T')
        && command
            .get(1..)
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    if command.starts_with('T')
        && !tool_command
        && command
            .get(1..2)
            .is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Separate tool commands and parameters with spaces before mapping".to_owned());
    }
    Ok(tool_command)
}

fn physical_tool_reference(words: &[&str], command: &str, tool_command: bool) -> Result<bool, String> {
    if !tool_command && !matches!(command, "M104" | "M109" | "M900") {
        return Ok(false);
    }
    let mut flags = words.iter().skip(1).filter(|word| word.starts_with(['A', 'a']));
    let first = flags.next();
    if flags.next().is_some() {
        return Err("Use only one tool addressing flag".to_owned());
    }
    match first.copied() {
        Some("A0") => Ok(true),
        None | Some("A1") => Ok(false),
        _ => Err("Use A0 or A1 for tool addressing before mapping".to_owned()),
    }
}

fn lowercase_tool_parameter(word: &str, command: &str, tool_command: bool) -> bool {
    ["INDEX=", "TOOL=", "EXTRUDER="].iter().any(|prefix| {
        word.get(..prefix.len())
            .is_some_and(|name| name.eq_ignore_ascii_case(prefix) && name != *prefix)
    }) || ((tool_command || matches!(command, "M104" | "M109" | "M900")) && word.starts_with(['t', 'a']))
}

fn rewrite_line(line: &str, selected: &BTreeMap<u8, u8>, used: &mut BTreeSet<u8>) -> Result<String, String> {
    let code = line.split_once(';').map_or(line, |(code, _)| code);
    let words: Vec<_> = code.split_whitespace().collect();
    let Some(command) = words.first().copied() else {
        return Ok(line.to_owned());
    };
    let tool_command = checked_tool_command(code, command)?;
    let physical = physical_tool_reference(&words, command, tool_command)?;
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    let mut cursor = 0;
    for (word_index, word) in words.iter().enumerate() {
        if word_index > 0 && lowercase_tool_parameter(word, command, tool_command) {
            return Err("Use uppercase tool parameter names before mapping".to_owned());
        }
        let start = code
            .get(cursor..)
            .and_then(|s| s.find(word))
            .map(|n| cursor + n)
            .ok_or("Invalid G-code token")?;
        cursor = start + word.len();
        let replacement = if word_index == 0 && tool_command && !physical {
            let index = word.get(1..).ok_or("Invalid tool selection")?;
            let logical: u8 = index.parse().map_err(|_| "Invalid tool selection")?;
            used.insert(logical);
            Some(format!("T{}", mapped(index, selected)?))
        } else if word_index > 0
            && matches!(command, "M104" | "M109" | "M900")
            && word.starts_with('T')
            && !physical
        {
            Some(format!(
                "T{}",
                mapped(word.get(1..).ok_or("Invalid indexed temperature")?, selected)?
            ))
        } else if matches!(
            command,
            "SM_PRINT_PREEXTRUDE_FILAMENT" | "SM_PRINT_FLOW_CALIBRATE"
        ) && word.starts_with("INDEX=")
        {
            Some(format!(
                "INDEX={}",
                mapped(word.trim_start_matches("INDEX="), selected)?
            ))
        } else if command == "SET_PRESSURE_ADVANCE" && word.starts_with("EXTRUDER=extruder") {
            let index = word.trim_start_matches("EXTRUDER=extruder");
            let target = mapped(if index.is_empty() { "0" } else { index }, selected)?;
            Some(if target == 0 {
                "EXTRUDER=extruder".to_owned()
            } else {
                format!("EXTRUDER=extruder{target}")
            })
        } else {
            if word_index > 0
                && word.starts_with('T')
                && word
                    .get(1..)
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                && !matches!(command, "M104" | "M109" | "M900")
            {
                return Err(format!(
                    "Indexed tool parameter in {command} is not supported for mapping"
                ));
            }
            if matches!(command, "M104" | "M109" | "M900") && word.contains('T') && !word.starts_with('T') {
                return Err("Separate indexed temperature parameters with spaces before mapping".to_owned());
            }
            if word_index > 0
                && (word.starts_with("TOOL=") || word.starts_with("INDEX=") || word.starts_with("EXTRUDER="))
                && !matches!(
                    command,
                    "SM_PRINT_EXTRUDER_PREHEAT" | "SM_PRINT_AUTO_FEED" | "SM_PRINT_FLOW_CALIBRATE"
                )
            {
                return Err(format!(
                    "Tool reference in {command} is not supported for mapping"
                ));
            }
            None
        };
        if let Some(replacement) = replacement {
            replacements.push((start, cursor, replacement));
        }
    }
    if command.starts_with("SET_PRINT_EXTRUDER_MAP")
        || command == "SET_PRINT_TASK_PARAMETERS"
        || command == "LOAD_PRINT_TASK_CONFIG"
        || command == "RESET_PRINT_TASK_CONFIG"
        || command == "SET_PRINT_USED_EXTRUDERS"
    {
        return Err("Embedded firmware mapping changes cannot be remapped".to_owned());
    }
    let mut result = line.to_owned();
    for (start, end, text) in replacements.into_iter().rev() {
        result.replace_range(start..end, &text);
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolheadNeed {
    pub tool: u8,
    pub material: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedToolhead {
    pub tool: u8,
    pub loaded: bool,
    pub material: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolheadMatch {
    Match,
    Selected,
    ChoiceRequired,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolheadAssignment {
    pub tool: u8,
    pub physical_tool: Option<u8>,
    pub alternatives: Vec<u8>,
    pub status: ToolheadMatch,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolheadPlan {
    pub ready: bool,
    pub assignments: Vec<ToolheadAssignment>,
    pub toolheads: Vec<LoadedToolhead>,
}

fn material_key(s: &str) -> String {
    let mut key = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    // finish and speed labels do not change the base polymer; fiber blends stay distinct.
    for suffix in [" HIGH SPEED", " SNAPSPEED", " MATTE", " SILK", " MARBLE"] {
        if let Some(base) = key.strip_suffix(suffix) {
            key = base.to_owned();
            break;
        }
    }
    key
}

fn rgb(s: &str) -> Option<[u8; 3]> {
    let s = s.trim().strip_prefix('#').unwrap_or(s.trim());
    if s.len() != 6 || !s.is_ascii() {
        return None;
    }
    Some([
        u8::from_str_radix(s.get(..2)?, 16).ok()?,
        u8::from_str_radix(s.get(2..4)?, 16).ok()?,
        u8::from_str_radix(s.get(4..6)?, 16).ok()?,
    ])
}

fn distance(a: [u8; 3], b: [u8; 3]) -> u32 {
    a.into_iter()
        .zip(b)
        .map(|(x, y)| u32::from(x.abs_diff(y)).pow(2))
        .sum()
}

fn validate_inputs(
    needs: &[ToolheadNeed],
    heads: &[LoadedToolhead],
    selected: &BTreeMap<u8, u8>,
) -> Result<(), String> {
    if needs.is_empty() || needs.len() > 32 {
        return Err("Provide between one and 32 job filaments".to_owned());
    }
    let mut tools = BTreeSet::new();
    for need in needs {
        let material = material_key(&need.material);
        if need.tool >= 32 || !tools.insert(need.tool) {
            return Err("Job filament tool indices must be unique and between 0 and 31".to_owned());
        }
        if material.is_empty() || material == "NONE" || rgb(&need.color).is_none() {
            return Err(format!(
                "Filament {} needs a known material and six-digit color",
                need.tool + 1
            ));
        }
    }
    let physical: BTreeSet<_> = heads.iter().map(|head| head.tool).collect();
    if heads.len() != 4 || physical != BTreeSet::from([0, 1, 2, 3]) {
        return Err("The printer must report all four U1 toolheads".to_owned());
    }
    if selected
        .iter()
        .any(|(tool, head)| !tools.contains(tool) || *head > 3)
    {
        return Err("The selection names an unknown job filament or toolhead".to_owned());
    }
    Ok(())
}

/// Suggest choices or validate explicit selections. This never changes a printer or file.
pub fn plan_toolheads(
    needs: &[ToolheadNeed],
    heads: &[LoadedToolhead],
    selected: &BTreeMap<u8, u8>,
) -> Result<ToolheadPlan, String> {
    validate_inputs(needs, heads, selected)?;
    let mut assignments = Vec::with_capacity(needs.len());
    for need in needs {
        let color = rgb(&need.color).ok_or("Invalid filament color")?;
        let mut candidates: Vec<_> = heads
            .iter()
            .filter(|head| {
                head.loaded
                    && head.material.as_deref().is_some_and(|m| {
                        !m.trim().is_empty() && material_key(m) == material_key(&need.material)
                    })
            })
            .collect();
        candidates.sort_by_key(|head| {
            (
                head.color
                    .as_deref()
                    .and_then(rgb)
                    .map_or(u32::MAX, |c| distance(color, c)),
                head.tool,
            )
        });
        let alternatives = candidates.iter().map(|head| head.tool).collect();
        let (physical_tool, status, reason) = if let Some(chosen) = selected.get(&need.tool) {
            if candidates.iter().any(|head| head.tool == *chosen) {
                (
                    Some(*chosen),
                    ToolheadMatch::Selected,
                    "Selected loaded toolhead".to_owned(),
                )
            } else {
                (
                    None,
                    ToolheadMatch::Unavailable,
                    format!(
                        "Toolhead {} does not report loaded {} for filament {}",
                        chosen + 1,
                        need.material,
                        need.tool + 1
                    ),
                )
            }
        } else if let Some(best) = candidates.first() {
            let exact = candidates
                .iter()
                .filter(|head| head.color.as_deref().and_then(rgb) == Some(color))
                .count();
            if exact == 1 {
                (
                    Some(best.tool),
                    ToolheadMatch::Match,
                    "Material and color match".to_owned(),
                )
            } else {
                (
                    Some(best.tool),
                    ToolheadMatch::ChoiceRequired,
                    if exact > 1 {
                        "Several toolheads match; choose the one to use".to_owned()
                    } else {
                        "No exact color match; choose a loaded toolhead or load the requested color"
                            .to_owned()
                    },
                )
            }
        } else {
            (
                None,
                ToolheadMatch::Unavailable,
                format!(
                    "Load {} for filament {}; no toolhead reports that material",
                    need.material,
                    need.tool + 1
                ),
            )
        };
        assignments.push(ToolheadAssignment {
            tool: need.tool,
            physical_tool,
            alternatives,
            status,
            reason,
        });
    }
    Ok(ToolheadPlan {
        ready: assignments
            .iter()
            .all(|a| matches!(a.status, ToolheadMatch::Match | ToolheadMatch::Selected)),
        assignments,
        toolheads: heads.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heads() -> Vec<LoadedToolhead> {
        ["#ff0000", "#00ff00", "#0000ff", "#000000"]
            .into_iter()
            .enumerate()
            .map(|(tool, color)| LoadedToolhead {
                tool: u8::try_from(tool).unwrap(),
                loaded: true,
                material: Some("PLA".to_owned()),
                color: Some(color.to_owned()),
            })
            .collect()
    }
    fn need(tool: u8, material: &str, color: &str) -> ToolheadNeed {
        ToolheadNeed {
            tool,
            material: material.to_owned(),
            color: color.to_owned(),
        }
    }

    fn file(text: &str) -> crate::JobFile {
        crate::JobFile {
            name: "job.gcode".to_owned(),
            kind: crate::JobKind::Gcode,
            data: text.as_bytes().to_vec(),
            sha256: crate::types::hex(&Sha256::digest(text.as_bytes())),
        }
    }

    #[test]
    fn preparation_swaps_all_job_references_and_preserves_physical_setup_and_comments() {
        let text = "M104 T0 S220\r\nM104 S0 T0 A0\r\nT0 ; T1 stays a comment\r\nG1 X10 E1\r\nT1\r\nM109 T1 S225\r\nSM_PRINT_PREEXTRUDE_FILAMENT INDEX=1\r\nSET_PRESSURE_ADVANCE EXTRUDER=extruder1 ADVANCE=0.02\r\nSM_PRINT_AUTO_FEED EXTRUDER=0\r\n";
        let needs = [need(0, "PLA", "ff0000"), need(1, "PLA", "00ff00")];
        let (prepared, _) =
            prepare_toolhead_file(file(text), &needs, &heads(), &BTreeMap::from([(0, 1), (1, 0)])).unwrap();
        let result = std::str::from_utf8(&prepared.data).unwrap();
        assert!(result.ends_with("M104 T1 S220\r\nM104 S0 T0 A0\r\nT1 ; T1 stays a comment\r\nG1 X10 E1\r\nT0\r\nM109 T0 S225\r\nSM_PRINT_PREEXTRUDE_FILAMENT INDEX=0\r\nSET_PRESSURE_ADVANCE EXTRUDER=extruder ADVANCE=0.02\r\nSM_PRINT_AUTO_FEED EXTRUDER=0\r\n"));
        assert_eq!(
            prepared.sha256,
            crate::types::hex(&Sha256::digest(&prepared.data))
        );
        let proof = prepared_map(&prepared.data).unwrap().unwrap();
        assert_eq!(proof.selected, BTreeMap::from([(0, 1), (1, 0)]));
        assert!(prepare_toolhead_file(prepared, &needs, &heads(), &proof.selected).is_err());
    }

    #[test]
    fn prepared_choices_detect_changed_spools_but_ignore_unused_heads() {
        let needs = [need(0, "PLA", "ff0000")];
        let (output, _) =
            prepare_toolhead_file(file("T0\n"), &needs, &heads(), &BTreeMap::from([(0, 1)])).unwrap();
        let proof = prepared_map(&output.data).unwrap().unwrap();
        let mut loaded = heads();
        assert!(proof.matches_loaded(&loaded));
        loaded[3].color = Some("#ffffff".into());
        assert!(proof.matches_loaded(&loaded));
        loaded[1].color = Some("#ffffff".into());
        assert!(!proof.matches_loaded(&loaded));
        loaded[1] = heads()[1].clone();
        loaded[1].material = Some("PETG".into());
        assert!(!proof.matches_loaded(&loaded));
    }

    #[test]
    fn stock_u1_startup_can_map_all_four_tools_without_changing_physical_calibration() {
        let source = include_str!("../tests/fixtures/u1-toolhead-startup.gcode");
        let needs = (0..4).map(|tool| need(tool, "PLA", "ff0000")).collect::<Vec<_>>();
        let selected = BTreeMap::from([(0, 3), (1, 2), (2, 1), (3, 0)]);
        let (output, _) = prepare_toolhead_file(file(source), &needs, &heads(), &selected).unwrap();
        let text = std::str::from_utf8(&output.data).unwrap();
        assert!(text.contains("M104 T3 S140"));
        assert!(text.contains("SM_PRINT_EXTRUDER_PREHEAT EXTRUDER=1 TEMP=140"));
        assert!(text.contains("SM_PRINT_AUTO_FEED EXTRUDER=0"));
        assert!(text.contains("M104 S0 T0 A0"));
        assert!(text.contains("SET_PRESSURE_ADVANCE ADVANCE=0.02 EXTRUDER=extruder2"));
        assert_eq!(prepared_map(&output.data).unwrap().unwrap().selected, selected);
    }

    #[test]
    fn preparation_refuses_unreviewed_partial_or_ambiguous_files() {
        let needs = [need(0, "PLA", "ff0000")];
        let selected = BTreeMap::from([(0, 1)]);
        for text in [
            "T0\nT1\n",
            "T0\nCUSTOM TOOL=0\n",
            "T0\nM104S220T0\n",
            "T0\nSET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=1\n",
            "T0\nset_print_extruder_map CONFIG_EXTRUDER=0 MAP_EXTRUDER=1\n",
            "T0\nset_print_used_extruders EXTRUDERS=1\n",
            "T0\nreset_print_task_config\n",
            "T0\nload_print_task_config\n",
            "T0\nset_print_task_parameters\n",
            "T0\nM104 S220T0\n",
            "t0\n",
            "T0\nM104 t0 S220\n",
            "T0\nSM_PRINT_PREEXTRUDE_FILAMENT index=0\n",
            "T0\nSM_PRINT_PREEXTRUDE_FILAMENT InDeX=0\n",
            "T0 a0\n",
            "T0 A00\n",
            "T0 A0 A1\n",
            "T0\nSET_PRESSURE_ADVANCE ExTrUdEr=extruder ADVANCE=0.02\n",
            "T0\nCUSTOM T0\n",
            "T0\nM104 T{tool}\n",
        ] {
            assert!(
                prepare_toolhead_file(file(text), &needs, &heads(), &selected).is_err(),
                "{text}"
            );
        }
        assert!(prepare_toolhead_file(file("T0\n"), &needs, &heads(), &BTreeMap::new()).is_err());
        let mut wrong = file("T0\n");
        wrong.sha256 = "0".repeat(64);
        assert!(prepare_toolhead_file(wrong, &needs, &heads(), &selected).is_err());
    }
    #[test]
    fn proposes_swapped_colors_without_changing_slot_numbers() {
        let plan = plan_toolheads(
            &[need(0, "PLA", "#00FF00"), need(1, "PLA", "ff0000")],
            &heads(),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(plan.ready);
        assert_eq!(
            plan.assignments
                .iter()
                .map(|a| a.physical_tool)
                .collect::<Vec<_>>(),
            [Some(1), Some(0)]
        );
    }
    #[test]
    fn differing_colors_need_a_choice_and_materials_cannot_be_overridden() {
        let needs = [need(7, "PLA", "#ffffff")];
        let plan = plan_toolheads(&needs, &heads(), &BTreeMap::new()).unwrap();
        assert!(!plan.ready);
        assert_eq!(plan.assignments[0].status, ToolheadMatch::ChoiceRequired);
        assert!(
            plan_toolheads(&needs, &heads(), &BTreeMap::from([(7, 2)]))
                .unwrap()
                .ready
        );
        assert!(
            !plan_toolheads(&[need(7, "PETG", "ffffff")], &heads(), &BTreeMap::from([(7, 2)]))
                .unwrap()
                .ready
        );
    }
    #[test]
    fn unknown_empty_and_composite_materials_do_not_match_plain_pla() {
        let mut slots = heads();
        slots[0].material = None;
        slots[1].loaded = false;
        slots[2].material = Some("PLA-CF".to_owned());
        slots[3].material = Some("PETG".to_owned());
        let plan = plan_toolheads(&[need(0, "PLA", "ff0000")], &slots, &BTreeMap::new()).unwrap();
        assert!(!plan.ready);
        assert!(plan.assignments[0].alternatives.is_empty());
    }
    #[test]
    fn duplicate_matches_require_selection_and_invalid_input_is_refused() {
        let mut slots = heads();
        slots[1].color = Some("#ff0000".to_owned());
        assert!(
            !plan_toolheads(&[need(0, "PLA", "ff0000")], &slots, &BTreeMap::new())
                .unwrap()
                .ready
        );
        assert!(plan_toolheads(&[need(0, "PLA", "red")], &slots, &BTreeMap::new()).is_err());
        assert!(
            plan_toolheads(
                &[need(0, "PLA", "ff0000"), need(0, "PLA", "ff0000")],
                &slots,
                &BTreeMap::new()
            )
            .is_err()
        );
        assert!(plan_toolheads(&[need(0, "PLA", "ff0000")], &slots[..3], &BTreeMap::new()).is_err());
    }
}
