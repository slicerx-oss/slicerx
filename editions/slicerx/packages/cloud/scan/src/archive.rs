// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Zip and 3MF safety. Every entry is audited from the central directory
//! before anything is inflated, entries are read with hard caps, and the
//! result is a new archive built only from parts the library understands.
//! Nothing the uploader wrote (names, timestamps, permissions, extra fields,
//! comments) survives into the output.

use std::collections::HashSet;
use std::io::{Cursor, Read, Seek, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::limits::Limits;
use crate::png;
use crate::reject::{Reject, printable};
use crate::sniff::forbidden_magic;
use crate::xmlcheck;

/// Extensions that are never acceptable anywhere in an archive.
const DANGEROUS_EXT: &[&str] = &[
    "exe", "dll", "so", "dylib", "sys", "drv", "ocx", "scr", "com", "msi", "msp", "bat", "cmd", "ps1",
    "psm1", "psd1", "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "hta", "jar", "class", "sh", "bash",
    "zsh", "csh", "fish", "command", "py", "pyc", "pl", "rb", "php", "lua", "tcl", "app", "pkg", "dmg",
    "deb", "rpm", "apk", "ipa", "lnk", "url", "reg", "cpl", "inf", "docm", "xlsm", "pptm", "dotm", "xlam",
    "xlsb", "vba", "bas", "iso", "img", "elf", "bin", "o", "a", "html", "htm", "svg", "xhtml", "swf", "chm",
    "scf", "pif", "gadget", "workflow", "action", "zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "tar", "cab",
    "jnlp",
];

/// Extensions of files that slicers write next to a model and the library
/// does not use. They are removed, not refused.
const UNUSED_EXT: &[&str] = &[
    "config", "xml", "json", "txt", "md5", "sha", "sha1", "sha256", "jpg", "jpeg", "ini", "csv", "md",
];

/// Content types a 3MF may declare.
fn content_type_ok(t: &str) -> bool {
    let t = t.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(
        t.as_str(),
        "application/vnd.openxmlformats-package.relationships+xml"
            | "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
            | "application/vnd.ms-package.3dmanufacturing-3dmodeltexture"
            | "application/vnd.ms-printing.printticket+xml"
            | "image/png"
            | "image/jpeg"
            | "text/xml"
            | "application/xml"
            | "text/plain"
            | "application/json"
            | "text/x.gcode"
            | "text/x-gcode"
            | "application/x-gcode"
    ) || t.starts_with("application/vnd.slicerx.")
}

/// One audited entry.
#[derive(Debug, Clone)]
pub struct Entry {
    pub index: usize,
    pub name: String,
    lower: String,
    pub size: u64,
    pub is_dir: bool,
}

fn zip_err(e: &zip::result::ZipError) -> Reject {
    Reject::new("zip_invalid", format!("the zip archive cannot be read: {e}"))
}

fn extension(lower: &str) -> &str {
    let last = lower.rsplit('/').next().unwrap_or(lower);
    last.rsplit_once('.').map_or("", |(_, e)| e)
}

fn check_name(name: &str, limits: &Limits) -> Result<(), Reject> {
    let bad = |why: &str| {
        Reject::new(
            "zip_bad_name",
            format!("archive entry {:?} {why}", printable(name)),
        )
    };
    if name.is_empty() {
        return Err(bad("has no name"));
    }
    if name.len() > limits.max_name_bytes {
        return Err(bad("has a name that is too long"));
    }
    if name.chars().any(char::is_control) {
        return Err(bad("has control characters in its name"));
    }
    if name.contains(['\\', ':']) || name.starts_with('/') {
        return Err(Reject::new(
            "zip_path_traversal",
            format!(
                "archive entry {:?} has an absolute or platform specific path",
                printable(name)
            ),
        ));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut depth = 0usize;
    for seg in trimmed.split('/') {
        if seg == ".." || seg == "." || seg.is_empty() {
            return Err(Reject::new(
                "zip_path_traversal",
                format!("archive entry {:?} tries to leave the archive", printable(name)),
            ));
        }
        if seg.ends_with(['.', ' ']) {
            return Err(bad("has a segment that ends in a dot or a space"));
        }
        depth += 1;
    }
    if depth > limits.max_path_depth {
        return Err(bad("is nested too deeply"));
    }
    Ok(())
}

/// Audits the central directory. Nothing is inflated here.
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the central directory, each check is a few lines"
)]
pub fn audit<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    archive_len: u64,
    limits: &Limits,
    deny_ext: bool,
) -> Result<Vec<Entry>, Reject> {
    if zip.is_empty() {
        return Err(Reject::new("zip_empty", "the zip archive has no entries"));
    }
    if zip.len() > limits.max_entries {
        return Err(Reject::new(
            "zip_too_many_entries",
            format!(
                "the zip archive has {} entries, the limit is {}",
                zip.len(),
                limits.max_entries
            ),
        ));
    }
    if zip.has_overlapping_files().map_err(|e| zip_err(&e))? {
        return Err(Reject::new(
            "zip_overlap",
            "entries of the zip archive overlap each other",
        ));
    }
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    let mut entries = Vec::with_capacity(zip.len());
    for index in 0..zip.len() {
        let f = zip.by_index_raw(index).map_err(|e| zip_err(&e))?;
        let name = f.name().to_owned();
        check_name(&name, limits)?;
        let lower = name.to_ascii_lowercase();
        if !seen.insert(lower.clone()) {
            return Err(Reject::new(
                "zip_duplicate_entry",
                format!("archive entry {:?} appears twice", printable(&name)),
            ));
        }
        if f.encrypted() {
            return Err(Reject::new(
                "zip_encrypted",
                "the zip archive has encrypted entries",
            ));
        }
        if let Some(mode) = f.unix_mode() {
            match mode & 0o170_000 {
                0 | 0o100_000 | 0o040_000 => {}
                0o120_000 => {
                    return Err(Reject::new(
                        "zip_symlink",
                        format!("archive entry {:?} is a symbolic link", printable(&name)),
                    ));
                }
                _ => {
                    return Err(Reject::new(
                        "zip_special_file",
                        format!("archive entry {:?} is not a regular file", printable(&name)),
                    ));
                }
            }
        }
        if !matches!(
            f.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(Reject::new(
                "zip_compression",
                "the zip archive uses a compression method other than store or deflate",
            ));
        }
        let (size, packed) = (f.size(), f.compressed_size());
        let is_dir = f.is_dir();
        if is_dir && size != 0 {
            return Err(Reject::new("zip_invalid", "a directory entry has content"));
        }
        if size > limits.max_entry_bytes {
            return Err(Reject::new(
                "zip_entry_too_large",
                format!(
                    "archive entry {:?} inflates to {size} bytes, the limit is {}",
                    printable(&name),
                    limits.max_entry_bytes
                ),
            ));
        }
        if size > limits.ratio_floor_bytes && size / packed.max(1) > limits.max_ratio {
            return Err(Reject::new(
                "zip_bomb",
                format!(
                    "archive entry {:?} compresses more than {} to 1",
                    printable(&name),
                    limits.max_ratio
                ),
            ));
        }
        total = total.saturating_add(size);
        if total > limits.max_total_bytes {
            return Err(Reject::new(
                "zip_total_too_large",
                format!(
                    "the zip archive inflates to more than {} bytes",
                    limits.max_total_bytes
                ),
            ));
        }
        if let Some(ext) =
            Some(extension(lower.trim_end_matches('/'))).filter(|e| deny_ext && DANGEROUS_EXT.contains(e))
        {
            return Err(Reject::new(
                "zip_executable",
                format!(
                    "archive entry {:?} is a .{ext} file, which the library does not accept",
                    printable(&name)
                ),
            ));
        }
        if deny_ext && (lower.contains("vbaproject") || lower.contains("/macros/")) {
            return Err(Reject::new(
                "zip_macro",
                format!("archive entry {:?} looks like a macro", printable(&name)),
            ));
        }
        entries.push(Entry {
            index,
            name,
            lower,
            size,
            is_dir,
        });
    }
    if total > limits.ratio_floor_bytes && total / archive_len.max(1) > limits.max_ratio {
        return Err(Reject::new(
            "zip_bomb",
            format!("the zip archive compresses more than {} to 1", limits.max_ratio),
        ));
    }
    Ok(entries)
}

