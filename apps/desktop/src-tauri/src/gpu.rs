// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The GL renderer this machine draws with, read once from a small offscreen EGL context (Linux only). WebKitGTK
//! gives pages a made-up GPU name, so the page cannot tell Mesa's software renderer (llvmpipe) from a real GPU and
//! would start the 3D view on the high quality tier; the shell can tell, and the page asks it.
use std::sync::OnceLock;

static RENDERER: OnceLock<Option<String>> = OnceLock::new();

/// Reads the renderer in the background at startup, so the page's first request finds it ready.
pub fn warm() {
    std::thread::spawn(renderer);
}

pub fn renderer() -> Option<String> {
    RENDERER.get_or_init(probe).clone()
}

/// The GL_RENDERER string, or null where the shell does not read it (Windows and macOS report it to the page).
#[tauri::command]
pub async fn gl_renderer() -> Option<String> {
    tauri::async_runtime::spawn_blocking(renderer)
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "linux")]
fn probe() -> Option<String> {
    // SAFETY: egl::renderer only calls EGL and GL entry points it looked up, with arguments it owns.
    unsafe { egl::renderer() }
}

#[cfg(not(target_os = "linux"))]
fn probe() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
mod egl {
    //! The few EGL and GLES calls the probe needs, loaded at run time so the app starts without libEGL too.
    use std::ffi::{CStr, c_char, c_int, c_uint, c_void};

    unsafe extern "C" {
        fn dlopen(file: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    }

    const RTLD_NOW: c_int = 2;
    const EGL_NONE: c_int = 0x3038;
    const EGL_SURFACE_TYPE: c_int = 0x3033;
    const EGL_PBUFFER_BIT: c_int = 0x0001;
    const EGL_RENDERABLE_TYPE: c_int = 0x3040;
    const EGL_OPENGL_ES2_BIT: c_int = 0x0004;
    const EGL_WIDTH: c_int = 0x3057;
    const EGL_HEIGHT: c_int = 0x3056;
    const EGL_CONTEXT_CLIENT_VERSION: c_int = 0x3098;
    const EGL_OPENGL_ES_API: c_uint = 0x30A0;
    const GL_RENDERER: c_uint = 0x1F01;

    type Ptr = *mut c_void;

    unsafe fn sym<T>(lib: Ptr, name: &CStr) -> Option<T> {
        let p = unsafe { dlsym(lib, name.as_ptr()) };
        // SAFETY: T is the function pointer type of `name`, the same size as a pointer.
        (!p.is_null()).then(|| unsafe { std::mem::transmute_copy::<Ptr, T>(&p) })
    }

    pub unsafe fn renderer() -> Option<String> {
        let egl = unsafe { dlopen(c"libEGL.so.1".as_ptr(), RTLD_NOW) };
        if egl.is_null() {
            return None;
        }
        unsafe {
            let get_display: unsafe extern "C" fn(Ptr) -> Ptr = sym(egl, c"eglGetDisplay")?;
            let initialize: unsafe extern "C" fn(Ptr, *mut c_int, *mut c_int) -> c_uint =
                sym(egl, c"eglInitialize")?;
            let bind_api: unsafe extern "C" fn(c_uint) -> c_uint = sym(egl, c"eglBindAPI")?;
            let choose_config: unsafe extern "C" fn(
                Ptr,
                *const c_int,
                *mut Ptr,
                c_int,
                *mut c_int,
            ) -> c_uint = sym(egl, c"eglChooseConfig")?;
            let create_pbuffer: unsafe extern "C" fn(Ptr, Ptr, *const c_int) -> Ptr =
                sym(egl, c"eglCreatePbufferSurface")?;
            let create_context: unsafe extern "C" fn(Ptr, Ptr, Ptr, *const c_int) -> Ptr =
                sym(egl, c"eglCreateContext")?;
            let make_current: unsafe extern "C" fn(Ptr, Ptr, Ptr, Ptr) -> c_uint =
                sym(egl, c"eglMakeCurrent")?;
            let destroy_context: unsafe extern "C" fn(Ptr, Ptr) -> c_uint = sym(egl, c"eglDestroyContext")?;
            let destroy_surface: unsafe extern "C" fn(Ptr, Ptr) -> c_uint = sym(egl, c"eglDestroySurface")?;
            let terminate: unsafe extern "C" fn(Ptr) -> c_uint = sym(egl, c"eglTerminate")?;
            let get_proc: unsafe extern "C" fn(*const c_char) -> Ptr = sym(egl, c"eglGetProcAddress")?;

            let dpy = get_display(std::ptr::null_mut());
            if dpy.is_null() || initialize(dpy, std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
                return None;
            }
            let mut out = None;
            let attrs = [
                EGL_SURFACE_TYPE,
                EGL_PBUFFER_BIT,
                EGL_RENDERABLE_TYPE,
                EGL_OPENGL_ES2_BIT,
                EGL_NONE,
            ];
            let mut config: Ptr = std::ptr::null_mut();
            let mut n: c_int = 0;
            if bind_api(EGL_OPENGL_ES_API) != 0
                && choose_config(dpy, attrs.as_ptr(), &mut config, 1, &mut n) != 0
                && n > 0
            {
                let surface = create_pbuffer(dpy, config, [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE].as_ptr());
                let context = create_context(
                    dpy,
                    config,
                    std::ptr::null_mut(),
                    [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE].as_ptr(),
                );
                if !surface.is_null()
                    && !context.is_null()
                    && make_current(dpy, surface, surface, context) != 0
                {
                    let p = get_proc(c"glGetString".as_ptr());
                    if !p.is_null() {
                        let get_string: unsafe extern "C" fn(c_uint) -> *const c_char =
                            std::mem::transmute_copy(&p);
                        let s = get_string(GL_RENDERER);
                        if !s.is_null() {
                            out = Some(CStr::from_ptr(s).to_string_lossy().into_owned());
                        }
                    }
                    make_current(
                        dpy,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    );
                }
                if !context.is_null() {
                    destroy_context(dpy, context);
                }
                if !surface.is_null() {
                    destroy_surface(dpy, surface);
                }
            }
            terminate(dpy);
            out
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_renderer_once_and_never_panics() {
        // Off Linux there is nothing to read; on a Linux test machine with or without EGL it is a name or null.
        let a = super::renderer();
        let b = super::renderer();
        assert_eq!(a, b);
        #[cfg(not(target_os = "linux"))]
        assert_eq!(a, None);
        if let Some(name) = a {
            assert!(!name.is_empty());
        }
    }
}
