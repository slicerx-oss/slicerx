// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Files only this user can read: the connection file with the token, and the G-code exports. A file is always made
//! new (never written through a file or link already at its path), and the export folder must be a real folder this
//! user owns that no one else can open.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The folder exports go under: `$XDG_RUNTIME_DIR` on Linux when it is set (a per-user folder the system clears at
/// logout), else the given per-user cache folder. Never the shared temporary folder.
pub fn export_base(cache: PathBuf) -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return run;
    }
    cache
}

/// Makes `dir` and the folder above it for exports, each a real folder (not a link) of this user's that no one else
/// can open (mode 0700 on macOS and Linux), and refuses folders that are not. The folders above those two are made as
/// needed.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    let parent = dir.parent().unwrap_or(dir);
    if let Some(base) = parent.parent() {
        std::fs::create_dir_all(base)?;
    }
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        own_dir(parent, uid)?;
        own_dir(dir, uid)
    }
    #[cfg(not(unix))]
    {
        // Windows: the folders sit in the user's own profile, which only the user (and the system) can open.
        std::fs::create_dir_all(dir)
    }
}

/// Makes one folder with mode 0700, or checks the one already there: a folder, not a link, owned by `uid`, and closed
/// to others (an open one of this user's is closed).
#[cfg(unix)]
pub fn own_dir(dir: &Path, uid: u32) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    let meta = std::fs::symlink_metadata(dir)?;
    let refuse = |why: &str| {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} {why}; the bridge writes only into a folder of this user's", dir.display()),
        ))
    };
    if !meta.file_type().is_dir() {
        return refuse("is not a folder (a link or a file)");
    }
    if meta.uid() != uid {
        return refuse("belongs to another user");
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `bytes` to a new file at `path`, readable only by this user. A file or link already at the path is removed
/// first, never written through: the file is created with O_EXCL (and O_NOFOLLOW on macOS and Linux).
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut f = create_new(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(unix)]
fn create_new(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn create_new(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sx-bridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_file_is_made_new_and_never_written_through_a_link() {
        let dir = scratch("private-file");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("plate.gcode");
        write_private(&file, b"first").unwrap();
        write_private(&file, b"second").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            // A link planted at the path is replaced; what it points at is left alone.
            let target = dir.join("target.txt");
            std::fs::write(&target, b"keep").unwrap();
            std::fs::remove_file(&file).unwrap();
            std::os::unix::fs::symlink(&target, &file).unwrap();
            write_private(&file, b"g-code").unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"keep");
            assert!(!std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
            assert_eq!(std::fs::read(&file).unwrap(), b"g-code");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_export_folder_is_made_private() {
        let base = scratch("private-dir");
        let dir = base.join("slicerx-agent-bridge").join("42");
        private_dir(&dir).unwrap();
        private_dir(&dir).unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for d in [&dir, &base.join("slicerx-agent-bridge")] {
                assert_eq!(std::fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o700, "{}", d.display());
            }
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_open_or_foreign_folder_is_refused_or_closed() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch("private-refuse");
        std::fs::create_dir_all(&base).unwrap();
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };

        // A link where the folder should be, as another user could plant in a shared folder.
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = base.join("slicerx-agent-bridge");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let e = private_dir(&link.join("42")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!elsewhere.join("42").exists());

        // A folder of someone else's.
        let mine = base.join("mine");
        std::fs::create_dir(&mine).unwrap();
        assert_eq!(own_dir(&mine, uid.wrapping_add(1)).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);

        // An open folder of this user's is closed.
        std::fs::set_permissions(&mine, std::fs::Permissions::from_mode(0o777)).unwrap();
        own_dir(&mine, uid).unwrap();
        assert_eq!(std::fs::metadata(&mine).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_prefers_the_runtime_folder() {
        let cache = PathBuf::from("/home/u/.cache/app");
        match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
            Some(run) if run.is_absolute() => assert_eq!(export_base(cache), run),
            _ => assert_eq!(export_base(cache.clone()), cache),
        }
    }
}
