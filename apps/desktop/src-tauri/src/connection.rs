//! How the page learns its connection (R130, R155): an initialization script, run before any app
//! code in the main frame only, sets `window.__AO_SERVICE__ = { baseUrl, token }` exactly as the
//! end-to-end harness does (e2e/fixtures.ts); `packages/ui/src/serviceConnection.ts` reads it once
//! and deletes it. And which addresses the main window may show at all.
//!
//! Both are tied to the app's ONE origin on the platform it runs on, compared whole (scheme, host
//! and port): `tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows and Android
//! (Tauri's custom-protocol origins; both are in the service's `SHELL_ORIGINS`,
//! apps/library-service/src/auth.ts). On macOS and Linux `http://tauri.localhost` is NOT the app:
//! it is plain HTTP to whatever local program answers that name, on any port, so it never receives
//! the token and the window never goes there.

use tauri::Url;

/// The app's origin on macOS and Linux.
pub const CUSTOM_SCHEME_ORIGIN: &str = "tauri://localhost";
/// The app's origin on Windows and Android.
pub const HTTP_ORIGIN: &str = "http://tauri.localhost";

/// The app's origin on the platform this program was built for.
pub const APP_ORIGIN: &str = if cfg!(any(windows, target_os = "android")) { HTTP_ORIGIN } else { CUSTOM_SCHEME_ORIGIN };

/// Whether `url` is a page of the app whose origin is `origin` (exact scheme, host and port).
fn is_origin(origin: &str, url: &Url) -> bool {
    let Ok(o) = Url::parse(origin) else { return false };
    url.scheme() == o.scheme() && url.host_str() == o.host_str() && url.port_or_known_default() == o.port_or_known_default()
}

/// The JavaScript that hands the page of `origin` its connection.
pub fn init_script_for(origin: &str, base_url: &str, token: &str) -> String {
    let conn = serde_json::json!({ "baseUrl": base_url, "token": token });
    let origin = serde_json::Value::from(origin);
    format!(
        "(function () {{\n  \
           if (window.top !== window) return;\n  \
           if (window.location.origin !== {origin}) return;\n  \
           window.__AO_SERVICE__ = {conn};\n\
         }})();\n"
    )
}

/// The connection script for this platform's app origin.
pub fn init_script(base_url: &str, token: &str) -> String {
    init_script_for(APP_ORIGIN, base_url, token)
}

/// Whether the main window of the app at `origin` may navigate to `url`: only the app's own pages.
/// A `blob:` document made by the app itself (an archived HTML snapshot shown in `SnapshotFrame`,
/// frame-src blob:) and `about:blank`/`about:srcdoc` frames are allowed; anything else is refused
/// (no remote content).
pub fn navigation_allowed_for(origin: &str, url: &Url) -> bool {
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "blob" => Url::parse(url.path()).map(|inner| is_origin(origin, &inner)).unwrap_or(false),
        _ => is_origin(origin, url),
    }
}

/// The navigation rule for this platform's app origin.
pub fn navigation_allowed(url: &Url) -> bool {
    navigation_allowed_for(APP_ORIGIN, url)
}

