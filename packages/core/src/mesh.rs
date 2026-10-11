// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Mesh loading: 3MF (`threemf`), binary and ASCII STL, the quantized JSON
//! model format (u16-quantized positions in base64), and the raw parts
//! format hosts use for geometry buffers.

use crate::error::{Error, Result};

/// One printable volume of a model, in millimeters, Z up.
#[derive(Debug, Clone, Default)]
pub struct MeshPart {
    pub name: String,
    /// Filament slot, 1-based as in Orca's `extruder`.
    pub slot: u8,
    /// `#rrggbb`, when the file carries a color.
    pub color: Option<String>,
    pub positions: Vec<[f32; 3]>,
    /// Counterclockwise seen from outside.
    pub triangles: Vec<[u32; 3]>,
    /// Painted pieces of the surface (multi-color paint), each with the filament it carries.
    pub paint: Vec<crate::paint::PaintFacet>,
    /// Painted support pieces: state 1 asks for support, 2 keeps it out (`paint_supports`).
    pub support_paint: Vec<crate::paint::PaintFacet>,
    /// Painted seam pieces: state 1 asks for the seam here, 2 keeps it away (`paint_seam`).
    pub seam_paint: Vec<crate::paint::PaintFacet>,
    /// Painted fuzzy skin pieces: state 1 gives the walls there fuzzy skin (`paint_fuzzy_skin`).
    pub fuzzy_paint: Vec<crate::paint::PaintFacet>,
    /// The paint texts the pieces above were decoded from, as `(layer, triangle, text)` with layer 0 color, 1 seam,
    /// 2 support and 3 fuzzy skin: what the raw parts format writes back, so a copy of the mesh keeps its paint.
    pub paint_texts: Vec<(u8, u32, String)>,
}

impl MeshPart {
    /// Every layer of decoded paint has the paint texts it was decoded from ([`Mesh::content_hash`] reads the texts).
    fn paint_has_texts(&self) -> bool {
        let has = |layer: u8| self.paint_texts.iter().any(|t| t.0 == layer);
        [
            &self.paint,
            &self.seam_paint,
            &self.support_paint,
            &self.fuzzy_paint,
        ]
        .iter()
        .zip(0u8..)
        .all(|(facets, layer)| facets.is_empty() || has(layer))
    }
}

/// A loaded model: one or more parts in object space.
#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub name: String,
    /// The parts that print.
    pub parts: Vec<MeshPart>,
    /// Parts of the model that do not print themselves (cuts, modifiers, support blockers and enforcers), in the
    /// same space as `parts`, as a project file marks them.
    pub volumes: Vec<MeshVolume>,
    /// Setting overrides the file gives single printed parts (the object's own settings under the part's), by part
    /// name, in the shape of `PlateObject::part_settings`.
    pub part_settings: Vec<(String, serde_json::Value)>,
    /// What the loader read but changed or could not apply, one line each, for the slice's warnings.
    pub notes: Vec<String>,
    /// The object's own setting overrides from a project file (an object of setting keys), `Null` when it has none:
    /// the settings it prints with over the plate's.
    pub settings: serde_json::Value,
}

/// A part of a model that shapes the print without printing: see [`crate::plate::VolumeRole`].
#[derive(Debug, Clone)]
pub struct MeshVolume {
    pub role: crate::plate::VolumeRole,
    /// The geometry, in the space of the mesh's parts; its slot and paint are not used.
    pub part: MeshPart,
    /// A modifier's setting overrides (an object of setting keys); `Null` for the other roles.
    pub settings: serde_json::Value,
}

impl Mesh {
    /// Loads a model, picking the format from the file name and the bytes.
    pub fn load(bytes: &[u8], file_name: &str) -> Result<Self> {
        let ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        // The app's raw parts carry the object's name, which may still end in the file's .stl.
        if bytes.starts_with(RAW_MAGIC)
            && let Ok(mesh) = Self::from_raw(bytes, file_name)
        {
            return Ok(mesh);
        }
        if ext.eq_ignore_ascii_case("json") {
            return Self::from_sx_json(bytes);
        }
        if ext.eq_ignore_ascii_case("stl") {
            return Self::from_stl(bytes, file_name);
        }
        if ext.eq_ignore_ascii_case("obj") || ext.eq_ignore_ascii_case("amf") {
            return Self::from_import(bytes, file_name, ext);
        }
        if ext.eq_ignore_ascii_case("3mf") || bytes.starts_with(b"PK\x03\x04") {
            return crate::threemf::load(bytes, file_name);
        }
        if bytes.starts_with(RAW_MAGIC) {
            return Self::from_raw(bytes, file_name);
        }
        match bytes.first() {
            Some(b'{') => Self::from_sx_json(bytes),
            _ => Self::from_stl(bytes, file_name),
        }
    }

