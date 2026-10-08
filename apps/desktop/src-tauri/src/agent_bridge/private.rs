// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Files only this user can read: the connection file with the token, and the G-code exports. A file is always made
//! new (never written through a file or link already at its path), and the export folder must be a real folder this
//! user owns that no one else can open. On Windows each file is created with its own access list: this user and
//! SYSTEM, nothing inherited, so it stays private even in a shared folder `SX_AGENT_BRIDGE_TOKEN_FILE` may name.

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
            format!(
                "{} {why}; the bridge writes only into a folder of this user's",
                dir.display()
            ),
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
/// first, never written through: the file is created with O_EXCL (and O_NOFOLLOW on macOS and Linux; on Windows,
/// CREATE_NEW with an owner-only access list from the start).
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

#[cfg(windows)]
fn create_new(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows::Win32::Foundation::{GENERIC_WRITE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
    };
    use windows::core::PCWSTR;

    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    // D:P keeps the folder's entries from being inherited; FA is full access, for this user and SYSTEM only.
    let sddl = wide(format!("D:P(A;;FA;;;SY)(A;;FA;;;{})", user_sid()?).as_ref());
    let name = wide(path.as_os_str());
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: the SDDL string is NUL-terminated and outlives the call; sd receives a LocalAlloc'd descriptor, freed
    // below once CreateFileW has used it.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &raw mut sd,
            None,
        )
        .map_err(std::io::Error::other)?;
    }
    let attrs = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(0),
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    };
    // SAFETY: the path is NUL-terminated and attrs points at a valid descriptor for the length of the call.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            Some(&raw const attrs),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    };
    // SAFETY: sd came from ConvertStringSecurityDescriptorToSecurityDescriptorW and is freed exactly once.
    unsafe {
        LocalFree(Some(HLOCAL(sd.0)));
    }
    let handle = handle.map_err(|e| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF))?;
    // SAFETY: CreateFileW returned a new, valid file handle that nothing else owns.
    Ok(unsafe { std::fs::File::from_raw_handle(handle.0 as RawHandle) })
}

/// This process's user, as a SID string (S-1-5-21-...).
#[cfg(windows)]
fn user_sid() -> std::io::Result<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::PWSTR;

    let mut token = HANDLE::default();
    // SAFETY: GetCurrentProcess is a pseudo handle; token receives a handle that is closed below.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) }
        .map_err(std::io::Error::other)?;
    let mut len = 0u32;
    // SAFETY: the first call only asks for the size; the second fills a buffer of that size, aligned for TOKEN_USER,
    // which stays alive while the SID in it is read.
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &raw mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &raw mut len);
        let _ = CloseHandle(token);
        got.map_err(std::io::Error::other)?;
        let user = &*buf.as_ptr().cast::<TOKEN_USER>();
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &raw mut text).map_err(std::io::Error::other)?;
        let sid = text.to_string().map_err(std::io::Error::other);
        LocalFree(Some(HLOCAL(text.0.cast())));
        sid
    }
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
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
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
                assert_eq!(
                    std::fs::metadata(d).unwrap().permissions().mode() & 0o777,
                    0o700,
                    "{}",
                    d.display()
                );
            }
        }
        let _ = std::fs::remove_dir_all(base);
    }

    /// The file's access list as SDDL: protected, with full access for this user and SYSTEM and nothing else.
    #[cfg(windows)]
    #[test]
    fn windows_files_get_an_owner_only_access_list() {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        };
        use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
        use windows::core::{HSTRING, PWSTR};

        let dir = scratch("private-dacl");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agent-bridge.json");
        write_private(&file, b"{}").unwrap();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let mut text = PWSTR::null();
        // SAFETY: the out pointers are valid; both buffers are LocalAlloc'd by the system and freed here.
        let sddl = unsafe {
            let err = GetNamedSecurityInfoW(
                &HSTRING::from(file.as_os_str()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &raw mut sd,
            );
            assert_eq!(err.0, 0, "GetNamedSecurityInfoW");
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &raw mut text,
                None,
            )
            .unwrap();
            let s = text.to_string().unwrap();
            LocalFree(Some(HLOCAL(text.0.cast())));
            LocalFree(Some(HLOCAL(sd.0)));
            s
        };
        let me = user_sid().unwrap();
        assert!(sddl.starts_with("D:P"), "{sddl}");
        let mut aces: Vec<String> = sddl
            .trim_start_matches("D:P")
            .split_inclusive(')')
            .map(str::to_owned)
            .collect();
        aces.sort();
        let mut want = vec!["(A;;FA;;;SY)".to_owned(), format!("(A;;FA;;;{me})")];
        want.sort();
        assert_eq!(aces, want, "{sddl}");
        assert_eq!(std::fs::read(&file).unwrap(), b"{}");
        let _ = std::fs::remove_dir_all(dir);
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
        assert_eq!(
            own_dir(&mine, uid.wrapping_add(1)).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );

        // An open folder of this user's is closed.
        std::fs::set_permissions(&mine, std::fs::Permissions::from_mode(0o777)).unwrap();
        own_dir(&mine, uid).unwrap();
        assert_eq!(
            std::fs::metadata(&mine).unwrap().permissions().mode() & 0o777,
            0o700
        );
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
