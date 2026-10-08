// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Screenshots of the main window's web view, taken by the web view itself on each platform, so no debugging port,
//! screen-recording permission or window focus is needed:
//!
//! - Windows: WebView2's `CapturePreview` writes a PNG into a memory stream.
//! - macOS: `WKWebView takeSnapshotWithConfiguration:completionHandler:` gives an `NSImage`, which
//!   `NSBitmapImageRep` turns into PNG bytes.
//! - Linux: `webkit_web_view_get_snapshot` (the visible region) gives a cairo surface, written out by `png.rs`.
//!
//! Each call starts on the main thread through `with_webview` and finishes in the web view's completion handler,
//! which sends the bytes back over a channel. The bridge's worker thread waits on that channel, never the main one.

use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

type Shot = Result<Vec<u8>, String>;

/// PNG bytes of the main window's web view.
pub fn capture(app: &AppHandle, timeout: Duration) -> Shot {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is not open")?;
    let (tx, rx) = mpsc::channel::<Shot>();
    window
        .with_webview(move |w| start(w, tx))
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout)
        .map_err(|_| "the web view did not return a screenshot in time".to_owned())?
}

#[cfg(windows)]
fn start(w: tauri::webview::PlatformWebview, tx: mpsc::Sender<Shot>) {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};

    // Reads the whole stream back from its start.
    fn read_all(stream: &IStream) -> Shot {
        let mut stat = Default::default();
        // SAFETY: plain COM calls on a stream this function's caller owns, on the thread that made it.
        unsafe {
            stream
                .Stat(&mut stat, STATFLAG_NONAME)
                .map_err(|e| e.to_string())?;
            stream.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
            let size = usize::try_from(stat.cbSize).map_err(|e| e.to_string())?;
            let mut out = vec![0u8; size];
            let mut read = 0u32;
            stream
                .Read(
                    out.as_mut_ptr().cast(),
                    u32::try_from(size).map_err(|e| e.to_string())?,
                    Some(&mut read),
                )
                .ok()
                .map_err(|e| e.to_string())?;
            out.truncate(read as usize);
            Ok(out)
        }
    }

    // SAFETY: runs on the main thread inside `with_webview`, where the controller is live; the stream is kept alive
    // by the completion handler that reads it.
    let begun = unsafe {
        (|| -> windows::core::Result<()> {
            let core = w.controller().CoreWebView2()?;
            let stream = CreateStreamOnHGlobal(Default::default(), true)?;
            let done_stream = stream.clone();
            let done_tx = tx.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let _ = done_tx.send(
                    result
                        .map_err(|e| e.to_string())
                        .and_then(|()| read_all(&done_stream)),
                );
                Ok(())
            }));
            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
        })()
    };
    if let Err(e) = begun {
        let _ = tx.send(Err(e.to_string()));
    }
}

#[cfg(target_os = "macos")]
fn start(w: tauri::webview::PlatformWebview, tx: mpsc::Sender<Shot>) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let view = w.inner().cast::<WKWebView>();
    if view.is_null() {
        let _ = tx.send(Err("no web view".to_owned()));
        return;
    }
    let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let props: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> = NSDictionary::new();
        // SAFETY: WebKit passes either a live image or a live error for the length of this call, and the properties
        // dictionary is empty, so its types hold.
        let result = unsafe {
            match image.as_ref() {
                Some(image) => image
                    .TIFFRepresentation()
                    .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                    .and_then(|rep| {
                        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
                    })
                    .map(|png| png.to_vec())
                    .ok_or_else(|| "could not turn the snapshot into PNG".to_owned()),
                None => Err(error.as_ref().map_or_else(
                    || "the web view gave no snapshot".to_owned(),
                    |e| e.localizedDescription().to_string(),
                )),
            }
        };
        let _ = tx.send(result);
    });
    // SAFETY: `view` is the live WKWebView of this window and this runs on the main thread inside `with_webview`.
    // A nil configuration snapshots the visible bounds.
    unsafe { (*view).takeSnapshotWithConfiguration_completionHandler(None, &handler) };
}

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn start(w: tauri::webview::PlatformWebview, tx: mpsc::Sender<Shot>) {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    w.inner().snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let shot = result.map_err(|e| e.to_string()).and_then(|surface| {
                let image = cairo::ImageSurface::try_from(surface)
                    .map_err(|_| "the snapshot is not an image surface".to_owned())?;
                image.flush();
                let (width, height) = (
                    u32::try_from(image.width()).map_err(|e| e.to_string())?,
                    u32::try_from(image.height()).map_err(|e| e.to_string())?,
                );
                let stride = usize::try_from(image.stride()).map_err(|e| e.to_string())?;
                let mut rgba = Err("the snapshot's pixels could not be read".to_owned());
                image
                    .with_data(|data| rgba = super::png::rgba_from_cairo_argb32(width, height, stride, data))
                    .map_err(|e| e.to_string())?;
                super::png::encode_rgba(width, height, &rgba?)
            });
            let _ = tx.send(shot);
        },
    );
}