/// The service's base address on the loopback interface.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Runs the script in Node with a stand-in window at `href` (top frame unless `framed`), and
    /// returns what it set on `window.__AO_SERVICE__` (JSON, or "undefined").
    fn run_script(script: &str, href: &str, framed: bool) -> String {
        let harness = format!(
            r#"const u = new URL({href});
const origin = u.protocol === "tauri:" ? "tauri://" + u.host : u.origin;
const window = {{ location: {{ origin, protocol: u.protocol, hostname: u.hostname, port: u.port }} }};
window.top = {framed} ? {{}} : window;
{script}
process.stdout.write(JSON.stringify(window.__AO_SERVICE__) ?? "undefined");"#,
            href = serde_json::Value::from(href),
        );
        let out = std::process::Command::new("node").args(["--input-type=module", "-e", &harness]).output().expect("node on PATH");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn the_token_reaches_only_the_apps_exact_origin_on_macos_and_linux() {
        let s = init_script_for(CUSTOM_SCHEME_ORIGIN, "http://127.0.0.1:43210", TOKEN);
        let set = format!(r#"{{"baseUrl":"http://127.0.0.1:43210","token":"{TOKEN}"}}"#);
        assert_eq!(run_script(&s, "tauri://localhost/", false), set);
        assert_eq!(run_script(&s, "tauri://localhost/library?project=p1", false), set);
        for foreign in ["http://tauri.localhost/", "http://tauri.localhost:8123/", "tauri://localhost:8123/", "tauri://evil/", "http://localhost/", "https://example.org/", "http://tauri.localhost.evil.org/"] {
            assert_eq!(run_script(&s, foreign, false), "undefined", "{foreign}");
        }
        assert_eq!(run_script(&s, "tauri://localhost/", true), "undefined", "a frame");
    }

    #[test]
    fn the_token_reaches_only_the_apps_exact_origin_on_windows() {
        let s = init_script_for(HTTP_ORIGIN, "http://127.0.0.1:43210", TOKEN);
        assert!(run_script(&s, "http://tauri.localhost/", false).contains(TOKEN));
        for foreign in ["tauri://localhost/", "http://tauri.localhost:8123/", "https://tauri.localhost/", "http://tauri.localhost.evil.org/", "http://localhost/"] {
            assert_eq!(run_script(&s, foreign, false), "undefined", "{foreign}");
        }
    }

    #[test]
    fn the_script_escapes_what_it_embeds() {
        let s = init_script_for(CUSTOM_SCHEME_ORIGIN, "http://127.0.0.1:1\"</script>", "a\"b\\c");
        assert!(s.contains(r#""baseUrl":"http://127.0.0.1:1\"</script>""#));
        assert!(s.contains(r#""token":"a\"b\\c""#));
    }

    #[test]
    fn navigation_is_limited_to_the_apps_exact_origin_on_macos_and_linux() {
        let ok = ["tauri://localhost/", "tauri://localhost/library/x?y=1", "about:blank", "about:srcdoc", "blob:tauri://localhost/5f0e-11"];
        for u in ok {
            assert!(navigation_allowed_for(CUSTOM_SCHEME_ORIGIN, &Url::parse(u).unwrap()), "{u}");
        }
        let refused = [
            "http://tauri.localhost/index.html",
            "http://tauri.localhost:8123/",
            "blob:http://tauri.localhost:9999/abc",
            "blob:http://tauri.localhost/abc",
            "tauri://localhost:8123/",
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
            assert!(!navigation_allowed_for(CUSTOM_SCHEME_ORIGIN, &Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn navigation_is_limited_to_the_apps_exact_origin_on_windows() {
        for u in ["http://tauri.localhost/", "http://tauri.localhost:80/x", "blob:http://tauri.localhost/abc", "about:blank"] {
            assert!(navigation_allowed_for(HTTP_ORIGIN, &Url::parse(u).unwrap()), "{u}");
        }
        for u in ["tauri://localhost/", "http://tauri.localhost:8123/", "https://tauri.localhost/", "blob:http://tauri.localhost:9999/abc", "http://tauri.localhost.evil.org/"] {
            assert!(!navigation_allowed_for(HTTP_ORIGIN, &Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn this_build_uses_its_platforms_origin() {
        let want = if cfg!(any(windows, target_os = "android")) { HTTP_ORIGIN } else { CUSTOM_SCHEME_ORIGIN };
        assert_eq!(APP_ORIGIN, want);
        assert!(navigation_allowed(&Url::parse(&format!("{want}/")).unwrap()));
        assert!(init_script("http://127.0.0.1:1", TOKEN).contains(&format!("!== {}", serde_json::Value::from(want))));
    }

    #[test]
    fn base_url_is_the_loopback_address() {
        assert_eq!(base_url(5123), "http://127.0.0.1:5123");
    }
}
