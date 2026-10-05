// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Settings embedded in a Bambu Studio or Orca project (.3mf): the whole config in
//! `Metadata/project_settings.config`, per object and per part overrides in
//! `Metadata/model_settings.config`, layer range overrides in `Metadata/layer_config_ranges.xml`.
//! Unzipping is the caller's job (sx-core's 3MF reader owns the ZIP); this reads the three files'
//! contents. `js/project.ts` does the same.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Map, Value as Json};

use crate::error::Error;
use crate::import::import_flat;
use crate::schema::is_project_key;
use crate::value::PrintConfig;

#[derive(Debug, Default)]
struct XmlNode {
    name: String,
    attrs: BTreeMap<String, String>,
    children: Vec<XmlNode>,
    text: String,
}

fn decode(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Push `node` onto the innermost open element of `stack`.
fn attach(stack: &mut [XmlNode], node: XmlNode) {
    if let Some(top) = stack.last_mut() {
        top.children.push(node);
    }
}

fn parse_attrs(mut s: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    loop {
        s = s.trim_start();
        let Some(eq) = s.find('=') else { break };
        let name = s[..eq].trim().to_owned();
        let rest = s[eq + 1..].trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            break;
        };
        let body = &rest[1..];
        let Some(end) = body.find(quote) else { break };
        out.insert(name, decode(&body[..end]));
        s = &body[end + 1..];
    }
    out
}

/// A small XML reader for the flat config files above: elements, attributes and text. No DTDs, no namespaces.
fn parse_xml(xml: &str) -> XmlNode {
    let mut stack: Vec<XmlNode> = vec![XmlNode {
        name: "#root".to_owned(),
        ..XmlNode::default()
    }];
    let mut rest = xml;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map_or("", |i| &after[i + 3..]);
        } else if let Some(after) = rest.strip_prefix("<?") {
            rest = after.find("?>").map_or("", |i| &after[i + 2..]);
        } else if rest.starts_with('<') {
            let Some(end) = rest.find('>') else { break };
            let inner = &rest[1..end];
            rest = &rest[end + 1..];
            if let Some(name) = inner.strip_prefix('/') {
                let _ = name;
                if stack.len() > 1
                    && let Some(done) = stack.pop()
                {
                    attach(&mut stack, done);
                }
                continue;
            }
            let self_closing = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let name_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
            let name = inner[..name_end].to_owned();
            if !name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            {
                continue;
            }
            let node = XmlNode {
                name,
                attrs: parse_attrs(&inner[name_end..]),
                ..XmlNode::default()
            };
            if self_closing {
                attach(&mut stack, node);
            } else {
                stack.push(node);
            }
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&decode(&rest[..end]));
            }
            rest = &rest[end..];
        }
    }
    while stack.len() > 1 {
        if let Some(done) = stack.pop() {
            attach(&mut stack, done);
        }
    }
    stack.pop().unwrap_or_default()
}