/// Reads up to `n` bytes from the start of an entry.
pub fn read_head<R: Read + Seek>(zip: &mut ZipArchive<R>, index: usize, n: u64) -> Result<Vec<u8>, Reject> {
    let f = zip.by_index(index).map_err(|e| zip_err(&e))?;
    let mut head = Vec::new();
    f.take(n)
        .read_to_end(&mut head)
        .map_err(|e| Reject::new("zip_corrupt", format!("an archive entry cannot be inflated: {e}")))?;
    Ok(head)
}

/// Reads a whole entry. The declared size is checked first, the read is
/// capped at it, and the entry must inflate to exactly that many bytes.
pub fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, entry: &Entry) -> Result<Vec<u8>, Reject> {
    let f = zip.by_index(entry.index).map_err(|e| zip_err(&e))?;
    let mut buf = Vec::with_capacity(usize::try_from(entry.size.min(64 << 20)).unwrap_or(0));
    f.take(entry.size.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| Reject::new("zip_corrupt", format!("an archive entry cannot be inflated: {e}")))?;
    if u64::try_from(buf.len()).ok() != Some(entry.size) {
        return Err(Reject::new(
            "zip_size_mismatch",
            format!(
                "archive entry {:?} does not inflate to the size it declares",
                printable(&entry.name)
            ),
        ));
    }
    Ok(buf)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    ContentTypes,
    Rels,
    Model,
    Settings,
    Thumbnail,
    Texture,
}