    /// OBJ and AMF through the `sx-geom` importers: every part keeps its filament
    /// slot and color. OBJ has no material library here (a loader for `.mtl`
    /// files needs the host's file system), so its colors come from vertex colors.
    #[cfg(not(feature = "import"))]
    fn from_import(_bytes: &[u8], _file_name: &str, _ext: &str) -> Result<Self> {
        Err(Error::Unsupported("OBJ and AMF import in this build"))
    }

    #[cfg(feature = "import")]
    fn from_import(bytes: &[u8], file_name: &str, ext: &str) -> Result<Self> {
        let opts = sx_geom::import::ImportOptions::default();
        let model = if ext.eq_ignore_ascii_case("obj") {
            sx_geom::import::import_obj(bytes, file_name, None, &opts)
        } else {
            sx_geom::import::import_amf(bytes, file_name, &opts)
        }
        .map_err(|e| Error::mesh(file_name, e.to_string()))?;
        let parts = model
            .parts
            .iter()
            .filter(|p| !p.mesh.triangles.is_empty())
            .map(|p| MeshPart {
                name: p.name.clone(),
                slot: p.slot.max(1),
                color: p.color.clone(),
                #[allow(clippy::cast_possible_truncation, reason = "mesh coordinates are f32 here")]
                positions: p
                    .mesh
                    .positions
                    .iter()
                    .map(|v| [v[0] as f32, v[1] as f32, v[2] as f32])
                    .collect(),
                triangles: p.mesh.triangles.clone(),
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return Err(Error::mesh(file_name, "the file has no triangles"));
        }
        Ok(Self {
            name: file_name.to_owned(),
            parts,
            ..Self::default()
        })
    }

    /// Writes the raw parts format ([`Self::from_raw`] reads it back). Part
    /// names longer than 65,535 bytes are cut.
    pub fn to_raw(&self) -> Vec<u8> {
        let size = 8 + self
            .parts
            .iter()
            .map(|p| 3 + p.name.len().min(65_535) + 8 + p.positions.len() * 12 + p.triangles.len() * 12)
            .sum::<usize>();
        let mut b = Vec::with_capacity(size);
        b.extend_from_slice(RAW_MAGIC);
        b.extend_from_slice(&u32::try_from(self.parts.len()).unwrap_or(u32::MAX).to_le_bytes());
        for p in &self.parts {
            write_raw_part(p, &mut b);
        }
        write_raw_paint(&self.parts, &mut b);
        write_raw_volumes(self, &mut b);
        b
    }

    /// Reads the raw parts format hosts use to pass geometry buffers
    /// (`MeshPart` in `packages/contracts/src/slice.ts`), all little-endian:
    /// magic `SXMP`, u32 part count, then per part: u8 slot, u16 name length,
    /// UTF-8 name, u32 vertex count, f32 xyz per vertex, u32 triangle count,
    /// u32 index triples. An optional paint block may follow the parts: magic `SXPT`, u32 entry count, then per entry
    /// u32 part index, u8 layer (0 color, 1 seam, 2 support, 3 fuzzy skin), u32 triangle count, and per triangle u32
    /// triangle index, u16 text length and the paint text as a 3MF carries it (`paint_color`, `paint_seam`,
    /// `paint_supports`, `paint_fuzzy_skin`). The texts are decoded as the 3MF loader decodes them.
    pub fn from_raw(bytes: &[u8], name: &str) -> Result<Self> {
        let mut r = Reader {
            b: bytes,
            at: RAW_MAGIC.len(),
            name,
        };
        let count = r.u32()?;
        let mut parts = Vec::new();
        for _ in 0..count {
            parts.push(read_raw_part(&mut r)?);
        }
        // An optional paint block after the parts. A reader without it stops before it.
        if r.b.get(r.at..r.at + RAW_PAINT_MAGIC.len()) == Some(RAW_PAINT_MAGIC) {
            r.at += RAW_PAINT_MAGIC.len();
            read_raw_paint(&mut r, &mut parts)?;
        }
        let mut mesh = Self {
            name: name.to_owned(),
            parts,
            ..Self::default()
        };
        // An optional block of the parts that do not print, after the paint block (see `write_raw_volumes`).
        if r.b.get(r.at..r.at + RAW_VOLUME_MAGIC.len()) == Some(RAW_VOLUME_MAGIC) {
            r.at += RAW_VOLUME_MAGIC.len();
            read_raw_volumes(&mut r, &mut mesh)?;
        }
        Ok(mesh)
    }

    /// Total triangle count over all parts.
    pub fn triangle_count(&self) -> usize {
        self.parts.iter().map(|p| p.triangles.len()).sum()
    }

    /// Axis-aligned bounds `(min, max)` in millimeters, or `None` when empty.
    pub fn bounds(&self) -> Option<([f32; 3], [f32; 3])> {
        let mut it = self.parts.iter().flat_map(|p| p.positions.iter());
        let first = *it.next()?;
        let (mut lo, mut hi) = (first, first);
        for p in it {
            for ((l, h), v) in lo.iter_mut().zip(hi.iter_mut()).zip(p) {
                *l = l.min(*v);
                *h = h.max(*v);
            }
        }
        Some((lo, hi))
    }

    /// A stable 64-bit content hash (FNV-1a over positions, indices, slots and
    /// paint texts), used as the cache key for sliced geometry.
    pub fn content_hash(&self) -> u64 {
        // The hash reads the paint texts, not the decoded paint the slicer reads: a part given decoded paint without
        // the texts it came from would hash as the unpainted part (and a cache keyed on it would mix them up).
        debug_assert!(
            self.parts.iter().all(MeshPart::paint_has_texts),
            "a part of {} has decoded paint without its paint texts",
            self.name
        );
        let mut h = Fnv::new();
        for p in &self.parts {
            h.write(&[p.slot]);
            for v in &p.positions {
                for c in v {
                    h.write(&c.to_le_bytes());
                }
            }
            for t in &p.triangles {
                for i in t {
                    h.write(&i.to_le_bytes());
                }
            }
            // Paint is part of what prints, so a mesh painted otherwise is another mesh.
            for (layer, tri, text) in &p.paint_texts {
                h.write(&[*layer]);
                h.write(&tri.to_le_bytes());
                h.write(text.as_bytes());
                h.write(&[0]);
            }
        }
        // Cuts, modifiers, support volumes and part settings change what prints too. A mesh without them hashes as
        // it always has.
        for v in &self.volumes {
            h.write(b"volume");
            h.write(&[v.role as u8]);
            for p in &v.part.positions {
                for c in p {
                    h.write(&c.to_le_bytes());
                }
            }
            for t in &v.part.triangles {
                for i in t {
                    h.write(&i.to_le_bytes());
                }
            }
            h.write(v.settings.to_string().as_bytes());
        }
        for (name, s) in &self.part_settings {
            h.write(b"part settings");
            h.write(name.as_bytes());
            h.write(&[0]);
            h.write(s.to_string().as_bytes());
        }
        if !self.settings.is_null() {
            h.write(b"object settings");
            h.write(self.settings.to_string().as_bytes());
        }
        h.finish()
    }

    /// Decodes the quantized JSON model format: `qMin` and `qMax` bounds,
    /// then per part u16 positions scaled into those bounds and u16 or u32
    /// indices, both base64.
    pub fn from_sx_json(bytes: &[u8]) -> Result<Self> {
        #[derive(serde::Deserialize)]
        struct File {
            name: Option<String>,
            #[serde(rename = "qMin")]
            q_min: [f64; 3],
            #[serde(rename = "qMax")]
            q_max: [f64; 3],
            parts: Vec<Part>,
        }
        #[derive(serde::Deserialize)]
        struct Part {
            name: String,
            color: Option<String>,
            extruder: Option<u8>,
            pos: String,
            idx: String,
            #[serde(default)]
            idx32: bool,
        }
        let file: File =
            serde_json::from_slice(bytes).map_err(|e| Error::mesh("model json", e.to_string()))?;
        let name = file.name.unwrap_or_else(|| "model".to_owned());
        let [min_x, min_y, min_z] = file.q_min;
        let [max_x, max_y, max_z] = file.q_max;
        let (sx, sy, sz) = (
            (max_x - min_x) / 65535.0,
            (max_y - min_y) / 65535.0,
            (max_z - min_z) / 65535.0,
        );
        let mut parts = Vec::with_capacity(file.parts.len());
        for (i, p) in file.parts.into_iter().enumerate() {
            let pos = base64_decode(&p.pos).ok_or_else(|| Error::mesh(&p.name, "bad base64 in pos"))?;
            let idx = base64_decode(&p.idx).ok_or_else(|| Error::mesh(&p.name, "bad base64 in idx"))?;
            #[allow(
                clippy::cast_possible_truncation,
                reason = "quantized model coordinates fit in f32"
            )]
            let positions: Vec<[f32; 3]> = pos
                .as_chunks::<6>()
                .0
                .iter()
                .map(|c| {
                    let x = f64::from(u16::from_le_bytes([c[0], c[1]]));
                    let y = f64::from(u16::from_le_bytes([c[2], c[3]]));
                    let z = f64::from(u16::from_le_bytes([c[4], c[5]]));
                    [
                        (min_x + x * sx) as f32,
                        (min_y + y * sy) as f32,
                        (min_z + z * sz) as f32,
                    ]
                })
                .collect();
            let indices: Vec<u32> = if p.idx32 {
                idx.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|c| u32::from_le_bytes(*c))
                    .collect()
            } else {
                idx.as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u32::from(u16::from_le_bytes(*c)))
                    .collect()
            };
            let triangles = triangles_from_indices(&indices, positions.len(), &p.name)?;
            #[allow(clippy::cast_possible_truncation, reason = "part index is small")]
            let slot = p.extruder.unwrap_or((i + 1).min(255) as u8).max(1);
            parts.push(MeshPart {
                name: p.name,
                slot,
                color: p.color,
                positions,
                triangles,
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            });
        }
        Ok(Self {
            name,
            parts,
            ..Self::default()
        })
    }

    /// Loads binary or ASCII STL as a single part on slot 1.
    pub fn from_stl(bytes: &[u8], name: &str) -> Result<Self> {
        let is_binary = bytes.len() >= 84 && {
            let n = bytes
                .get(80..84)
                .and_then(|b| b.try_into().ok())
                .map(u32::from_le_bytes);
            n.is_some_and(|n| 84 + 50 * n as usize == bytes.len())
        };
        let soup = if is_binary {
            stl_binary(bytes)
        } else {
            stl_ascii(bytes, name)?
        };
        // Refusals as short codes the app words (`engine-errors.ts` in the app package), as for a 3MF.
        if soup.is_empty() {
            return Err(Error::mesh(name, "refused stl-empty 0 0 "));
        }
        if let Some(k) = soup
            .iter()
            .position(|t| t.iter().flatten().any(|c| !c.is_finite()))
        {
            return Err(Error::mesh(
                name,
                ["refused stl-number 0 ", &k.to_string(), " "].concat(),
            ));
        }
        let (positions, triangles) = weld_soup(&soup);
        let part = MeshPart {
            name: name.to_owned(),
            slot: 1,
            color: None,
            positions,
            triangles,
            paint: Vec::new(),
            support_paint: Vec::new(),
            seam_paint: Vec::new(),
            fuzzy_paint: Vec::new(),
            paint_texts: Vec::new(),
        };
        Ok(Self {
            name: name.to_owned(),
            parts: vec![part],
            ..Self::default()
        })
    }
}