/// Metadata keys that describe the model, not a setting.
const STRUCTURAL: [&str; 27] = [
    "name",
    "extruder",
    "matrix",
    "source_file",
    "source_object_id",
    "source_volume_id",
    "source_offset_x",
    "source_offset_y",
    "source_offset_z",
    "object_id",
    "instance_id",
    "identify_id",
    "plater_id",
    "plater_name",
    "locked",
    "filament_map_mode",
    "filament_maps",
    "filament_volume_maps",
    "thumbnail_file",
    "thumbnail_no_light_file",
    "top_file",
    "pick_file",
    "pattern_file",
    "gcode_file",
    "subtype",
    "mesh_stat",
    "face_count",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPart {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    /// 1 based filament slot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extruder: Option<i64>,
    pub overrides: PrintConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectObject {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extruder: Option<i64>,
    /// Settings this object overrides on top of the project config.
    pub overrides: PrintConfig,
    pub parts: Vec<ProjectPart>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerRange {
    pub object_id: String,
    pub min_z: f64,
    pub max_z: f64,
    pub overrides: PrintConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectPlate {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ProjectNames {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub printer: Option<String>,
    pub filaments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// What a project carries: its config, overrides, plates and layer ranges.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImport {
    /// The project's settings: process, filament and printer in one config.
    pub config: PrintConfig,
    pub names: ProjectNames,
    /// Project level values Orca defines outside presets, raw as stored.
    pub extras: Map<String, Json>,
    pub objects: Vec<ProjectObject>,
    pub plates: Vec<ProjectPlate>,
    pub layer_ranges: Vec<LayerRange>,
    pub unknown_keys: Vec<String>,
    pub ignored_keys: Vec<String>,
    pub nil_keys: Vec<String>,
    pub invalid_keys: Vec<String>,
}

fn metadata(node: &XmlNode) -> BTreeMap<String, String> {
    node.children
        .iter()
        .filter(|c| c.name == "metadata")
        .filter_map(|c| {
            Some((
                c.attrs.get("key")?.clone(),
                c.attrs.get("value").cloned().unwrap_or_default(),
            ))
        })
        .collect()
}

/// Overrides from a metadata map; unknown keys go to `unknown`, unreadable ones to `invalid`.
fn overrides_from(
    meta: &BTreeMap<String, String>,
    unknown: &mut BTreeSet<String>,
    invalid: &mut BTreeSet<String>,
) -> PrintConfig {
    let raw: BTreeMap<String, Json> = meta
        .iter()
        .filter(|(k, _)| !STRUCTURAL.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), Json::String(v.clone())))
        .collect();
    let flat = import_flat(&raw);
    unknown.extend(flat.unknown);
    invalid.extend(flat.invalid);
    flat.config
}

/// `Number.parseInt(s, 10)`: leading digits, optional sign.
fn as_int(s: Option<&String>) -> Option<i64> {
    let t = s?.trim_start();
    let (sign, digits) = match t.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let n: String = digits.chars().take_while(char::is_ascii_digit).collect();
    n.parse::<i64>().ok().map(|v| sign * v)
}

fn strings_of(v: Option<&Json>) -> Vec<String> {
    match v {
        Some(Json::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect(),
        Some(Json::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn number_attr(node: &XmlNode, name: &str) -> f64 {
    node.attrs
        .get(name)
        .map_or(0.0, |s| s.trim().parse::<f64>().unwrap_or(f64::NAN))
}

#[allow(clippy::too_many_lines)]
/// Read the settings a project carries. `project_settings` is the parsed JSON of
/// `Metadata/project_settings.config`; the two XML files are optional text.
pub fn import_project(
    project_settings: &Json,
    model_settings: Option<&str>,
    layer_ranges: Option<&str>,
) -> Result<ProjectImport, Error> {
    let Json::Object(obj) = project_settings else {
        return Err(Error::Request(
            "project_settings.config is not a JSON object".to_owned(),
        ));
    };
    let mut extras = Map::new();
    let mut settings_only: BTreeMap<String, Json> = BTreeMap::new();
    for (k, v) in obj {
        if is_project_key(k) {
            extras.insert(k.clone(), v.clone());
        } else {
            settings_only.insert(k.clone(), v.clone());
        }
    }
    let flat = import_flat(&settings_only);
    let mut unknown: BTreeSet<String> = flat.unknown.iter().cloned().collect();
    let mut invalid: BTreeSet<String> = flat.invalid.iter().cloned().collect();
    let mut objects = Vec::new();
    let mut plates: Vec<ProjectPlate> = Vec::new();
    if let Some(xml) = model_settings {
        let root = parse_xml(xml);
        for n in root.children.iter().flat_map(|c| c.children.iter()) {
            if n.name == "object" {
                let meta = metadata(n);
                let overrides = overrides_from(&meta, &mut unknown, &mut invalid);
                let parts = n
                    .children
                    .iter()
                    .filter(|c| c.name == "part")
                    .map(|p| {
                        let pm = metadata(p);
                        let po = overrides_from(&pm, &mut unknown, &mut invalid);
                        ProjectPart {
                            id: p.attrs.get("id").cloned().unwrap_or_default(),
                            name: pm.get("name").cloned(),
                            subtype: p.attrs.get("subtype").cloned(),
                            extruder: as_int(pm.get("extruder")),
                            overrides: po,
                        }
                    })
                    .collect();
                objects.push(ProjectObject {
                    id: n.attrs.get("id").cloned().unwrap_or_default(),
                    name: meta.get("name").cloned(),
                    extruder: as_int(meta.get("extruder")),
                    overrides,
                    parts,
                });
            } else if n.name == "plate" {
                let meta = metadata(n);
                plates.push(ProjectPlate {
                    id: meta
                        .get("plater_id")
                        .cloned()
                        .unwrap_or_else(|| (plates.len() + 1).to_string()),
                    name: meta.get("plater_name").filter(|s| !s.is_empty()).cloned(),
                });
            }
        }
    }
    let mut ranges = Vec::new();
    if let Some(xml) = layer_ranges {
        let root = parse_xml(xml);
        for o in root
            .children
            .iter()
            .flat_map(|c| c.children.iter())
            .filter(|o| o.name == "object")
        {
            for r in o.children.iter().filter(|c| c.name == "range") {
                let raw: BTreeMap<String, Json> = r
                    .children
                    .iter()
                    .filter(|c| c.name == "option")
                    .filter_map(|opt| {
                        Some((
                            opt.attrs.get("opt_key").filter(|k| !k.is_empty())?.clone(),
                            Json::String(opt.text.trim().to_owned()),
                        ))
                    })
                    .collect();
                let res = import_flat(&raw);
                unknown.extend(res.unknown);
                ranges.push(LayerRange {
                    object_id: o.attrs.get("id").cloned().unwrap_or_default(),
                    min_z: number_attr(r, "min_z"),
                    max_z: number_attr(r, "max_z"),
                    overrides: res.config,
                });
            }
        }
    }
    let text = |k: &str| {
        obj.get(k)
            .and_then(Json::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Ok(ProjectImport {
        config: flat.config,
        names: ProjectNames {
            process: text("print_settings_id"),
            printer: text("printer_settings_id"),
            filaments: strings_of(obj.get("filament_settings_id")),
            version: text("version"),
        },
        extras,
        objects,
        plates,
        layer_ranges: ranges,
        unknown_keys: unknown.into_iter().collect(),
        ignored_keys: flat.ignored,
        nil_keys: flat.nil,
        invalid_keys: invalid.into_iter().collect(),
    })
}