enum Action {
    Keep(Kind),
    Strip(&'static str),
}

fn classify(lower: &str) -> Result<Action, Reject> {
    let ext = extension(lower);
    if lower == "[content_types].xml" {
        return Ok(Action::Keep(Kind::ContentTypes));
    }
    if ext == "rels" && (lower == "_rels/.rels" || lower.contains("/_rels/")) {
        return Ok(Action::Keep(Kind::Rels));
    }
    if ext == "model" && lower.starts_with("3d/") {
        return Ok(Action::Keep(Kind::Model));
    }
    if matches!(ext, "gcode" | "bgcode" | "gco" | "nc" | "g") {
        return Ok(Action::Strip("embedded G-code"));
    }
    if lower == "metadata/model_settings.config" {
        return Ok(Action::Keep(Kind::Settings));
    }
    if lower.starts_with("3d/textures/") && ext == "png" {
        return Ok(Action::Keep(Kind::Texture));
    }
    if (lower.starts_with("metadata/") || lower.starts_with("auxiliaries/")) && ext == "png" {
        return Ok(Action::Keep(Kind::Thumbnail));
    }
    if (lower.starts_with("metadata/") || lower.starts_with("auxiliaries/")) && UNUSED_EXT.contains(&ext) {
        return Ok(Action::Strip(
            "slicer settings or auxiliary file the library does not use",
        ));
    }
    Err(Reject::new(
        "zip_unexpected_entry",
        format!("the archive has an unexpected file {:?}", printable(lower)),
    ))
}

/// The result of sanitizing a 3MF.
#[derive(Debug)]
pub struct Sanitized {
    /// The rebuilt archive.
    pub bytes: Vec<u8>,
    /// `name: reason` for every entry that was removed.
    pub stripped: Vec<String>,
}

/// Audits a 3MF and rebuilds it from the parts that pass. Executables,
/// scripts, macros, encrypted or nested archives and anything unexpected
/// reject the file. Embedded G-code, slicer settings and thumbnails that do
/// not decode are removed.
pub fn sanitize_3mf(bytes: &[u8], limits: &Limits) -> Result<Sanitized, Reject> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|e| zip_err(&e))?;
    let entries = audit(
        &mut zip,
        u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        limits,
        true,
    )?;

    let mut kept: Vec<(Entry, Kind, Vec<u8>)> = Vec::new();
    let mut stripped: Vec<(String, &'static str)> = Vec::new();
    let mut removed: HashSet<String> = HashSet::new();
    let mut kept_bytes: u64 = 0;
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        let head = read_head(&mut zip, entry.index, 512)?;
        if head.starts_with(b"PK") {
            return Err(Reject::new(
                "zip_nested_archive",
                format!("archive entry {:?} is another archive", printable(&entry.name)),
            ));
        }
        if let Some(what) = forbidden_magic(&head) {
            return Err(Reject::new(
                "zip_forbidden_content",
                format!("archive entry {:?} is {what}", printable(&entry.name)),
            ));
        }
        match classify(&entry.lower)? {
            Action::Strip(why) => {
                removed.insert(entry.lower.clone());
                stripped.push((entry.name.clone(), why));
            }
            Action::Keep(kind) => {
                if kind != Kind::Model
                    && entry.size > limits.max_xml_part_bytes
                    && kind != Kind::Thumbnail
                    && kind != Kind::Texture
                {
                    return Err(Reject::new(
                        "zip_part_too_large",
                        format!(
                            "archive entry {:?} is too large for its type",
                            printable(&entry.name)
                        ),
                    ));
                }
                kept_bytes = kept_bytes.saturating_add(entry.size);
                if kept_bytes > limits.max_total_bytes {
                    return Err(Reject::new("zip_total_too_large", "the kept parts are too large"));
                }
                let data = read_entry(&mut zip, &entry)?;
                if let Some(data) = check_part(kind, data, &entry, limits)? {
                    kept.push((entry, kind, data));
                } else {
                    removed.insert(entry.lower.clone());
                    stripped.push((entry.name.clone(), "thumbnail does not decode"));
                }
            }
        }
    }
    if !kept.iter().any(|(_, k, _)| *k == Kind::Model) {
        return Err(Reject::new("zip_no_model", "the archive has no 3D model part"));
    }
    for (entry, kind, data) in &mut kept {
        if *kind == Kind::Rels {
            let dir = entry
                .name
                .rfind("_rels/")
                .map_or("", |i| entry.name[..i].trim_end_matches('/'));
            *data = xmlcheck::rewrite_rels(data, dir, &removed)
                .map_err(|e| Reject::new("xml_invalid", format!("{}: {e}", printable(&entry.name))))?;
        }
    }
    kept.sort_by(|a, b| {
        let rank = |e: &Entry| match e.lower.as_str() {
            "[content_types].xml" => 0,
            "_rels/.rels" => 1,
            _ => 2,
        };
        rank(&a.0).cmp(&rank(&b.0)).then_with(|| a.0.name.cmp(&b.0.name))
    });
    let bytes = write_zip(kept.iter().map(|(e, k, d)| {
        (
            e.name.as_str(),
            *k == Kind::Thumbnail || *k == Kind::Texture,
            d.as_slice(),
        )
    }))?;
    Ok(Sanitized {
        bytes,
        stripped: stripped
            .into_iter()
            .map(|(n, why)| format!("{n}: {why}"))
            .collect(),
    })
}