const RAW_MAGIC: &[u8] = b"SXMP";
const RAW_PAINT_MAGIC: &[u8] = b"SXPT";
const RAW_VOLUME_MAGIC: &[u8] = b"SXVL";

/// One part of the raw parts format: u8 slot, u16 name length, UTF-8 name, u32 vertex count, f32 xyz per vertex, u32
/// triangle count, u32 index triples. Names longer than 65,535 bytes are cut.
fn write_raw_part(p: &MeshPart, b: &mut Vec<u8>) {
    let name = p.name.as_bytes().get(..p.name.len().min(65_535)).unwrap_or(&[]);
    b.push(p.slot.max(1));
    b.extend_from_slice(&u16::try_from(name.len()).unwrap_or(u16::MAX).to_le_bytes());
    b.extend_from_slice(name);
    b.extend_from_slice(&u32::try_from(p.positions.len()).unwrap_or(u32::MAX).to_le_bytes());
    for v in &p.positions {
        for c in v {
            b.extend_from_slice(&c.to_le_bytes());
        }
    }
    b.extend_from_slice(&u32::try_from(p.triangles.len()).unwrap_or(u32::MAX).to_le_bytes());
    for t in &p.triangles {
        for i in t {
            b.extend_from_slice(&i.to_le_bytes());
        }
    }
}

