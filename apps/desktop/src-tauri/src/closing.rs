//! The closing window (FR-297, R470 c). When the app closes, the shell waits up to SHUTDOWN_GRACE for
//! its helpers (lib.rs, `RunEvent::ExitRequested`); until they are gone nothing of the app would be
//! seen. If they have not gone AFTER the close began (`due`), the shell opens this small window of
//! the app's own: titled TITLE, showing the interface's static page PAGE (packages/ui/closing.html:
//! one sentence, no controls). It goes with the app when the helpers have gone; closing it by its
//! own close button changes nothing (the shell goes on waiting, then exits as it always does).
//!
//! What the window cannot do. No capability names it (capabilities/main-window.json is for `main`
//! only; a test here pins that), so Tauri refuses every command of the app to it; it never receives
//! the connection script (the main window's builder only), so it cannot reach the service; it may
//! navigate only within the app's own pages and opens no other window.

use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// The window's label. No capability names it.
pub const LABEL: &str = "closing";
/// The window's title (the page's own <title> is the same words; a test checks both).
pub const TITLE: &str = "Closing Alexandrine Oxiana";
/// The one sentence the page shows (packages/ui/closing.html; a test checks it is there).
pub const SENTENCE: &str = "Your library is being closed safely. This can take up to a minute and a half.";
/// The interface's page, in the build the shell embeds.
pub const PAGE: &str = "closing.html";
/// How long after the close began the window is shown, if the helpers have not gone by then. Under
/// it nothing is shown: the ordinary close takes less, and nothing flashes.
pub const AFTER: Duration = Duration::from_secs(2);
pub const WIDTH: f64 = 440.0;
pub const HEIGHT: f64 = 160.0;

/// Whether the closing window is to be shown, `waited` after the close began: only once AFTER has
/// passed, only while the helpers have not gone, and never when the start failed (the start's error
/// window is the only window then; the shell exits non-zero as it always has).
pub fn due(waited: Duration, helpers_gone: bool, start_failed: bool) -> bool {
    waited >= AFTER && !helpers_gone && !start_failed
}

/// Opens the closing window. In test mode (debug builds, NODE_ENV=test) it reports on standard
/// output that it was opened, its title and whether it is visible, the page's title once loaded, and
/// that it was closed — the launch check reads these lines.
pub fn open(app: &AppHandle, test_mode: bool) {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title(TITLE)
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        // R486 i: shown without taking the keyboard's focus — it appears two seconds after the close,
        // perhaps while the researcher types elsewhere. (Still shown: tao shows a window built unfocused;
        // on macOS it orders it to the front without making it the key window.)
        .focused(false)
        .on_navigation(|url| crate::connection::navigation_allowed(url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .devtools(false);
    if test_mode {
        builder = builder.on_document_title_changed(|_, title| println!("AO_SHELL_CLOSING_PAGE {title}"));
    }
    match builder.build() {
        Ok(w) => {
            if test_mode {
                w.on_window_event(|e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        println!("AO_SHELL_CLOSING_WINDOW_CLOSED");
                    }
                });
                println!("AO_SHELL_CLOSING_WINDOW title={} visible={}", w.title().unwrap_or_default(), w.is_visible().unwrap_or(false));
            }
        }
        // Not shown: the close goes on as it would without it.
        Err(_) => {
            if test_mode {
                println!("AO_SHELL_CLOSING_WINDOW_FAILED");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn shown_only_after_two_seconds_while_the_helpers_have_not_gone_and_never_after_a_failed_start() {
        assert_eq!(AFTER, Duration::from_secs(2));
        // The ordinary close: the helpers gone before two seconds, nothing shown.
        for ms in [0, 500, 1_999] {
            assert!(!due(Duration::from_millis(ms), false, false), "{ms} ms");
            assert!(!due(Duration::from_millis(ms), true, false), "{ms} ms");
        }
        // Two seconds and more, the helpers still running: shown.
        for ms in [2_000, 2_001, 30_000, 95_000] {
            assert!(due(Duration::from_millis(ms), false, false), "{ms} ms");
        }
        // The helpers gone: never shown, however long it took.
        for ms in [2_000, 30_000, 95_000] {
            assert!(!due(Duration::from_millis(ms), true, false), "{ms} ms");
        }
        // A start that failed: never shown.
        for ms in [0, 2_000, 95_000] {
            assert!(!due(Duration::from_millis(ms), false, true), "{ms} ms");
            assert!(!due(Duration::from_millis(ms), true, true), "{ms} ms");
        }
    }

    #[test]
    fn the_page_is_the_interfaces_closing_page_with_the_same_title_and_the_sentence() {
        let page = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/ui").join(PAGE);
        let html = fs::read_to_string(&page).unwrap();
        assert!(html.contains(&format!("<title>{TITLE}</title>")), "{html}");
        assert!(html.contains(&format!("<p>{SENTENCE}</p>")), "{html}");
        for control in ["<button", "<a ", "<input", "<select", "<textarea", "<form"] {
            assert!(!html.contains(control), "{control}");
        }
    }

    #[test]
    fn the_closing_window_is_granted_nothing() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let read = |p: PathBuf| -> serde_json::Value { serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap() };
        let names_it = |v: &serde_json::Value| v.to_string().contains(&format!("\"{LABEL}\""));
        // Every capability file names the main window only, and none names this one.
        let files: Vec<PathBuf> = fs::read_dir(root.join("capabilities")).unwrap().map(|e| e.unwrap().path()).collect();
        assert!(!files.is_empty());
        for f in files {
            let cap = read(f);
            assert_eq!(cap["windows"], serde_json::json!(["main"]), "{cap}");
            assert!(cap.get("webviews").is_none() && !names_it(&cap) && !cap.to_string().contains('*'), "{cap}");
        }
        // The set the build made (compiled into this program): main-window alone, naming main alone.
        let built = read(root.join("gen/schemas/capabilities.json"));
        let built = built.as_object().unwrap();
        assert_eq!(built.keys().collect::<Vec<_>>(), vec!["main-window"]);
        for cap in built.values() {
            assert_eq!(cap["windows"], serde_json::json!(["main"]), "{cap}");
            assert!(cap.get("webviews").is_none() && !names_it(cap), "{cap}");
        }
        let conf = read(root.join("tauri.conf.json"));
        assert_eq!(conf["app"]["security"]["capabilities"], serde_json::json!(["main-window"]));
        assert!(!names_it(&conf));
        // The window is the shell's own, opened by `open` with no initialisation script: it never gets the
        // connection script (the service's address and token) and no probe.
        let src = include_str!("closing.rs");
        let open_fn = &src[src.find("pub fn open(").unwrap()..src.find("#[cfg(test)]").unwrap()];
        for forbidden in ["initialization_script", "init_script", "connection::init", "probe", "token", "WebviewUrl::External"] {
            assert!(!open_fn.contains(forbidden), "{forbidden}");
        }
        // R486 i: it is built without taking the keyboard's focus (it may appear while the researcher types
        // elsewhere), and still shown (`visible` is left at its default, true).
        assert!(open_fn.contains(".focused(false)"), "the closing window takes the keyboard's focus");
        assert!(!open_fn.contains(".visible("), "the closing window's visibility is changed");
    }
}