/// Validates one kept part. `None` means a thumbnail that has to be removed.
fn check_part(kind: Kind, data: Vec<u8>, entry: &Entry, limits: &Limits) -> Result<Option<Vec<u8>>, Reject> {
    let xml_err = |e: String| Reject::new("xml_invalid", format!("{}: {e}", printable(&entry.name)));
    match kind {
        Kind::ContentTypes => {
            xmlcheck::validate(&data, limits.max_xml_depth).map_err(xml_err)?;
            for t in xmlcheck::content_types(&data).map_err(xml_err)? {
                if !content_type_ok(&t) {
                    return Err(Reject::new(
                        "zip_content_type",
                        format!("the archive declares the content type {:?}", printable(&t)),
                    ));
                }
            }
            Ok(Some(data))
        }
        Kind::Rels | Kind::Model | Kind::Settings => {
            xmlcheck::validate(&data, limits.max_xml_depth).map_err(xml_err)?;
            Ok(Some(data))
        }
        Kind::Thumbnail => Ok(png::check(&data, limits.max_png_side).ok().map(|p| p.rebuild())),
        Kind::Texture => png::check(&data, limits.max_png_side)
            .map(|p| Some(p.rebuild()))
            .map_err(|e| {
                Reject::new(
                    "png_invalid",
                    format!("texture {:?} does not decode: {e}", printable(&entry.name)),
                )
            }),
    }
}

/// Writes a fresh zip with fixed timestamps and permissions. `stored` parts
/// (already compressed images) are not deflated again.
pub fn write_zip<'a>(parts: impl Iterator<Item = (&'a str, bool, &'a [u8])>) -> Result<Vec<u8>, Reject> {
    let fail = |e: &dyn std::fmt::Display| Reject::new("zip_write", format!("cannot write the archive: {e}"));
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, stored, data) in parts {
        let method = if stored {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        let options = SimpleFileOptions::default()
            .compression_method(method)
            .last_modified_time(DateTime::default())
            .unix_permissions(0o644)
            .large_file(u64::try_from(data.len()).unwrap_or(u64::MAX) >= u64::from(u32::MAX));
        out.start_file(name, options).map_err(|e| fail(&e))?;
        out.write_all(data).map_err(|e| fail(&e))?;
    }
    Ok(out.finish().map_err(|e| fail(&e))?.into_inner())
}