/// Reads what [`write_raw_part`] writes.
fn read_raw_part(r: &mut Reader<'_>) -> Result<MeshPart> {
    let slot = r.take(1)?.first().copied().unwrap_or(1).max(1);
    let name_len = u16::from_le_bytes(r.take(2)?.try_into().map_err(|_| r.err())?);
    let part_name = String::from_utf8_lossy(r.take(usize::from(name_len))?).into_owned();
    let nv = r.u32()? as usize;
    let pos = r.take(nv.checked_mul(12).ok_or_else(|| r.err())?)?;
    let positions = pos
        .as_chunks::<12>()
        .0
        .iter()
        .map(|c| {
            let f = |a: u8, b: u8, cc: u8, d: u8| f32::from_le_bytes([a, b, cc, d]);
            [
                f(c[0], c[1], c[2], c[3]),
                f(c[4], c[5], c[6], c[7]),
                f(c[8], c[9], c[10], c[11]),
            ]
        })
        .collect();
    let nt = r.u32()? as usize;
    let idx = r.take(nt.checked_mul(12).ok_or_else(|| r.err())?)?;
    let flat: Vec<u32> = idx
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| u32::from_le_bytes(*c))
        .collect();
    let triangles = triangles_from_indices(&flat, nv, &part_name)?;
    Ok(MeshPart {
        name: part_name,
        slot,
        positions,
        triangles,
        ..MeshPart::default()
    })
}

