//! How the page learns its connection (R130, R155): an initialization script, run before any app
//! code in the main frame only, sets `window.__AO_SERVICE__ = { baseUrl, token }` exactly as the
//! end-to-end harness does (e2e/fixtures.ts); `packages/ui/src/serviceConnection.ts` reads it once
//! and deletes it. The script also checks the page's own address, so no other page could ever
//! receive it. And which addresses the main window may show at all.

use tauri::Url;

/// The page's origins in the shell: `tauri://localhost` (macOS, Linux) and `http://tauri.localhost`
/// (Windows, Android). Both are the service's `SHELL_ORIGINS` (apps/library-service/src/auth.ts);
/// no other origin is ever used.
pub const SHELL_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

fn is_app_url(url: &Url) -> bool {
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")))
}

/// The JavaScript that hands the page its connection.
pub fn init_script(base_url: &str, token: &str) -> String {
    let conn = serde_json::json!({ "baseUrl": base_url, "token": token });
    format!(
        "(function () {{\n  \
           if (window.top !== window) return;\n  \
           var p = window.location.protocol, h = window.location.hostname;\n  \
           if (!((p === \"tauri:\" && h === \"localhost\") || (p === \"http:\" && h === \"tauri.localhost\"))) return;\n  \
           window.__AO_SERVICE__ = {conn};\n\
         }})();\n"
    )
}

/// Whether the main window may navigate to `url`: only the app's own pages. A `blob:` document made
/// by the app itself (an archived HTML snapshot shown in `SnapshotFrame`, frame-src blob:) and
/// `about:blank`/`about:srcdoc` frames are allowed; anything remote is refused (no remote content).
pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "http" => is_app_url(url),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "blob" => Url::parse(url.path()).map(|inner| is_app_url(&inner)).unwrap_or(false),
        _ => false,
    }
}

/// The service's base address on the loopback interface.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_sets_the_connection_as_json_for_the_apps_own_main_frame_only() {
        let s = init_script("http://127.0.0.1:43210", "0123abcd");
        assert!(s.contains(r#"window.__AO_SERVICE__ = {"baseUrl":"http://127.0.0.1:43210","token":"0123abcd"};"#), "{s}");
        assert!(s.contains("window.top !== window"));
        assert!(s.contains(r#"p === "tauri:" && h === "localhost""#));
        assert!(s.contains(r#"p === "http:" && h === "tauri.localhost""#));
    }

    #[test]
    fn the_script_escapes_what_it_embeds() {
        let s = init_script("http://127.0.0.1:1\"</script>", "a\"b\\c");
        assert!(s.contains(r#""baseUrl":"http://127.0.0.1:1\"</script>""#));
        assert!(s.contains(r#""token":"a\"b\\c""#));
    }

    #[test]
    fn navigation_is_limited_to_the_apps_own_pages() {
        let ok = ["tauri://localhost/", "tauri://localhost/library/x?y=1", "http://tauri.localhost/index.html", "about:blank", "blob:tauri://localhost/5f0e-11", "blob:http://tauri.localhost/abc"];
        for u in ok {
            assert!(navigation_allowed(&Url::parse(u).unwrap()), "{u}");
        }
        let refused = [
            "https://example.org/",
            "http://127.0.0.1:4000/",
            "http://localhost/",
            "tauri://evil/",
            "http://tauri.localhost.evil.org/",
            "file:///etc/passwd",
            "blob:https://example.org/abc",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
            "about:config",
        ];
        for u in refused {
            assert!(!navigation_allowed(&Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn base_url_is_the_loopback_address() {
        assert_eq!(base_url(5123), "http://127.0.0.1:5123");
    }
}