/// A u32 length and that many bytes of UTF-8 text.
fn write_raw_text(text: &str, b: &mut Vec<u8>) {
    b.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_le_bytes());
    b.extend_from_slice(text.as_bytes());
}

fn read_raw_text(r: &mut Reader<'_>) -> Result<String> {
    let len = r.u32()? as usize;
    Ok(String::from_utf8_lossy(r.take(len)?).into_owned())
}

/// The block of the raw parts format that carries a mesh's volumes, part settings, loader notes and object settings, after the
/// paint block: magic `SXVL`; u32 volume count, then per volume u8 role (0 negative, 1 support blocker, 2 support
/// enforcer, 3 modifier), the part as the parts are written and its settings as JSON text; u32 part settings
/// count, then per entry the part name and the settings as JSON text; u32 note count and each note; the object's
/// settings as JSON text (`null` for none; a block without them ends before). Texts are a u32
/// length and UTF-8. Nothing when the mesh has none of them, so a mesh without them writes the bytes it always has.
fn write_raw_volumes(mesh: &Mesh, b: &mut Vec<u8>) {
    if mesh.volumes.is_empty()
        && mesh.part_settings.is_empty()
        && mesh.notes.is_empty()
        && mesh.settings.is_null()
    {
        return;
    }
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes();
    b.extend_from_slice(RAW_VOLUME_MAGIC);
    b.extend_from_slice(&count(mesh.volumes.len()));
    for v in &mesh.volumes {
        b.push(v.role as u8);
        write_raw_part(&v.part, b);
        write_raw_text(&v.settings.to_string(), b);
    }
    b.extend_from_slice(&count(mesh.part_settings.len()));
    for (name, settings) in &mesh.part_settings {
        write_raw_text(name, b);
        write_raw_text(&settings.to_string(), b);
    }
    b.extend_from_slice(&count(mesh.notes.len()));
    for n in &mesh.notes {
        write_raw_text(n, b);
    }
    // The object's settings last, so a reader of the block without them stops before them.
    write_raw_text(&mesh.settings.to_string(), b);
}

/// Reads the block [`write_raw_volumes`] writes into `mesh`.
fn read_raw_volumes(r: &mut Reader<'_>, mesh: &mut Mesh) -> Result<()> {
    let json = |r: &Reader<'_>, text: &str| -> Result<serde_json::Value> {
        serde_json::from_str(text).map_err(|_| r.err())
    };
    for _ in 0..r.u32()? {
        let role = match r.take(1)?.first() {
            Some(0) => crate::plate::VolumeRole::Negative,
            Some(1) => crate::plate::VolumeRole::SupportBlocker,
            Some(2) => crate::plate::VolumeRole::SupportEnforcer,
            Some(3) => crate::plate::VolumeRole::Modifier,
            _ => return Err(r.err()),
        };
        let part = read_raw_part(r)?;
        let text = read_raw_text(r)?;
        let settings = json(r, &text)?;
        mesh.volumes.push(MeshVolume { role, part, settings });
    }
    for _ in 0..r.u32()? {
        let name = read_raw_text(r)?;
        let text = read_raw_text(r)?;
        let settings = json(r, &text)?;
        mesh.part_settings.push((name, settings));
    }
    for _ in 0..r.u32()? {
        mesh.notes.push(read_raw_text(r)?);
    }
    if r.at < r.b.len() {
        let text = read_raw_text(r)?;
        mesh.settings = json(r, &text)?;
    }
    Ok(())
}

/// The paint block of the raw parts format from the parts' paint texts, grouped by part and layer; nothing when no
/// part is painted.
fn write_raw_paint(parts: &[MeshPart], b: &mut Vec<u8>) {
    fn layers(p: &MeshPart) -> impl Iterator<Item = u8> + '_ {
        (0..4u8).filter(move |l| p.paint_texts.iter().any(|t| t.0 == *l))
    }
    let entries: usize = parts.iter().map(|p| layers(p).count()).sum();
    if entries == 0 {
        return;
    }
    b.extend_from_slice(RAW_PAINT_MAGIC);
    b.extend_from_slice(&u32::try_from(entries).unwrap_or(u32::MAX).to_le_bytes());
    for (i, p) in parts.iter().enumerate() {
        for layer in layers(p) {
            b.extend_from_slice(&u32::try_from(i).unwrap_or(u32::MAX).to_le_bytes());
            b.push(layer);
            let count = p.paint_texts.iter().filter(|t| t.0 == layer).count();
            b.extend_from_slice(&u32::try_from(count).unwrap_or(u32::MAX).to_le_bytes());
            for (_, tri, text) in p.paint_texts.iter().filter(|t| t.0 == layer) {
                let t = text.as_bytes().get(..text.len().min(65_535)).unwrap_or(&[]);
                b.extend_from_slice(&tri.to_le_bytes());
                b.extend_from_slice(&u16::try_from(t.len()).unwrap_or(u16::MAX).to_le_bytes());
                b.extend_from_slice(t);
            }
        }
    }
}

/// The paint block of the raw parts format into the parts' paint, as `threemf` decodes paint attributes: color pieces
/// in the part's own filament are left out, every other layer is kept as painted.
fn read_raw_paint(r: &mut Reader<'_>, parts: &mut [MeshPart]) -> Result<()> {
    let entries = r.u32()?;
    for _ in 0..entries {
        let part = r.u32()? as usize;
        let layer = r.take(1)?.first().copied().unwrap_or(u8::MAX);
        let count = r.u32()?;
        let mut facets = Vec::new();
        let mut texts = Vec::new();
        let p = parts.get(part);
        for _ in 0..count {
            let index = r.u32()?;
            let tri = index as usize;
            let len = u16::from_le_bytes(r.take(2)?.try_into().map_err(|_| r.err())?);
            let text = std::str::from_utf8(r.take(usize::from(len))?).unwrap_or("");
            let Some(p) = p else { continue };
            let Some(t) = p.triangles.get(tri) else { continue };
            let corner = |i: u32| p.positions.get(i as usize).copied();
            let (Some(a), Some(b), Some(c)) = (corner(t[0]), corner(t[1]), corner(t[2])) else {
                continue;
            };
            if !text.is_empty() && layer < 4 {
                facets.extend(crate::paint::decode(text, [a, b, c]));
                texts.push((layer, index, text.to_owned()));
            }
        }
        let Some(p) = parts.get_mut(part) else { continue };
        p.paint_texts.append(&mut texts);
        match layer {
            0 => {
                let slot = p.slot;
                p.paint.extend(facets.into_iter().filter(|f| f.state != slot));
            }
            1 => p.seam_paint.extend(facets),
            2 => p.support_paint.extend(facets),
            3 => p.fuzzy_paint.extend(facets),
            _ => {}
        }
    }
    Ok(())
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
    name: &'a str,
}

impl<'a> Reader<'a> {
    fn err(&self) -> Error {
        Error::mesh(self.name, "truncated raw mesh")
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self
            .b
            .get(self.at..self.at.checked_add(n).ok_or_else(|| self.err())?)
            .ok_or_else(|| self.err())?;
        self.at += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().map_err(|_| self.err())?,
        ))
    }
}

fn triangles_from_indices(indices: &[u32], vertex_count: usize, name: &str) -> Result<Vec<[u32; 3]>> {
    let mut out = Vec::with_capacity(indices.len() / 3);
    for t in indices.as_chunks::<3>().0 {
        let tri = *t;
        if tri.iter().any(|&i| i as usize >= vertex_count) {
            return Err(Error::mesh(name, "triangle index out of range"));
        }
        out.push(tri);
    }
    Ok(out)
}

fn stl_binary(bytes: &[u8]) -> Vec<[[f32; 3]; 3]> {
    let body = bytes.get(84..).unwrap_or(&[]);
    crate::par::map_fine(body.as_chunks::<50>().0, |rec| {
        let f = |o: usize| {
            rec.get(o..o + 4)
                .and_then(|b| b.try_into().ok())
                .map_or(0.0, f32::from_le_bytes)
        };
        std::array::from_fn(|v| std::array::from_fn(|k| f(12 + v * 12 + k * 4)))
    })
}

fn stl_ascii(bytes: &[u8], name: &str) -> Result<Vec<[[f32; 3]; 3]>> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::mesh(name, "not a binary or ASCII STL"))?;
    let mut soup = Vec::new();
    let mut cur: Vec<[f32; 3]> = Vec::with_capacity(3);
    for line in text.lines() {
        let mut it = line.split_whitespace();
        if it.next() != Some("vertex") {
            continue;
        }
        let mut v = [0f32; 3];
        for c in &mut v {
            *c = it
                .next()
                .and_then(|s| s.parse().ok())
                .ok_or_else(|| Error::mesh(name, "bad vertex line"))?;
        }
        cur.push(v);
        if let [a, b, c] = *cur.as_slice() {
            soup.push([a, b, c]);
            cur.clear();
        }
    }
    if !cur.is_empty() {
        let at = [soup.len().to_string(), " ".into(), cur.len().to_string()].concat();
        return Err(Error::mesh(name, ["refused stl-cut 0 ", &at].concat()));
    }
    Ok(soup)
}

/// Merges bit-identical vertices of a triangle soup.
fn weld_soup(soup: &[[[f32; 3]; 3]]) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let flat: Vec<[f32; 3]> = soup.iter().flat_map(|t| t.iter().copied()).collect();
    let (unique, remap) = dedupe(&flat);
    let triangles = remap.as_chunks::<3>().0.to_vec();
    (unique, triangles)
}

/// Unique points by bit pattern and, for every input point, its index in
/// the unique list. The unique list is in sorted bit order, found with one
/// parallel sort, so the result does not depend on thread count.
pub(crate) fn dedupe(points: &[[f32; 3]]) -> (Vec<[f32; 3]>, Vec<u32>) {
    let bits = |p: &[f32; 3]| p.map(f32::to_bits);
    // Points a weld already made are unique and in bit order: they come out as they are.
    if points
        .windows(2)
        .all(|w| matches!(w, [a, b] if bits(a) < bits(b)))
    {
        #[allow(clippy::cast_possible_truncation, reason = "vertex counts fit in u32")]
        return (points.to_vec(), (0..points.len() as u32).collect());
    }
    // The bits of x, y, z and the index in one key, so the sort compares one number.
    #[allow(clippy::cast_possible_truncation, reason = "vertex counts fit in u32")]
    let mut keys: Vec<u128> = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let [x, y, z] = bits(p);
            (u128::from(x) << 96) | (u128::from(y) << 64) | (u128::from(z) << 32) | i as u128
        })
        .collect();
    crate::par::sort(&mut keys);
    let mut unique = Vec::with_capacity(points.len());
    let mut remap = vec![0u32; points.len()];
    let mut last: Option<u128> = None;
    for &key in &keys {
        let k = key >> 32;
        if last != Some(k) {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "each coordinate is 32 bits of the key"
            )]
            unique.push([(k >> 64) as u32, (k >> 32) as u32, k as u32].map(f32::from_bits));
            last = Some(k);
        }
        #[allow(clippy::cast_possible_truncation, reason = "vertex counts fit in u32")]
        if let Some(slot) = remap.get_mut((key as u32) as usize) {
            *slot = (unique.len() - 1) as u32;
        }
    }
    (unique, remap)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c)? << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        let take = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        out.extend_from_slice(bytes.get(1..=take)?);
    }
    Some(out)
}

pub(crate) struct Fnv(u64);

impl Fnv {
    pub(crate) fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
    pub(crate) fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    pub(crate) fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "import")]
    #[test]
    fn obj_and_amf_load_through_the_importers() {
        let obj =
            b"o box\nv 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nv 0 0 10\nv 10 0 10\nv 10 10 10\nv 0 10 10\n\
f 1 3 2\nf 1 4 3\nf 5 6 7\nf 5 7 8\nf 1 2 6\nf 1 6 5\nf 2 3 7\nf 2 7 6\nf 3 4 8\nf 3 8 7\nf 4 1 5\nf 4 5 8\n";
        let m = Mesh::load(obj, "box.obj").unwrap();
        assert_eq!(m.triangle_count(), 12);
        assert!(m.bounds().unwrap().1.iter().all(|c| (c - 10.0).abs() < 1e-4));
        let amf = br#"<?xml version="1.0"?><amf unit="millimeter"><object id="0"><mesh><vertices>
<vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
<vertex><coordinates><x>5</x><y>0</y><z>0</z></coordinates></vertex>
<vertex><coordinates><x>0</x><y>5</y><z>0</z></coordinates></vertex>
<vertex><coordinates><x>0</x><y>0</y><z>5</z></coordinates></vertex></vertices>
<volume><triangle><v1>0</v1><v2>2</v2><v3>1</v3></triangle><triangle><v1>0</v1><v2>1</v2><v3>3</v3></triangle>
<triangle><v1>1</v1><v2>2</v2><v3>3</v3></triangle><triangle><v1>0</v1><v2>3</v2><v3>2</v3></triangle></volume></mesh></object></amf>"#;
        let a = Mesh::load(amf, "tet.amf").unwrap();
        assert_eq!(a.triangle_count(), 4);
        assert!(Mesh::load(b"not an obj at all", "x.obj").is_err());
    }

    #[test]
    fn raw_parts_load() {
        let mut b = b"SXMP".to_vec();
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(2);
        b.extend_from_slice(&1u16.to_le_bytes());
        b.push(b'a');
        b.extend_from_slice(&3u32.to_le_bytes());
        for v in [0f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&1u32.to_le_bytes());
        for i in [0u32, 1, 2] {
            b.extend_from_slice(&i.to_le_bytes());
        }
        let m = Mesh::load(&b, "raw").unwrap();
        assert_eq!(m.parts[0].slot, 2);
        // An object keeps the name of the file it came from, so a part named "x-mark.stl" in a project still loads.
        assert_eq!(Mesh::load(&b, "x-mark.stl").unwrap().triangle_count(), 1);
        assert_eq!(m.triangle_count(), 1);
        assert!(Mesh::load(&b[..20], "raw").is_err());
        // Writing it back gives the same bytes.
        assert_eq!(m.to_raw(), b);
    }

    #[test]
    fn base64_round_trip() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
    }

    #[test]
    fn ascii_stl_loads_and_welds() {
        let stl = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex 1 0 0\nvertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
        let m = Mesh::load(stl.as_bytes(), "t.stl").unwrap();
        assert_eq!(m.triangle_count(), 2);
        assert_eq!(m.parts[0].positions.len(), 4);
    }

    #[test]
    fn an_empty_cut_off_or_not_a_number_stl_is_refused() {
        let err = |text: &str| Mesh::load(text.as_bytes(), "t.stl").unwrap_err().to_string();
        assert!(err("solid t\nendsolid t\n").contains("refused stl-empty"));
        assert!(
            err("solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n")
                .contains("refused stl-cut 0 0 2")
        );
        let nan = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex nan 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
        assert!(err(nan).contains("refused stl-number 0 0"));
        // A binary STL whose header starts with "solid" still loads as binary.
        let mut bin = b"solid but binary".to_vec();
        bin.resize(80, b' ');
        bin.extend_from_slice(&1u32.to_le_bytes());
        for v in [[0.0f32; 3], [0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for c in v {
                bin.extend_from_slice(&c.to_le_bytes());
            }
        }
        bin.extend_from_slice(&[0, 0]);
        assert_eq!(Mesh::load(&bin, "b.stl").unwrap().triangle_count(), 1);
        let mut empty = vec![b' '; 80];
        empty.extend_from_slice(&0u32.to_le_bytes());
        assert!(
            Mesh::load(&empty, "e.stl")
                .unwrap_err()
                .to_string()
                .contains("refused stl-empty")
        );
    }
}
