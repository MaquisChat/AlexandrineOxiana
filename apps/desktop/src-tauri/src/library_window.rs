//! The sign-in window (Task F16; R225 rulings 1, 7 and 8; R301; R325). A researcher whose library
//! gives access to a work presses "Get through my library"; the page asks the shell to open ONE
//! separate window, labelled `library`, on the library's address, where the researcher signs in as in
//! any browser and reaches the PDF. The shell — never the page, never the service — then fetches that
//! PDF with the window's own cookies into a private inbox folder and tells the service, by one line on
//! its standard-input pipe, where the file is. The file then waits for the researcher's check (R301):
//! the app never adds it to a source by itself, which is what the window's title says.
//!
//! What the window cannot do. It loads outside pages, so it gets nothing of the app: no capability
//! names it (capabilities/main-window.json is for `main` only, and Tauri refuses every command to a
//! window or a remote origin no capability names), no event is sent to it (events go to `main` by
//! label), it never receives the connection script (that is the main window's builder only), and it
//! shares no cookie or storage with the main window (its own data store on macOS, an ephemeral one
//! elsewhere). Its start-up script (`library_window.js`, main frame only, at most 2 KiB) reads one
//! `meta` and may call `location.assign` once; it makes no request, defines nothing a page could call
//! and sends nothing to the shell.
//!
//! What the shell fetches, and when (R325 b, c). Only while a ticket is open (the page passes it with
//! `open_library_window`; it is the service's, F15), one fetch at a time, at most ONE file per ticket,
//! and not within PAUSE of the last hand-over. A fetch starts when a page finishes loading at an
//! address that `looks_like_pdf_address` and is not a `sign_in_address`, when the window asks to
//! start a download (its own download is refused; the download's address is fetched instead, R331 g),
//! or when the researcher presses "Add the PDF showing in the sign-in window"
//! (`library_window_take_pdf`). The one request
//! path is `fetch_pdf` (plan A1, point 8: it can later be replaced by the web view's own download):
//! https on every hop, at most MAX_REDIRECTS redirects followed by hand, each hop's host resolved by
//! the shell, checked (`address_allowed`) and connected TO THAT ADDRESS (reqwest's resolve override,
//! with a resolver that refuses every other look-up), the cookies worked out afresh for each hop
//! from the window's cookies read once at the start, a sign-in address never requested, at most
//! MAX_BYTES and TOTAL_LIMIT, and `%PDF-` in the first SNIFF_BYTES or nothing is kept.
//!
//! The hand-over. The file is written exclusively as `<inbox>/<grant>.part` (0600, in a 0700 folder
//! that is the user's and not a symlink), renamed to `<grant>.pdf` only when complete, and named to
//! the service by the second line shape (`file_grant_line`), written by the same writer as the folder
//! grants (`ServiceInput::send_line`), under the same lock, never before the token line and never
//! when the service is not running. A part file is removed on every failure and when the window's
//! closing cancels the fetch; the inbox is emptied at the shell's start and at quit (R325 g).
//!
//! Nothing printed (R325 c). No cookie, address, ticket, grant id or path is printed, logged, put in
//! an error text or a panic message by this module; in test mode the shell prints
//! `AO_SHELL_LIBRARY <state>` with the state word only. Events carry the ticket (to `main` only,
//! which already holds it) and the state.
//!
//! The store (R325 d). `<app_data>/library-window.json` (0600, written atomically) holds
//! `{"staySignedIn": bool, "store": "<32 hex>", "signInHosts": [<host>, …]}` — the hosts a library's
//! start opened the window at, which live as long as the store (R360 a). The emptying — close the window, remove every data
//! store the web view lists, make a new store id — runs at quit, at the next start (after a forced
//! quit, a crash or a power loss), and on `sign_out_of_library`; "Stay signed in" (macOS only) keeps
//! the store across quits, never across a sign-out. Everything that only a Mac runs is in one small
//! function per need at the end of this file, each with the other platforms' form beside it.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::Cookie;
use tauri::Url;

use crate::grant::{GrantTarget, GRANT_LINE_MAX_BYTES, GRANT_PATH_MAX_BYTES};

/// The window's label. No capability names it (a test pins that).
pub const LABEL: &str = "library";
/// The only window whose page may ask anything of the sign-in window.
pub const MAIN: &str = "main";
/// The window's title says where it is and what to do there (R347 b; R325 a, R301: a fetched file
/// waits for the researcher's check): the host of the page shown (`title_host`), " — ", then these
/// words for the kind of start (`window_title`). The shell alone sets it; a page cannot.
pub const TITLE_LIBRARY: &str = "sign in to your library, then open the PDF and the app will fetch it for you to check";
pub const TITLE_LINK: &str = "open the PDF on this page and the app will fetch it for you to check";
/// A host longer than this is shown by its last characters (where its registered name is), after "…".
pub const TITLE_HOST_MAX: usize = 64;
pub const WIDTH: f64 = 1100.0;
pub const HEIGHT: f64 = 800.0;
/// The event sent to the main window.
pub const EVENT: &str = "library-window";
/// The start-up script (main frame only).
pub const SCRIPT: &str = include_str!("library_window.js");
pub const SCRIPT_MAX_BYTES: usize = 2048;
/// The least time between a hand-over and the next fetch (the service counts it too, F15).
pub const PAUSE: Duration = Duration::from_secs(20);
/// The largest file fetched: 200 MB, counted by the bytes that pass.
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;
/// The whole of one fetch, every hop and the body included.
pub const TOTAL_LIMIT: Duration = Duration::from_secs(180);
/// Connecting, waiting for an answer's headers, a look-up, and any pause in the body.
pub const IDLE_LIMIT: Duration = Duration::from_secs(30);
/// `%PDF-` must be within this many first bytes.
pub const SNIFF_BYTES: usize = 1024;
/// The longest `Cookie:` header sent.
pub const COOKIE_HEADER_MAX: usize = 8192;
/// The longest address the window is opened at.
pub const WINDOW_URL_MAX: usize = 4096;
/// The longest address handed to the researcher's browser (R325 f; R356 f: as long as the window takes,
/// the longest library address the service builds).
pub const BROWSER_URL_MAX: usize = 4096;
/// The inbox's folder name under the service's settings folder (AO_CONFIG_DIR).
pub const INBOX: &str = "library-inbox";
/// The device file's name under the app's data folder.
pub const DEVICE_FILE: &str = "library-window.json";

/// The window's User-Agent, set on the window and sent with the shell's fetch, so that both are the
/// same: WebKit's own form with Safari's version tokens (some sign-in pages refuse an unknown browser).
#[cfg(target_os = "macos")]
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
#[cfg(not(target_os = "macos"))]
pub const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

// ---------------------------------------------------------------------------------------------
// The event

/// The window's state as the main window hears it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Opened,
    Fetching,
    HandedOver,
    NotAPdf,
    Failed,
    Closed,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::Opened => "opened",
            State::Fetching => "fetching",
            State::HandedOver => "handed-over",
            State::NotAPdf => "not-a-pdf",
            State::Failed => "failed",
            State::Closed => "closed",
        }
    }
}

/// Why nothing was fetched, when the shell refused before any request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// No ticket is open (none was given, or its file was already handed over).
    NoTicket,
    /// A fetch is already under way.
    Busy,
    /// Within PAUSE of the last hand-over.
    Pause,
    /// The address is a sign-in address: the window is left where it is.
    SignIn,
    /// The address is not https.
    NotHttps,
    /// The app is closing.
    Stopping,
}

impl Reason {
    pub fn word(self) -> &'static str {
        match self {
            Reason::NoTicket => "no-ticket",
            Reason::Busy => "busy",
            Reason::Pause => "pause",
            Reason::SignIn => "sign-in-address",
            Reason::NotHttps => "not-https",
            Reason::Stopping => "stopping",
        }
    }
}

/// `{ ticket, state, reason? }` to the main window. The ticket is null when none is open.
#[derive(Clone, PartialEq, Eq)]
pub struct LibraryEvent {
    pub ticket: Option<String>,
    pub state: State,
    pub reason: Option<Reason>,
}

impl LibraryEvent {
    pub fn new(ticket: Option<&str>, state: State) -> Self {
        LibraryEvent { ticket: ticket.map(str::to_owned), state, reason: None }
    }

    pub fn refused(ticket: Option<&str>, state: State, reason: Reason) -> Self {
        LibraryEvent { ticket: ticket.map(str::to_owned), state, reason: Some(reason) }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({ "ticket": self.ticket, "state": self.state.word() });
        if let Some(r) = self.reason {
            v["reason"] = r.word().into();
        }
        v
    }
}

/// Never the ticket.
impl fmt::Debug for LibraryEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LibraryEvent").field("state", &self.state).field("reason", &self.reason).finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------------------------
// What the page may pass

/// A ticket from the service: 32 lower-case hex.
pub fn valid_ticket(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An https address without user name or password, of at most `max` characters, with no white space
/// or control character anywhere (the URL parser would silently drop some of them).
fn https_address(s: &str, max: usize) -> Option<Url> {
    if s.is_empty() || s.chars().count() > max || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let u = Url::parse(s).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.host_str().is_none() || u.cannot_be_a_base() {
        return None;
    }
    Some(u)
}

/// The kind of start that opened the window (R347 a), kept with that window's ticket (`Inner::start`):
/// "Get through my library" opens it at the library's sign-in address, where the host it was opened at
/// is the library's sign-in host and is never fetched from; "Open it here and fetch the PDF" opens it
/// at one of the entry's own links (a repository's or a publisher's page), which adds no sign-in host
/// of its own. Every host a library's start opened the window at stays a sign-in host for every later
/// ticket of either kind while the window's store lives (R360 a; `DeviceState::sign_in_hosts`). The
/// path and query rules of `sign_in_address` hold for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Start {
    #[default]
    Library,
    Link,
}

impl Start {
    /// `from` as the page passes it to `open_library_window`: absent means "library" (the stricter
    /// rule; Tauri gives a JSON null as absent too); exactly "library" or "link"; anything else —
    /// another word, another case, white space, not text — is None, and the command is refused.
    pub fn from_arg(from: Option<&serde_json::Value>) -> Option<Start> {
        match from {
            None => Some(Start::Library),
            Some(v) => match v.as_str() {
                Some("library") => Some(Start::Library),
                Some("link") => Some(Start::Link),
                _ => None,
            },
        }
    }

    /// The title's words for this kind of start.
    pub fn words(self) -> &'static str {
        match self {
            Start::Library => TITLE_LIBRARY,
            Start::Link => TITLE_LINK,
        }
    }
}

/// The host of the page shown, as the title begins (R347 b): its plain ASCII form (the URL parser
/// gives an internationalised name in its `xn--` form, lower case; an IPv6 address in brackets),
/// never a user name or password; the port only when it is not 443 (`:80` for a page that is not
/// https); a `blob:` page by the page that made it; a page with no host (`about:blank`) as
/// "no web address". Only printable ASCII is kept (anything else, which the parser does not let
/// through, would become `?`), and a host longer than TITLE_HOST_MAX characters is shown as "…" and
/// its last TITLE_HOST_MAX - 1 characters, so that the name it is registered under stays in sight.
pub fn title_host(url: &Url) -> String {
    let inner;
    let url = if url.scheme() == "blob" {
        match Url::parse(url.path()) {
            Ok(u) if matches!(u.scheme(), "https" | "http") => {
                inner = u;
                &inner
            }
            _ => return "no web address".to_string(),
        }
    } else {
        url
    };
    let Some(host) = url.host_str() else { return "no web address".to_string() };
    let host: String = host.chars().map(|c| if c.is_ascii_graphic() { c.to_ascii_lowercase() } else { '?' }).collect();
    let n = host.chars().count();
    let host = if n > TITLE_HOST_MAX { format!("…{}", host.chars().skip(n - (TITLE_HOST_MAX - 1)).collect::<String>()) } else { host };
    match url.port_or_known_default() {
        Some(p) if p != 443 => format!("{host}:{p}"),
        _ => host,
    }
}

/// The window's title for the page at `url` in a window of this kind of start (R347 b).
pub fn window_title(url: &Url, start: Start) -> String {
    titled(&title_host(url), start)
}

/// The window's title from the host part as `title_host` gives it.
fn titled(shown_host: &str, start: Start) -> String {
    format!("{shown_host} — {}", start.words())
}

/// The address the window may be opened at (`open_library_window`).
pub fn window_address(s: &str) -> Option<Url> {
    https_address(s, WINDOW_URL_MAX)
}

/// The address the researcher's browser may be given (`open_in_browser`, R325 f).
pub fn browser_address(s: &str) -> Option<Url> {
    https_address(s, BROWSER_URL_MAX)
}

/// The sign-in window's navigation rule (it is called for every frame): web pages, and the blank,
/// srcdoc and blob documents pages make for their frames. Never the app's own scheme, a file, a
/// script address, data, or a scheme that would start another program.
pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "https" | "http" => true,
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "blob" => Url::parse(url.path()).map(|inner| matches!(inner.scheme(), "https" | "http")).unwrap_or(false),
        _ => false,
    }
}

/// What a request for a new window (`window.open`, a link with a target) becomes: the address loads
/// in the sign-in window itself when it is a web page; anything else is refused. No second window.
pub fn new_window_target(url: &Url) -> Option<Url> {
    matches!(url.scheme(), "https" | "http").then(|| url.clone())
}

// ---------------------------------------------------------------------------------------------
// Addresses

/// The path with its %XX sequences decoded (invalid ones kept), lower-cased.
fn plain_path(url: &Url) -> String {
    let b = url.path().as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

/// Whether the address looks like a PDF's: its path ends `.pdf`, or holds `/pdf/`, `/pdfdirect/`,
/// `/pdfft`, `/doi/pdf`, `/article-pdf/`, `/bitstream/` or `/download`, or its query has a `pdf` or
/// `download` parameter. Web addresses only.
pub fn looks_like_pdf_address(url: &Url) -> bool {
    if !matches!(url.scheme(), "https" | "http") {
        return false;
    }
    let path = plain_path(url);
    const PARTS: [&str; 7] = ["/pdf/", "/pdfdirect/", "/pdfft", "/doi/pdf", "/article-pdf/", "/bitstream/", "/download"];
    path.ends_with(".pdf") || PARTS.iter().any(|p| path.contains(p)) || url.query_pairs().any(|(k, _)| k.eq_ignore_ascii_case("pdf") || k.eq_ignore_ascii_case("download"))
}

/// Whether the address is part of a sign-in, which a replayed GET could spoil (a single-use SAML or
/// CAS step): its path holds `/login`, `/saml`, `/sso`, `/Shibboleth.sso`, `/idp/`, `/oauth`,
/// `/authorize` or `/cas/` (and, stricter than the plan, `/logon`, `/signin`, `/sign-in`, `/wayf`,
/// and ADFS's `/adfs/`, OpenID Connect's `/openid-connect/` and simpleSAMLphp's `/simplesaml`, R331 e),
/// in any case and percent-encoded or not; its query carries a SAML message or artifact (`SAMLart`),
/// a CAS service ticket (`ticket=ST-…`) or an OAuth answer (both `code` and `state`); or its host is
/// one of the library's sign-in hosts (`DeviceState::sign_in_hosts`: the hosts a library's start
/// opened the window at), compared without one trailing dot. Such an address is never fetched by the shell.
pub fn sign_in_address<'a>(url: &Url, sign_in_hosts: impl IntoIterator<Item = &'a str>) -> bool {
    let path = plain_path(url);
    const PARTS: [&str; 15] = [
        "/login", "/saml", "/sso", "/shibboleth.sso", "/idp/", "/oauth", "/authorize", "/cas/", "/logon", "/signin", "/sign-in", "/wayf", "/adfs/", "/openid-connect/", "/simplesaml",
    ];
    if PARTS.iter().any(|p| path.contains(p)) {
        return true;
    }
    let key = |k: &str| url.query_pairs().any(|(n, _)| n.eq_ignore_ascii_case(k));
    if key("SAMLRequest") || key("SAMLResponse") || key("SAMLart") || (key("code") && key("state")) {
        return true;
    }
    if url.query_pairs().any(|(n, v)| n.eq_ignore_ascii_case("ticket") && v.starts_with("ST-")) {
        return true;
    }
    let Some(h) = url.host_str() else { return false };
    let h = bare_host(h);
    sign_in_hosts.into_iter().any(|p| bare_host(p) == h)
}

/// A host as the sign-in hosts are kept and compared: lower case, without one trailing dot.
fn bare_host(h: &str) -> String {
    h.strip_suffix('.').unwrap_or(h).to_ascii_lowercase()
}

// ---------------------------------------------------------------------------------------------
// Cookies (RFC 6265 §5.1.3, §5.1.4, §5.4)

/// A cookie of the window's store as the rules need it. Its `Debug` shows neither name nor value.
struct StoreCookie {
    name: String,
    value: String,
    /// Lower case, without a leading dot.
    domain: String,
    /// Set without a Domain attribute: sent to `domain` exactly, never to a host under it.
    host_only: bool,
    path: String,
    secure: bool,
    expires_unix: Option<i64>,
    max_age_s: Option<i64>,
}

impl fmt::Debug for StoreCookie {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoreCookie").field("host_only", &self.host_only).field("secure", &self.secure).finish_non_exhaustive()
    }
}

/// The cookie's domain as the store holds it, leading dot included. The web view marks a domain
/// cookie with a leading dot and a host-only cookie without one (NSHTTPCookie; libsoup's
/// SoupCookie), and wry passes that string to the cookie crate's builder unchanged
/// (wry 0.57.2 wkwebview/mod.rs:1155-1156, webkitgtk/mod.rs:1061-1063) — but every accessor of
/// cookie 0.18.2 strips the dot (`Cookie::domain`, lib.rs:777-785). Its derived `Debug` (lib.rs:214)
/// still shows the stored string, so it is read from the `Debug` of a copy whose name and value were
/// blanked first (nothing of the cookie's secret is ever formatted). A cookie this cannot be read
/// from is treated as host-only: it then goes to fewer hosts, never more.
fn raw_domain(c: &Cookie<'_>) -> Option<String> {
    let stripped = c.domain()?.to_string();
    if c.name_raw().is_some() {
        // Parsed from a header string (never so from the web view): the copy would still hold it.
        return Some(stripped);
    }
    let mut probe = c.clone();
    probe.set_name("");
    probe.set_value("");
    let shown = format!("{probe:?}");
    const MARK: &str = "domain: Some(Concrete(\"";
    let raw = shown.find(MARK).and_then(|i| {
        let rest = &shown[i + MARK.len()..];
        rest.find('"').map(|end| &rest[..end])
    });
    match raw {
        Some(r) if r == format!(".{stripped}") => Some(r.to_string()),
        _ => Some(stripped),
    }
}

fn store_cookie(c: &Cookie<'_>) -> Option<StoreCookie> {
    let raw = raw_domain(c)?;
    let host_only = !raw.starts_with('.');
    let domain = raw.trim_start_matches('.').to_ascii_lowercase();
    if domain.is_empty() || !domain.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']')) {
        return None;
    }
    let (name, value) = (c.name(), c.value());
    let bad = |s: &str| s.chars().any(|ch| ch.is_control() || ch == ';');
    if name.is_empty() || name.contains('=') || bad(name) || bad(value) {
        return None;
    }
    let path = c.path().filter(|p| p.starts_with('/')).unwrap_or("/").to_string();
    Some(StoreCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain,
        host_only,
        path,
        secure: c.secure().unwrap_or(false),
        expires_unix: c.expires_datetime().map(|t| t.unix_timestamp()),
        max_age_s: c.max_age().map(|d| d.whole_seconds()),
    })
}

/// RFC 6265 §5.1.3, with the host-only flag: the same host, or (a domain cookie, a host name) a host
/// under the cookie's domain at a dot.
fn domain_matches(host: &str, c: &StoreCookie) -> bool {
    let host = host.to_ascii_lowercase();
    if host == c.domain {
        return true;
    }
    if c.host_only || host.starts_with('[') || host.parse::<IpAddr>().is_ok() {
        return false;
    }
    host.len() > c.domain.len() + 1 && host.ends_with(&c.domain) && host.as_bytes()[host.len() - c.domain.len() - 1] == b'.'
}

/// RFC 6265 §5.1.4: the same path, or the cookie's path followed in the request's by a `/` (by segment).
fn path_matches(request: &str, cookie: &str) -> bool {
    request == cookie || (request.starts_with(cookie) && (cookie.ends_with('/') || request.as_bytes().get(cookie.len()) == Some(&b'/')))
}

/// The `Cookie:` header for `url` from the window's cookies: RFC 6265 §5.1.3 domain-match (a
/// host-only cookie to its exact host only), §5.1.4 path-match, `Secure` only over https, expired
/// cookies dropped; ordered as §5.4 says (longer paths first, otherwise as the store gave them). At
/// most COOKIE_HEADER_MAX bytes: the cookies are taken in that order, and the first one that would
/// make the header longer, and every one after it, are left out. None when no cookie applies (no
/// `Cookie:` header at all).
pub fn cookie_header(cookies: &[Cookie<'_>], url: &Url, now: SystemTime) -> Option<String> {
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    let host = url.host_str()?;
    let https = url.scheme() == "https";
    let path = if url.path().is_empty() { "/" } else { url.path() };
    let now = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut chosen: Vec<StoreCookie> = cookies
        .iter()
        .filter_map(store_cookie)
        .filter(|c| domain_matches(host, c) && path_matches(path, &c.path) && (https || !c.secure))
        .filter(|c| c.expires_unix.is_none_or(|t| t > now) && c.max_age_s.is_none_or(|s| s > 0))
        .collect();
    chosen.sort_by(|a, b| b.path.len().cmp(&a.path.len()));
    let mut out = String::new();
    for c in chosen {
        let sep = if out.is_empty() { 0 } else { 2 };
        if out.len() + sep + c.name.len() + 1 + c.value.len() > COOKIE_HEADER_MAX {
            break;
        }
        if sep > 0 {
            out.push_str("; ");
        }
        out.push_str(&c.name);
        out.push('=');
        out.push_str(&c.value);
    }
    (!out.is_empty()).then_some(out)
}

// ---------------------------------------------------------------------------------------------
// Where the request may go

fn v4_allowed(ip: Ipv4Addr, allow_loopback: bool) -> bool {
    let o = ip.octets();
    if ip.is_loopback() {
        return allow_loopback;
    }
    !(ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        || o[0] >= 240
        // IETF protocol assignments (192.0.0.0/24), benchmarking (198.18.0.0/15) and the three
        // documentation ranges (R331 b).
        || (o[0] == 192 && o[1] == 0 && (o[2] == 0 || o[2] == 2))
        || (o[0] == 198 && (o[1] & 0xfe) == 18)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113))
}

/// Whether the shell may connect to `ip`: never a loopback (except in test mode), private (RFC 1918),
/// carrier-grade NAT (100.64/10), link-local, unspecified, multicast, broadcast, reserved,
/// benchmarking, IETF-assigned (192.0.0.0/24) or documentation IPv4 address; never a unique-local
/// (RFC 4193), link-local, site-local, unspecified, multicast or documentation (2001:db8::/32) IPv6
/// address, nor one of the transition forms that can lead to any IPv4 host — 6to4 (2002::/16),
/// Teredo (2001::/32), the local NAT64 prefix (64:ff9b:1::/48) and SIIT (::ffff:0:0:0/96), refused
/// whole (R331 b); and an IPv6 address that carries an IPv4 one (mapped, compatible, the well-known
/// NAT64 prefix) by the IPv4 rule.
pub fn address_allowed(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_allowed(v4, allow_loopback),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4_allowed(v4, allow_loopback);
            }
            if v6.is_loopback() {
                return allow_loopback;
            }
            let s = v6.segments();
            if v6.is_unspecified() || v6.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0 {
                return false;
            }
            let transition = s[0] == 0x2002
                || (s[0] == 0x2001 && (s[1] == 0 || s[1] == 0x0db8))
                || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1)
                || s[..6] == [0, 0, 0, 0, 0xffff, 0];
            if transition {
                return false;
            }
            let embedded = || Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
            if s[..6] == [0; 6] || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4]) {
                return v4_allowed(embedded(), allow_loopback);
            }
            true
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The one request path

/// How a fetch ended without a file. The texts name no address, host, cookie, ticket or path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// The first SNIFF_BYTES bytes hold no `%PDF-`.
    NotPdf,
    /// A hop was a sign-in address: it was not requested.
    SignIn,
    /// A hop was not https.
    NotHttps,
    TooManyRedirects,
    /// A hop's address is not one the shell may connect to, or the connection was not to it.
    Refused,
    /// A hop's host could not be resolved.
    Unresolved,
    TooLarge,
    TimedOut,
    /// An answer that is neither the file nor a redirect.
    Status(u16),
    Network,
    /// The inbox could not be written.
    Write,
}

impl FetchError {
    /// The state the main window hears.
    pub fn state(self) -> State {
        match self {
            FetchError::NotPdf | FetchError::SignIn => State::NotAPdf,
            _ => State::Failed,
        }
    }
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::NotPdf => f.write_str("The page is not a PDF."),
            FetchError::SignIn => f.write_str("The address is part of a sign-in, so it was not fetched."),
            FetchError::NotHttps => f.write_str("The address is not a secure (https) address."),
            FetchError::TooManyRedirects => f.write_str("The address redirected too many times."),
            FetchError::Refused => f.write_str("The address leads to a place the app does not fetch from."),
            FetchError::Unresolved => f.write_str("The address's server could not be found."),
            FetchError::TooLarge => f.write_str("The file is larger than 200 MB."),
            FetchError::TimedOut => f.write_str("The server took too long."),
            FetchError::Status(code) => write!(f, "The server answered with status {code}."),
            FetchError::Network => f.write_str("The file could not be fetched."),
            FetchError::Write => f.write_str("The file could not be saved."),
        }
    }
}

/// The limits of one fetch (production: `FetchRules::for_shell`).
pub struct FetchRules {
    /// Test mode only (`lib.rs` `test_mode()`): a loopback address may be connected to.
    pub allow_loopback: bool,
    pub max_redirects: usize,
    pub max_bytes: u64,
    pub total: Duration,
    pub idle: Duration,
    /// Tests only: the test server's certificate, trusted instead of the system's roots.
    #[cfg(test)]
    pub roots: Vec<reqwest::Certificate>,
}

impl FetchRules {
    pub fn for_shell(test_mode: bool) -> Self {
        FetchRules {
            allow_loopback: test_mode,
            max_redirects: MAX_REDIRECTS,
            max_bytes: MAX_BYTES,
            total: TOTAL_LIMIT,
            idle: IDLE_LIMIT,
            #[cfg(test)]
            roots: Vec::new(),
        }
    }
}

/// Looks a host up (blocking). The system's resolver in the app; a table in tests.
pub trait HostResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
}

pub struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        Ok((host, port).to_socket_addrs()?.collect())
    }
}

/// Where the fetched bytes go (the part file in the app). Nothing is written before the first
/// SNIFF_BYTES bytes have shown `%PDF-`.
pub trait PdfSink: Send {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()>;
}

impl PdfSink for Vec<u8> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.extend_from_slice(bytes);
        Ok(())
    }
}

/// What a fetch starts from. Its `Debug` shows no address.
#[derive(Clone)]
pub struct FetchInput {
    /// The window's current address.
    pub url: Url,
    /// The page before it (the `Referer`, reduced to its origin and path).
    pub previous: Option<Url>,
    pub user_agent: String,
    /// The library's sign-in hosts (`DeviceState::sign_in_hosts`): never requested.
    pub sign_in_hosts: Vec<String>,
}

impl fmt::Debug for FetchInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FetchInput { .. }")
    }
}

/// A resolver for reqwest that resolves nothing: every host it may reach is given as an override.
struct NoLookup;

impl reqwest::dns::Resolve for NoLookup {
    fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(std::future::ready(Err::<reqwest::dns::Addrs, _>("no look-up outside the shell's check".into())))
    }
}

fn net(e: reqwest::Error) -> FetchError {
    // Never formatted: reqwest's error text carries the address.
    if e.is_timeout() {
        FetchError::TimedOut
    } else {
        FetchError::Network
    }
}

fn remaining(deadline: Instant) -> Result<Duration, FetchError> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()).ok_or(FetchError::TimedOut)
}

/// A hop's own checks, before anything is looked up or sent.
fn check_hop(url: &Url, sign_in_hosts: &[String]) -> Result<(), FetchError> {
    if url.scheme() != "https" {
        return Err(FetchError::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() || url.host().is_none() {
        return Err(FetchError::Refused);
    }
    if sign_in_address(url, sign_in_hosts.iter().map(String::as_str)) {
        return Err(FetchError::SignIn);
    }
    Ok(())
}

/// The address of the hop's host, resolved by the shell and checked: refused when ANY address the
/// host resolves to may not be connected to.
async fn checked_address(resolver: &Arc<dyn HostResolver>, url: &Url, rules: &FetchRules, deadline: Instant) -> Result<SocketAddr, FetchError> {
    let port = url.port_or_known_default().ok_or(FetchError::Refused)?;
    let host = url.host_str().ok_or(FetchError::Refused)?;
    let literal = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().ok();
    let ips: Vec<IpAddr> = match (literal, url.domain()) {
        (Some(ip), _) => vec![ip],
        (None, None) => return Err(FetchError::Refused),
        (None, Some(d)) => {
            let limit = remaining(deadline)?.min(rules.idle);
            let (r, host) = (resolver.clone(), d.to_string());
            let found = tauri::async_runtime::spawn_blocking(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let _ = tx.send(r.resolve(&host, port));
                });
                rx.recv_timeout(limit)
            })
            .await
            .map_err(|_| FetchError::Network)?
            .map_err(|_| FetchError::TimedOut)?
            .map_err(|_| FetchError::Unresolved)?;
            found.into_iter().map(|a| a.ip()).collect()
        }
    };
    if ips.is_empty() {
        return Err(FetchError::Unresolved);
    }
    if ips.iter().any(|ip| !address_allowed(*ip, rules.allow_loopback)) {
        return Err(FetchError::Refused);
    }
    Ok(SocketAddr::new(ips[0], port))
}

/// One client per hop: connected only to `addr` for the hop's host, no proxy, no redirect, no
/// retry, no cookie store, no cache, https only, the system's TLS.
fn hop_client(url: &Url, addr: SocketAddr, rules: &FetchRules, user_agent: &str, left: Duration) -> Result<reqwest::Client, FetchError> {
    let mut b = reqwest::Client::builder()
        .tls_backend_native()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .no_proxy()
        .pool_max_idle_per_host(0)
        .user_agent(user_agent)
        .timeout(left)
        .connect_timeout(rules.idle.min(left))
        .read_timeout(rules.idle)
        .dns_resolver(Arc::new(NoLookup));
    if let Some(d) = url.domain() {
        b = b.resolve(d, addr);
    }
    #[cfg(test)]
    {
        b = b.tls_certs_only(rules.roots.clone());
    }
    b.build().map_err(|_| FetchError::Network)
}

/// Sends a hop's request and takes the answer only from `addr`, the address that was checked: an
/// answer that came from any other address is refused.
async fn send_to(req: reqwest::RequestBuilder, addr: SocketAddr) -> Result<reqwest::Response, FetchError> {
    let resp = req.send().await.map_err(net)?;
    if resp.remote_addr() != Some(addr) {
        return Err(FetchError::Refused);
    }
    Ok(resp)
}

/// `Referer`: the previous page reduced to its origin and path (never its query, which may hold a
/// session's ticket), and to its origin alone for another origin; none from a page that was not https.
fn referer_for(previous: Option<&Url>, target: &Url) -> Option<String> {
    let p = previous?;
    if p.scheme() != "https" {
        return None;
    }
    let origin = p.origin().ascii_serialization();
    if p.origin() == target.origin() {
        Some(format!("{origin}{}", p.path()))
    } else {
        Some(format!("{origin}/"))
    }
}

fn holds_pdf_mark(head: &[u8]) -> bool {
    head[..head.len().min(SNIFF_BYTES)].windows(5).any(|w| w == b"%PDF-")
}

async fn read_body(resp: &mut reqwest::Response, max: u64, sink: &mut dyn PdfSink) -> Result<u64, FetchError> {
    let mut head: Vec<u8> = Vec::with_capacity(SNIFF_BYTES);
    let mut sniffed = false;
    let mut total: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        total += chunk.len() as u64;
        if total > max {
            return Err(FetchError::TooLarge);
        }
        if sniffed {
            sink.write(&chunk).map_err(|_| FetchError::Write)?;
            continue;
        }
        head.extend_from_slice(&chunk);
        if head.len() >= SNIFF_BYTES {
            if !holds_pdf_mark(&head) {
                return Err(FetchError::NotPdf);
            }
            sniffed = true;
            sink.write(&head).map_err(|_| FetchError::Write)?;
            head = Vec::new();
        }
    }
    if !sniffed {
        if !holds_pdf_mark(&head) {
            return Err(FetchError::NotPdf);
        }
        sink.write(&head).map_err(|_| FetchError::Write)?;
    }
    Ok(total)
}

/// THE request path (plan A1, point 8; R325 c): ONE GET for the window's address, following at most
/// `rules.max_redirects` redirects by hand. Every hop is https, never a sign-in address, its host
/// resolved and checked by the shell and the connection made to the checked address (and the answer
/// must come from it); `Accept: application/pdf`, the window's User-Agent, `Referer` from the
/// previous page (`referer_for`), and the cookies worked out afresh for the hop from the cookies
/// read ONCE at the start (`cookies`, called once). A `Set-Cookie` on a hop is not honoured: the
/// window itself already followed the way to this address and its store holds what was set on it,
/// and an answer's cookies would otherwise need the store's own rules (which a shell copy could get
/// wrong) — a publisher that needs one is a case for the web view's own download (A1, point 8). No
/// proxy, proxy credential, cookie store, cache or retry. The body: `Content-Length` above
/// `max_bytes` refused at once, the bytes counted as they pass, `%PDF-` in the first SNIFF_BYTES or
/// nothing is kept, the whole within `rules.total` and no pause longer than `rules.idle`. Returns
/// the number of bytes written to `sink`.
pub async fn fetch_pdf(
    input: FetchInput,
    cookies: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send>,
    rules: &FetchRules,
    resolver: Arc<dyn HostResolver>,
    sink: &mut dyn PdfSink,
) -> Result<u64, FetchError> {
    use reqwest::header::{ACCEPT, COOKIE, LOCATION, REFERER};
    let deadline = Instant::now() + rules.total;
    let mut url = input.url;
    url.set_fragment(None);
    // A sign-in address is never requested: checked before the cookies are even read.
    check_hop(&url, &input.sign_in_hosts)?;
    let jar = tauri::async_runtime::spawn_blocking(cookies).await.map_err(|_| FetchError::Network)?;
    let mut redirects = 0usize;
    loop {
        check_hop(&url, &input.sign_in_hosts)?;
        let addr = checked_address(&resolver, &url, rules, deadline).await?;
        let client = hop_client(&url, addr, rules, &input.user_agent, remaining(deadline)?)?;
        let mut req = client.get(url.clone()).header(ACCEPT, "application/pdf");
        if let Some(r) = referer_for(input.previous.as_ref(), &url) {
            req = req.header(REFERER, r);
        }
        if let Some(c) = cookie_header(&jar, &url, SystemTime::now()) {
            req = req.header(COOKIE, c);
        }
        let mut resp = send_to(req, addr).await?;
        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if redirects >= rules.max_redirects {
                return Err(FetchError::TooManyRedirects);
            }
            let next = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()).and_then(|l| url.join(l).ok()).ok_or(FetchError::Status(status))?;
            drop(resp);
            url = next;
            url.set_fragment(None);
            redirects += 1;
            continue;
        }
        if status != 200 && status != 203 {
            return Err(FetchError::Status(status));
        }
        if resp.content_length().is_some_and(|n| n > rules.max_bytes) {
            return Err(FetchError::TooLarge);
        }
        return read_body(&mut resp, rules.max_bytes, sink).await;
    }
}

// ---------------------------------------------------------------------------------------------
// The inbox

/// Why the inbox cannot be used. The texts name no path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboxError {
    /// It is a symlink or not a folder.
    NotAFolder,
    /// It belongs to another user.
    NotYours,
    Io,
}

impl fmt::Display for InboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            InboxError::NotAFolder => "The app's folder for fetched files is not a plain folder, so it is not used.",
            InboxError::NotYours => "The app's folder for fetched files belongs to another user, so it is not used.",
            InboxError::Io => "The app's folder for fetched files could not be prepared.",
        })
    }
}

/// `<config_dir>/library-inbox/`, made 0700 when missing; refused when it is a symlink, not a folder
/// or not the user's; its mode set to 0700 when it is not.
pub fn prepare_inbox(config_dir: &Path) -> Result<PathBuf, InboxError> {
    let dir = config_dir.join(INBOX);
    match fs::symlink_metadata(&dir) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let mut b = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                b.mode(0o700);
            }
            b.create(&dir).map_err(|_| InboxError::Io)?;
        }
        Err(_) => return Err(InboxError::Io),
    }
    let meta = fs::symlink_metadata(&dir).map_err(|_| InboxError::Io)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(InboxError::NotAFolder);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(InboxError::NotYours);
        }
        if meta.mode() & 0o777 != 0o700 {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| InboxError::Io)?;
        }
    }
    Ok(dir)
}

/// Removes everything in the inbox (R325 g: at the shell's start and at quit), never following a link.
pub fn empty_inbox(config_dir: &Path) -> Result<(), InboxError> {
    let dir = prepare_inbox(config_dir)?;
    let mut ok = true;
    for entry in fs::read_dir(&dir).map_err(|_| InboxError::Io)? {
        let Ok(entry) = entry else {
            ok = false;
            continue;
        };
        let p = entry.path();
        let gone = match fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => fs::remove_dir_all(&p),
            Ok(_) => fs::remove_file(&p),
            Err(e) => Err(e),
        };
        ok &= gone.is_ok();
    }
    ok.then_some(()).ok_or(InboxError::Io)
}

/// The file being fetched: created exclusively as `<inbox>/<grant>.part` (0600) on the first write,
/// renamed to `<grant>.pdf` by `commit`, and removed when dropped uncommitted (a failure, or the
/// fetch's cancellation by the window's closing). Its `Debug` shows no path.
pub struct PartFile {
    inbox: PathBuf,
    grant: String,
    file: Option<File>,
    created: bool,
    done: bool,
}

impl fmt::Debug for PartFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PartFile { .. }")
    }
}

impl PartFile {
    pub fn new(inbox: PathBuf, grant: String) -> Self {
        PartFile { inbox, grant, file: None, created: false, done: false }
    }

    pub fn grant(&self) -> &str {
        &self.grant
    }

    fn part_path(&self) -> PathBuf {
        self.inbox.join(format!("{}.part", self.grant))
    }

    pub fn final_path(&self) -> PathBuf {
        self.inbox.join(format!("{}.pdf", self.grant))
    }

    /// Flushes it to disk and gives it its final name.
    pub fn commit(mut self) -> io::Result<PathBuf> {
        let f = self.file.take().ok_or_else(|| io::Error::other("nothing was written"))?;
        f.sync_all()?;
        drop(f);
        let to = self.final_path();
        fs::rename(self.part_path(), &to)?;
        self.done = true;
        Ok(to)
    }
}

impl PdfSink for PartFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.file.is_none() {
            let mut o = OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            self.file = Some(o.open(self.part_path())?);
            self.created = true;
        }
        self.file.as_mut().map_or(Ok(()), |f| f.write_all(bytes))
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        drop(self.file.take());
        if self.created && !self.done {
            let _ = fs::remove_file(self.part_path());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The second line shape on the service's pipe (plan ruling 1, R225; the service's side is F17)

fn hex32(s: &str) -> bool {
    valid_ticket(s)
}

/// `{"type":"file-grant","id":"<32 hex>","ticket":"<32 hex>","path":"<absolute>"}` and `\n`: keys in
/// this order, no spaces, every value encoded by serde_json (whose escapes are JavaScript's
/// `JSON.stringify`'s), as grant.rs writes the first shape. None when an id is not 32 lower-case hex,
/// the path is relative, not UTF-8, holds a NUL or is longer than GRANT_PATH_MAX_BYTES, or the line
/// would be longer than GRANT_LINE_MAX_BYTES (8 KiB) with its line end.
pub fn file_grant_line(id: &str, ticket: &str, path: &Path) -> Option<String> {
    if !hex32(id) || !hex32(ticket) || !path.is_absolute() {
        return None;
    }
    let p = path.to_str()?;
    if p.is_empty() || p.contains('\0') || p.len() > GRANT_PATH_MAX_BYTES {
        return None;
    }
    let line = format!(
        "{{\"type\":\"file-grant\",\"id\":{},\"ticket\":{},\"path\":{}}}\n",
        serde_json::to_string(id).ok()?,
        serde_json::to_string(ticket).ok()?,
        serde_json::to_string(p).ok()?
    );
    (line.len() <= GRANT_LINE_MAX_BYTES).then_some(line)
}

/// Why a fetched file was not handed over. The texts name no path or ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandOverError {
    /// The app is closing, or the service is not running.
    NoService,
    /// The file could not be completed, or its line could not be made or written.
    Write,
    /// The fetch's ticket ended (the window closed) before the file was named: it is not kept.
    Ended,
}

impl fmt::Display for HandOverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HandOverError::NoService => "The library service is not running, so the file was not kept.",
            HandOverError::Write => "The file could not be handed to the library service.",
            HandOverError::Ended => "The sign-in window was closed, so the file was not kept.",
        })
    }
}

/// Completes the part file and names it to the service, by the same writer and under the same lock
/// as the folder grants (grant.rs). The line is written through `gate` (in the app,
/// `Library::send_if_current`), which runs it only while the fetch's ticket is still the open one
/// and answers None, writing nothing, when it has ended (R331 c). The file is removed when it is not
/// handed over.
pub fn hand_over(target: &dyn GrantTarget, ticket: &str, part: PartFile, gate: &dyn Fn(&mut dyn FnMut() -> bool) -> Option<bool>) -> Result<(), HandOverError> {
    if target.stopping() {
        return Err(HandOverError::NoService);
    }
    let input = target.service_input().ok_or(HandOverError::NoService)?;
    let grant = part.grant().to_string();
    let path = part.commit().map_err(|_| HandOverError::Write)?;
    let line = file_grant_line(&grant, ticket, &path);
    let mut send = || match &line {
        Some(l) if !target.stopping() => input.send_line(l),
        _ => false,
    };
    let sent = gate(&mut send);
    if sent != Some(true) {
        let _ = fs::remove_file(&path);
        return Err(match sent {
            None => HandOverError::Ended,
            Some(_) if target.stopping() => HandOverError::NoService,
            Some(_) => HandOverError::Write,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The device file

/// The longest device file read or written.
pub const DEVICE_MAX_BYTES: usize = 4096;

/// `<app_data>/library-window.json`: the window's store and what lives as long as it. Its `Debug`
/// shows whether the store is kept and how many sign-in hosts it has, never the id or a host.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceState {
    pub stay_signed_in: bool,
    pub store: [u8; 16],
    /// Every host at which a library's start opened the window while this store has lived (R360 a),
    /// lower case, without a trailing dot: a sign-in host for every later ticket of either kind,
    /// beside the path and query rules. A link's start adds none. Forgotten exactly where the store
    /// is emptied (`Library::renew`, which makes a new state) or ends with the window
    /// (`Library::window_closed`, where the store is the window's own), and kept wherever the store
    /// is kept — across a quit with "Stay signed in" in this file.
    pub sign_in_hosts: Vec<String>,
}

impl fmt::Debug for DeviceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceState").field("stay_signed_in", &self.stay_signed_in).field("sign_in_hosts", &self.sign_in_hosts.len()).finish_non_exhaustive()
    }
}

/// A sign-in host as the device file may hold it: not empty, printable ASCII, no upper case.
fn kept_host(h: &str) -> bool {
    !h.is_empty() && h.bytes().all(|b| b.is_ascii_graphic() && !b.is_ascii_uppercase())
}

/// A new store id: 16 bytes from the system's secure random source, shaped as a version-4 UUID.
pub fn new_store_id() -> Option<[u8; 16]> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).ok()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    Some(b)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The device file's text.
pub fn device_text(s: &DeviceState) -> String {
    let hosts = serde_json::Value::from(s.sign_in_hosts.clone());
    format!("{{\"staySignedIn\":{},\"store\":\"{}\",\"signInHosts\":{hosts}}}\n", s.stay_signed_in, hex(&s.store))
}

/// The device file's state; None when it is missing, unreadable, longer than DEVICE_MAX_BYTES or not
/// exactly `{"staySignedIn": <bool>, "store": "<32 lower-case hex>", "signInHosts": [<host>, …]}`
/// (each host as `kept_host` allows). The earlier form without `signInHosts` is not read: its store is
/// then not kept (a new id), since what it holds is not known.
pub fn parse_device(text: &str) -> Option<DeviceState> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    if o.len() != 3 {
        return None;
    }
    let mut sign_in_hosts = Vec::new();
    for h in o.get("signInHosts")?.as_array()? {
        let h = h.as_str().filter(|h| kept_host(h))?;
        sign_in_hosts.push(h.to_string());
    }
    let stay = o.get("staySignedIn")?.as_bool()?;
    let s = o.get("store")?.as_str()?;
    if !hex32(s) {
        return None;
    }
    let mut store = [0u8; 16];
    for (i, b) in store.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(DeviceState { stay_signed_in: stay, store, sign_in_hosts })
}

/// The device file read; None as well when it is a symbolic link (R331 h): it is then treated as
/// unreadable (not kept, a new store id written over the link).
pub fn read_device(path: &Path) -> Option<DeviceState> {
    let mut o = OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let f = o.open(path).ok()?;
    let mut text = String::new();
    f.take(DEVICE_MAX_BYTES as u64 + 1).read_to_string(&mut text).ok()?;
    if text.len() > DEVICE_MAX_BYTES {
        return None;
    }
    parse_device(&text)
}

/// Writes the device file atomically (a new 0600 file beside it, flushed, then renamed over it, and
/// the folder flushed so that the new name survives a power loss — best effort, as the library's
/// own atomic writes do, packages/library/src/fs/atomic.ts `fsyncDir`; R331 h). A text longer than
/// DEVICE_MAX_BYTES, which could not be read back, is not written.
pub fn write_device(path: &Path, s: &DeviceState) -> io::Result<()> {
    let text = device_text(s);
    if text.len() > DEVICE_MAX_BYTES {
        return Err(io::Error::other("too long"));
    }
    let dir = path.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| io::Error::other("no random source"))?;
    let tmp = dir.join(format!(".{DEVICE_FILE}.{}", hex(&suffix)));
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let written = o.open(&tmp).and_then(|mut f| {
        f.write_all(text.as_bytes())?;
        f.sync_all()
    });
    let renamed = written.and_then(|_| fs::rename(&tmp, path));
    if renamed.is_err() {
        let _ = fs::remove_file(&tmp);
        return renamed;
    }
    if let Ok(folder) = File::open(dir) {
        let _ = folder.sync_all();
    }
    renamed
}

// ---------------------------------------------------------------------------------------------
// The window's controller

/// One fetch to run (`Host::start_fetch`), then report with `Library::finish`.
pub struct Job {
    pub generation: u64,
    pub ticket: String,
    pub input: FetchInput,
    /// Where the host puts the way to cancel this fetch once it has started it.
    pub abort: AbortSlot,
}

/// The way to cancel one fetch (R331 c). The controller keeps it from the moment it marks the fetch
/// as running, under the same lock, so that the window's closing at any moment finds it; the host
/// puts the cancelling in it once it has started the fetch, and when the window has closed before
/// that, the fetch is cancelled at once.
#[derive(Clone, Default)]
pub struct AbortSlot(Arc<Mutex<Abort>>);

#[derive(Default)]
enum Abort {
    #[default]
    Empty,
    Set(Box<dyn FnOnce() + Send>),
    Fired,
}

impl AbortSlot {
    fn state(&self) -> MutexGuard<'_, Abort> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keeps the way to cancel the fetch; cancels it at once if the window has already closed.
    pub fn set(&self, abort: Box<dyn FnOnce() + Send>) {
        let mut g = self.state();
        if matches!(*g, Abort::Fired) {
            drop(g);
            abort();
        } else {
            *g = Abort::Set(abort);
        }
    }

    /// Cancels the fetch now, or as soon as the way to cancel it is kept.
    fn fire(&self) {
        let was = std::mem::replace(&mut *self.state(), Abort::Fired);
        if let Abort::Set(abort) = was {
            abort();
        }
    }
}

impl fmt::Debug for Job {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Job").field("generation", &self.generation).finish_non_exhaustive()
    }
}

/// How a job ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    HandedOver,
    Fetch(FetchError),
    HandOver(HandOverError),
}

impl Outcome {
    fn state(self) -> State {
        match self {
            Outcome::HandedOver => State::HandedOver,
            Outcome::Fetch(e) => e.state(),
            Outcome::HandOver(_) => State::Failed,
        }
    }

    /// The reason the main window hears with the state: a hop of the shell's own fetch that reached a
    /// sign-in address was not requested, and the row says so (`sign-in-address`), as it does when
    /// the shell refuses such an address before any request.
    fn reason(self) -> Option<Reason> {
        match self {
            Outcome::Fetch(FetchError::SignIn) => Some(Reason::SignIn),
            _ => None,
        }
    }
}

/// What the controller needs of the app: the window, the event, the fetch's start, the store.
/// `TauriHost` in the app; a stand-in in tests.
pub trait Host: Send + Sync {
    fn window_exists(&self) -> bool;
    /// Builds the window at `url` with the given store (macOS) or an ephemeral one (elsewhere), under
    /// `title`.
    fn create_window(&self, url: &Url, store: [u8; 16], title: &str) -> bool;
    fn navigate(&self, url: &Url) -> bool;
    /// Sets the window's title (R347 b: the shell's alone).
    fn set_title(&self, title: &str);
    /// The window's current address.
    fn current_url(&self) -> Option<Url>;
    /// Asks the window to close (its closing then calls `Library::window_closed`).
    fn close_window(&self);
    /// Closes the window and waits until it is gone (never on the main thread).
    fn close_window_and_wait(&self);
    fn emit(&self, event: &LibraryEvent);
    /// Runs `job` (asynchronously) and reports with `Library::finish`.
    fn start_fetch(&self, job: Job);
    /// Whether the app is closing.
    fn stopping(&self) -> bool;
    fn device_path(&self) -> Option<PathBuf>;
    /// Whether the platform can keep the window's store across quits (macOS only). Where it cannot, the
    /// store is the window's own (ephemeral) and ends with the window (`window_store`).
    fn store_can_stay(&self) -> bool;
    /// Removes every data store the web view lists (macOS; nothing to do elsewhere). Never on the main thread.
    fn remove_data_stores(&self) -> bool;
}

/// FR-561 (R472): whether an open that has shown its window may answer that it did: not when another
/// open has taken the window meanwhile (`owner_now`, the ticket whose open the window serves now). The
/// page then hears false for that late open and closes nothing; None (the window was closed meanwhile)
/// answers as before.
pub fn open_still_its_own(owner_now: Option<&str>, ticket: &str) -> bool {
    owner_now.is_none_or(|o| o == ticket)
}

/// FR-561 (R472): whether `close_library_window(ticket)` closes the window open now. With a ticket: only
/// when that ticket's open made it (`owner_now`) — a late, repeated or older close touches no newer
/// window, nor the one "Test" opened. Without one (the page closing a window it did not open: a leftover
/// that holds the shell's one ticket, R342 b), whatever is open, as before.
pub fn close_allowed(owner_now: Option<&str>, asked: Option<&str>) -> bool {
    match asked {
        None => true,
        Some(t) => valid_ticket(t) && owner_now == Some(t),
    }
}

#[derive(Default)]
struct Inner {
    ticket: Option<String>,
    /// The ticket whose open made (or re-used) the window open now (FR-561, R472): set with `ticket` by
    /// `open`, kept after a hand-over ends `ticket` (the window stays), cleared when the window is gone.
    window_owner: Option<String>,
    /// The ticket of the open whose window is being built (set by `open` before it builds, cleared when that
    /// build answers). A close while it is built ends its ticket and clears `window_owner`, yet its window then
    /// stands: a newer open that fails meanwhile gives the window back to it (R486 g).
    building: Option<String>,
    /// The kind of start of the open ticket (R347 a). Every ticket starts by `open`, which sets it (for
    /// the window it builds or re-uses, and puts it back when that fails), so no kind outlives its
    /// ticket into another; after a hand-over the window may stay without a ticket, its title still in
    /// the last ticket's words.
    start: Start,
    /// The window's title as last set (`open`, `page_shown`), set again when a page changes its own.
    title: Option<String>,
    /// The host part of that title: the host of the page the window shows (R360 b) — the asked
    /// address's only while a window just built shows nothing yet.
    shown_host: Option<String>,
    previous: Option<Url>,
    current: Option<Url>,
    fetching: Option<u64>,
    generation: u64,
    last_handover: Option<Instant>,
    abort: Option<AbortSlot>,
    device: Option<DeviceState>,
}

/// The sign-in window's state in the shell: the open ticket, the fetch, the pause, the store.
#[derive(Default)]
pub struct Library {
    inner: Mutex<Inner>,
    config: OnceLock<Config>,
}

/// Where the shell keeps the window's files, and how it runs.
#[derive(Clone)]
pub struct Config {
    pub device: PathBuf,
    /// The service's settings folder (AO_CONFIG_DIR): the inbox is under it.
    pub config_dir: PathBuf,
    pub test_mode: bool,
    pub main_thread: std::thread::ThreadId,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config").field("test_mode", &self.test_mode).finish_non_exhaustive()
    }
}

impl Library {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Set once, at launch.
    pub fn configure(&self, config: Config) -> bool {
        self.config.set(config).is_ok()
    }

    pub fn config(&self) -> Option<&Config> {
        self.config.get()
    }

    /// `open_library_window(ticket, url, from)` as the page calls it (R347 a): `from` absent means
    /// "library"; "library" or "link" exactly; anything else is refused like every other refusal of
    /// the command (false, nothing opened, no event, the ticket not taken).
    pub fn open_from(&self, host: &dyn Host, caller: &str, ticket: &str, url: &str, from: Option<&serde_json::Value>) -> bool {
        match Start::from_arg(from) {
            Some(start) => self.open(host, caller, ticket, url, start),
            None => false,
        }
    }

    /// `open_library_window`: from the main window only, with a 32 lower-case hex ticket and an https
    /// address without user name or password of at most 4,096 characters, while no ticket is open and
    /// the app is not closing. Re-uses the window when it exists (and goes to the address; its title
    /// keeps the host shown until the new page commits, in the new kind's words), otherwise builds it
    /// (titled by the address's host). The kind of start is the ticket's (R347 a); a library's start
    /// adds the host the window is opened at to the library's sign-in hosts, which every later ticket
    /// of either kind never fetches from while the window's store lives (R360 a); a link's start adds
    /// none. Anything else answers false and opens nothing.
    pub fn open(&self, host: &dyn Host, caller: &str, ticket: &str, url: &str, start: Start) -> bool {
        if caller != MAIN || !valid_ticket(ticket) || host.stopping() {
            return false;
        }
        let Some(url) = window_address(url) else { return false };
        let reuse = host.window_exists();
        let (store, title, before) = {
            let mut g = self.lock();
            if g.ticket.is_some() {
                return false;
            }
            let before = (g.start, g.title.clone(), g.shown_host.clone(), g.previous.clone(), g.current.clone(), g.device.as_ref().map(|d| d.sign_in_hosts.clone()), g.window_owner.clone());
            let Some(device) = g.device.as_mut() else { return false };
            let store = device.store;
            // R360 a: a library's start adds the host it opens the window at to the store's sign-in
            // hosts (a link's adds none). Where the store is kept across a quit, the host is written down
            // before the window goes there, so that a forced quit loses nothing; when it cannot be, the
            // start is refused and nothing is taken.
            if let (Start::Library, Some(h)) = (start, url.host_str().map(bare_host)) {
                if !device.sign_in_hosts.contains(&h) {
                    let mut kept = device.clone();
                    kept.sign_in_hosts.push(h);
                    if kept.stay_signed_in && host.store_can_stay() && !host.device_path().is_some_and(|p| write_device(&p, &kept).is_ok()) {
                        return false;
                    }
                    *device = kept;
                }
            }
            g.ticket = Some(ticket.to_string());
            g.window_owner = Some(ticket.to_string());
            // R486 g: the first of the builds still under way is the one whose window stands.
            if !reuse && g.building.is_none() {
                g.building = Some(ticket.to_string());
            }
            g.start = start;
            g.previous = None;
            g.current = None;
            // R360 b: a re-used window keeps the host of the page it shows until the new address
            // commits (`page_shown`); only the words for the kind change at once. A window built anew
            // shows nothing yet: the asked host.
            let shown_host = match (reuse, &g.shown_host) {
                (true, Some(h)) => h.clone(),
                // Not met (a window is only built here, which sets it): never the asked host.
                (true, None) => "no web address".to_string(),
                (false, _) => title_host(&url),
            };
            let title = titled(&shown_host, start);
            g.shown_host = Some(shown_host);
            g.title = Some(title.clone());
            (store, title, before)
        };
        let shown = if reuse {
            let moved = host.navigate(&url);
            if moved {
                host.set_title(&title);
            }
            moved
        } else {
            host.create_window(&url, store, &title)
        };
        if !shown {
            // Nothing was opened: the ticket is cleared, and the kind, the sign-in hosts and the title
            // are put back to what they were, so that the page still shown keeps its words (R360 b).
            // R486 g: the window, if one stands, is given back to the open whose window it is — the one it
            // served before, or else the open whose window was being built (a close meanwhile had cleared its
            // owner) — and to none when no window stands, so that no window is left that its own open's
            // ticketed close cannot close.
            let stands = host.window_exists();
            let mut g = self.lock();
            if g.building.as_deref() == Some(ticket) {
                g.building = None;
            }
            if g.ticket.as_deref() == Some(ticket) {
                g.ticket = None;
                let (start, title, shown_host, previous, current, hosts, owner) = before;
                let owner = if stands { owner.or_else(|| g.building.clone()) } else { None };
                (g.start, g.title, g.shown_host, g.previous, g.current, g.window_owner) = (start, title, shown_host, previous, current, owner);
                if let (Some(d), Some(hosts)) = (g.device.as_mut(), hosts) {
                    d.sign_in_hosts = hosts;
                }
            }
            return false;
        }
        // FR-561 (R472): another open took the window while this one was being shown (the page had given
        // this one up and closed what was there): this open answers false and says nothing, so that
        // nothing closes the newer window on its behalf.
        // R489: a window that stands owned by nobody (a close while it was built ended this open and cleared
        // the owner) is this open's, so that the page's ticketed close for it is honoured. A window another
        // open has taken keeps that owner, and this open answers false as above.
        let stands = host.window_exists();
        let still_its_own = {
            let mut g = self.lock();
            if g.building.as_deref() == Some(ticket) {
                g.building = None;
            }
            if stands && g.window_owner.is_none() {
                g.window_owner = Some(ticket.to_string());
            }
            open_still_its_own(g.window_owner.as_deref(), ticket)
        };
        if !still_its_own {
            return false;
        }
        host.emit(&LibraryEvent::new(Some(ticket), State::Opened));
        true
    }

    /// Starts a fetch for `url` when the rules allow (the lock is held by the caller); otherwise the
    /// reason, for the event.
    fn begin(g: &mut Inner, url: &Url, previous: Option<Url>, now: Instant) -> Result<Job, (Option<String>, State, Reason)> {
        let Some(ticket) = g.ticket.clone() else { return Err((None, State::Failed, Reason::NoTicket)) };
        if g.fetching.is_some() {
            return Err((Some(ticket), State::Failed, Reason::Busy));
        }
        if g.last_handover.is_some_and(|t| now.saturating_duration_since(t) < PAUSE) {
            return Err((Some(ticket), State::Failed, Reason::Pause));
        }
        if url.scheme() != "https" {
            return Err((Some(ticket), State::NotAPdf, Reason::NotHttps));
        }
        let sign_in_hosts = g.device.as_ref().map(|d| d.sign_in_hosts.clone()).unwrap_or_default();
        if sign_in_address(url, sign_in_hosts.iter().map(String::as_str)) {
            return Err((Some(ticket), State::NotAPdf, Reason::SignIn));
        }
        g.generation += 1;
        g.fetching = Some(g.generation);
        // The way to cancel it is kept under this same lock (R331 c).
        let abort = AbortSlot::default();
        g.abort = Some(abort.clone());
        Ok(Job {
            generation: g.generation,
            ticket,
            input: FetchInput { url: url.clone(), previous, user_agent: USER_AGENT.to_string(), sign_in_hosts },
            abort,
        })
    }

    fn run(&self, host: &dyn Host, job: Job) {
        host.emit(&LibraryEvent::new(Some(&job.ticket), State::Fetching));
        host.start_fetch(job);
    }

    /// The window shows a new top page (its navigation committed, a server's redirects followed, or its
    /// load finished; never a frame's): the title names that page's host and the ticket's kind of
    /// start (R347 b). On the main thread: nothing here blocks.
    pub fn page_shown(&self, host: &dyn Host, url: &Url) {
        let title = {
            let mut g = self.lock();
            let shown_host = title_host(url);
            let t = titled(&shown_host, g.start);
            g.shown_host = Some(shown_host);
            if g.title.as_deref() == Some(t.as_str()) {
                return;
            }
            g.title = Some(t.clone());
            t
        };
        host.set_title(&title);
    }

    /// A page changed its own title (`document.title`, `<title>`): the window keeps the shell's
    /// (R347 b), set again in case the platform let the page's through.
    pub fn page_retitled(&self, host: &dyn Host) {
        let title = self.lock().title.clone();
        if let Some(t) = title {
            host.set_title(&t);
        }
    }

    /// A page of the window finished loading (on the main thread: nothing here blocks). An address
    /// that looks like a PDF's starts a fetch when a ticket is open, nothing is being fetched and the
    /// pause is over; a sign-in address never does. Otherwise nothing happens (no event, except the
    /// pause, which is said).
    pub fn page_loaded(&self, host: &dyn Host, url: &Url, now: Instant) {
        let job = {
            let mut g = self.lock();
            g.previous = g.current.replace(url.clone());
            if g.ticket.is_none() || g.fetching.is_some() || host.stopping() || !looks_like_pdf_address(url) {
                return;
            }
            let previous = g.previous.clone();
            Self::begin(&mut g, url, previous, now)
        };
        self.run_automatic(host, job);
    }

    /// A fetch the window itself started (a page load or a download): run, or said only when it waits
    /// for the pause.
    fn run_automatic(&self, host: &dyn Host, job: Result<Job, (Option<String>, State, Reason)>) {
        match job {
            Ok(job) => self.run(host, job),
            Err((ticket, state, Reason::Pause)) => host.emit(&LibraryEvent::refused(ticket.as_deref(), state, Reason::Pause)),
            Err(_) => {}
        }
    }

    /// The window asked to start a download (R331 g; on the main thread: nothing here blocks). The
    /// window's own download is refused (`TauriHost::create_window`); its address is taken as the
    /// PDF's address and goes the same way as a page that reached a PDF's address (`page_loaded`):
    /// only while a ticket is open, nothing is being fetched and the pause is over, https only, never
    /// a sign-in address, at most one file per ticket, and through the one request path (`fetch_pdf`)
    /// with all its rules, the window's current page as its `Referer`. The window has not moved, so
    /// its current page stays as it was. Nothing is said when nothing is fetched, except the pause.
    pub fn download_requested(&self, host: &dyn Host, url: &Url, now: Instant) {
        let job = {
            let mut g = self.lock();
            if g.ticket.is_none() || g.fetching.is_some() || host.stopping() {
                return;
            }
            let previous = g.current.clone();
            Self::begin(&mut g, url, previous, now)
        };
        self.run_automatic(host, job);
    }

    /// `library_window_take_pdf()`: from the main window only; fetches the window's current address
    /// under the same rules. False, with the event saying why, when nothing is fetched.
    pub fn take_pdf(&self, host: &dyn Host, caller: &str, now: Instant) -> bool {
        if caller != MAIN {
            return false;
        }
        let current = host.current_url();
        let job = {
            let mut g = self.lock();
            if host.stopping() {
                Err((g.ticket.clone(), State::Failed, Reason::Stopping))
            } else {
                match current {
                    Some(url) => {
                        let previous = if g.current.as_ref() == Some(&url) { g.previous.clone() } else { g.current.clone() };
                        Self::begin(&mut g, &url, previous, now)
                    }
                    None => match g.ticket.clone() {
                        Some(t) => Err((Some(t), State::NotAPdf, Reason::NotHttps)),
                        None => Err((None, State::Failed, Reason::NoTicket)),
                    },
                }
            }
        };
        match job {
            Ok(job) => {
                self.run(host, job);
                true
            }
            Err((ticket, state, reason)) => {
                host.emit(&LibraryEvent::refused(ticket.as_deref(), state, reason));
                false
            }
        }
    }

    /// The hand-over's last step (R331 c): `send` (the line to the service) runs only while fetch
    /// `generation` is still the running fetch of the open `ticket`, and under the controller's lock,
    /// so that the window's closing cannot come between the check and the line. When the line is
    /// written the fetch ends there as handed over: the ticket ends in the shell too, the pause
    /// starts and the main window hears it. None, with nothing written or said, when the ticket has
    /// ended (the window closed, or another ticket is open).
    pub fn send_if_current(&self, host: &dyn Host, generation: u64, ticket: &str, now: Instant, send: &mut dyn FnMut() -> bool) -> Option<bool> {
        let mut g = self.lock();
        if g.fetching != Some(generation) || g.ticket.as_deref() != Some(ticket) {
            return None;
        }
        let sent = send();
        if sent {
            g.fetching = None;
            g.abort = None;
            g.last_handover = Some(now);
            g.ticket = None;
            host.emit(&LibraryEvent::new(Some(ticket), State::HandedOver));
        }
        Some(sent)
    }

    /// The fetch `generation` for `ticket` ended. A hand-over ends the ticket in the shell too and
    /// starts the pause; any other end leaves the ticket open (the researcher may try again). An
    /// outcome for a fetch that is no longer the running fetch of its open ticket is dropped (R331 c):
    /// the window's closing cancelled it and has said so, or its hand-over was already settled by
    /// `send_if_current`.
    pub fn finish(&self, host: &dyn Host, generation: u64, ticket: &str, outcome: Outcome, now: Instant) {
        let event = {
            let mut g = self.lock();
            if g.fetching != Some(generation) || g.ticket.as_deref() != Some(ticket) {
                return;
            }
            g.fetching = None;
            g.abort = None;
            if outcome == Outcome::HandedOver {
                g.last_handover = Some(now);
                g.ticket = None;
            }
            match outcome.reason() {
                Some(r) => LibraryEvent::refused(Some(ticket), outcome.state(), r),
                None => LibraryEvent::new(Some(ticket), outcome.state()),
            }
        };
        host.emit(&event);
    }

    /// `close_library_window()` without a ticket: from the main window only (see `close_for`).
    pub fn close(&self, host: &dyn Host, caller: &str) {
        self.close_for(host, caller, None);
    }

    /// `close_library_window(ticket?)`: from the main window only; with a ticket, only the window that
    /// ticket's open made (`close_allowed`, FR-561, R472), otherwise nothing at all.
    pub fn close_for(&self, host: &dyn Host, caller: &str, ticket: Option<&str>) {
        if caller != MAIN || !close_allowed(self.lock().window_owner.as_deref(), ticket) {
            return;
        }
        if host.window_exists() {
            host.close_window();
        } else {
            self.window_closed(host);
        }
    }

    /// The window is gone (closed by the researcher, by `close`, or with the main window): the ticket
    /// ends, a running fetch is cancelled (its part file removed), and the main window hears it.
    pub fn window_closed(&self, host: &dyn Host) {
        let (ticket, abort) = {
            let mut g = self.lock();
            g.fetching = None;
            g.previous = None;
            g.current = None;
            // R360 a: where the window's store is its own (ephemeral: every platform but macOS,
            // `window_store`), it ended with the window, and the library's sign-in hosts end with it. On
            // macOS the store outlives the window until it is emptied (`renew`), and so do they.
            if !host.store_can_stay() {
                if let Some(d) = g.device.as_mut() {
                    d.sign_in_hosts.clear();
                }
            }
            // The kind and the title are not reset here: every ticket starts by `open`, which sets both
            // (R360 c), so the closed window's kind cannot reach a later ticket.
            g.window_owner = None;
            (g.ticket.take(), g.abort.take())
        };
        if let Some(abort) = abort {
            abort.fire();
        }
        host.emit(&LibraryEvent::new(ticket.as_deref(), State::Closed));
    }

    pub fn stay_signed_in(&self) -> bool {
        self.lock().device.as_ref().is_some_and(|d| d.stay_signed_in)
    }

    /// The emptying: close the window, remove every data store the web view lists, make a new store
    /// id and write it. True when all of it was done.
    fn renew(&self, host: &dyn Host, stay: bool) -> bool {
        host.close_window_and_wait();
        self.renew_closed(host, stay)
    }

    /// The emptying after the window's closing has been waited for.
    fn renew_closed(&self, host: &dyn Host, stay: bool) -> bool {
        let removed = host.remove_data_stores();
        let Some(store) = new_store_id() else { return false };
        let state = DeviceState { stay_signed_in: stay, store, sign_in_hosts: Vec::new() };
        let written = host.device_path().is_some_and(|p| write_device(&p, &state).is_ok());
        self.lock().device = Some(state);
        removed && written
    }

    /// At the shell's start (a forced quit, a crash or a power loss is caught here): reads the device
    /// file (unreadable or misshapen: not kept, a new store id) and empties the store unless it is
    /// kept. Never on the main thread.
    pub fn at_start(&self, host: &dyn Host) -> bool {
        let read = host.device_path().and_then(|p| read_device(&p));
        match read {
            Some(s) if s.stay_signed_in && host.store_can_stay() => {
                self.lock().device = Some(s);
                true
            }
            _ => self.renew(host, false),
        }
    }

    /// At quit: the window closes; the store is emptied unless it is kept. Never on the main thread.
    pub fn at_quit(&self, host: &dyn Host) -> bool {
        if self.stay_signed_in() && host.store_can_stay() {
            host.close_window_and_wait();
            true
        } else {
            self.renew(host, false)
        }
    }

    /// `sign_out_of_library()`: from the main window only; the emptying now, whether or not the
    /// store is otherwise kept ("Stay signed in" stays as it was chosen). When the window is still
    /// there after the wait (R361), its session lives on with it: the sign-out does not complete —
    /// the store is not renewed, the sign-in hosts are kept, nothing is written — and it answers
    /// false, as its other failures do. A later sign-out, once the window has gone, completes.
    pub fn sign_out(&self, host: &dyn Host, caller: &str) -> bool {
        if caller != MAIN {
            return false;
        }
        host.close_window_and_wait();
        if host.window_exists() {
            return false;
        }
        let stay = self.stay_signed_in() && host.store_can_stay();
        self.renew_closed(host, stay)
    }

    /// `set_stay_signed_in(on)`: from the main window only; `true` only where the store can be kept
    /// (macOS). Writes the device file.
    pub fn set_stay(&self, host: &dyn Host, caller: &str, on: bool) -> bool {
        if caller != MAIN || (on && !host.store_can_stay()) {
            return false;
        }
        // Under the lock, so that a library's start cannot add a host between the reading and the writing.
        let mut g = self.lock();
        let Some(mut state) = g.device.clone() else { return false };
        state.stay_signed_in = on;
        if !host.device_path().is_some_and(|p| write_device(&p, &state).is_ok()) {
            return false;
        }
        g.device = Some(state);
        true
    }
}

// ---------------------------------------------------------------------------------------------
// The researcher's own browser (R325 f)

/// `open_in_browser(url)`: from the main window only; an https address without user name or
/// password, of at most 4,096 characters, handed to `opener` as ONE argument.
pub fn open_in_browser(caller: &str, url: &str, opener: &dyn Fn(&str) -> bool) -> bool {
    if caller != MAIN {
        return false;
    }
    let Some(u) = browser_address(url) else { return false };
    opener(u.as_str())
}

/// The system's opener (`/usr/bin/open` on macOS, `xdg-open` on Linux), started directly with the
/// address as its one argument — never through a shell — and reaped when it exits.
pub fn system_opener(url: &str) -> bool {
    let program = if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else if cfg!(target_os = "linux") {
        "/usr/bin/xdg-open"
    } else {
        return false;
    };
    match std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------------------------
// The app's host

/// The controller's host in the app.
#[derive(Clone)]
pub struct TauriHost {
    app: tauri::AppHandle,
    library: Arc<Library>,
    target: Arc<dyn GrantTarget + Send + Sync>,
}

impl TauriHost {
    pub fn new(app: tauri::AppHandle, library: Arc<Library>, target: Arc<dyn GrantTarget + Send + Sync>) -> Self {
        TauriHost { app, library, target }
    }

    fn window(&self) -> Option<tauri::WebviewWindow> {
        use tauri::Manager;
        self.app.get_webview_window(LABEL)
    }

    fn on_main_thread(&self) -> bool {
        self.library.config().is_some_and(|c| c.main_thread == std::thread::current().id())
    }

    fn test_mode(&self) -> bool {
        self.library.config().is_some_and(|c| c.test_mode)
    }

    /// The job itself: the window's cookies read once, the fetch into a part file, the hand-over.
    async fn fetch(&self, job: Job) -> Outcome {
        let (generation, ticket) = (job.generation, job.ticket.clone());
        let Some(config) = self.library.config().cloned() else { return Outcome::HandOver(HandOverError::NoService) };
        let Ok(inbox) = prepare_inbox(&config.config_dir) else { return Outcome::Fetch(FetchError::Write) };
        let Some(grant) = crate::grant::new_grant_id() else { return Outcome::Fetch(FetchError::Write) };
        let mut part = PartFile::new(inbox, grant);
        let app = self.app.clone();
        let cookies: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(move || {
            use tauri::Manager;
            app.get_webview_window(LABEL).and_then(|w| w.cookies().ok()).unwrap_or_default()
        });
        let rules = FetchRules::for_shell(config.test_mode);
        if let Err(e) = fetch_pdf(job.input, cookies, &rules, Arc::new(SystemResolver), &mut part).await {
            return Outcome::Fetch(e);
        }
        let gate = |send: &mut dyn FnMut() -> bool| self.library.send_if_current(self, generation, &ticket, Instant::now(), send);
        match hand_over(&*self.target, &job.ticket, part, &gate) {
            Ok(()) => Outcome::HandedOver,
            Err(e) => Outcome::HandOver(e),
        }
    }
}

impl Host for TauriHost {
    fn window_exists(&self) -> bool {
        self.window().is_some()
    }

    fn create_window(&self, url: &Url, store: [u8; 16], title: &str) -> bool {
        use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
        let loaded = self.clone();
        let downloads = self.clone();
        let retitled = self.clone();
        let opened = self.app.clone();
        let builder = tauri::WebviewWindowBuilder::new(&self.app, LABEL, tauri::WebviewUrl::External(url.clone()))
            .title(title)
            .inner_size(WIDTH, HEIGHT)
            .min_inner_size(600.0, 400.0)
            .user_agent(USER_AGENT)
            .initialization_script(SCRIPT);
        // The launch check's probe (debug builds, test mode, its switch set; R343 b), and with it the
        // window's trace (Task MAC7): its navigations, page loads and fallback printed.
        #[cfg(debug_assertions)]
        let probe = library_probe::from_env(self.test_mode());
        #[cfg(debug_assertions)]
        let (traced, traced_loads) = (probe.clone(), probe.clone());
        #[cfg(debug_assertions)]
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(debug_assertions)]
        let started_seen = started.clone();
        #[cfg(debug_assertions)]
        let builder = builder.on_navigation(move |u| library_probe::decided(u, traced.as_ref()));
        #[cfg(not(debug_assertions))]
        let builder = builder.on_navigation(navigation_allowed);
        let builder = builder
            // The web view itself never saves a file: a download it would start is refused (the
            // shell's own fetch is the only way a file is kept; WebKitGTK shows no PDF and would
            // otherwise save it to the Downloads folder). Its address is taken as the PDF's address
            // and fetched by the shell under every rule of its one request path (R331 g).
            .on_download(move |_webview, event| {
                if let DownloadEvent::Requested { url, .. } = event {
                    downloads.library.download_requested(&downloads, &url, Instant::now());
                }
                false
            })
            .on_new_window(move |u, _features| {
                if let Some(target) = new_window_target(&u) {
                    // Off the web view's own callback: the navigation is posted to the main thread.
                    let app = opened.clone();
                    std::thread::spawn(move || {
                        use tauri::Manager;
                        if let Some(w) = app.get_webview_window(LABEL) {
                            let _ = w.navigate(target);
                        }
                    });
                }
                NewWindowResponse::Deny
            })
            // The top page only: wry reports the main frame's navigation committed (`Started`; after any
            // server redirect, at the address the page is shown at — WebKitGTK's `load-changed`
            // COMMITTED, WKWebView's `didCommitNavigation`) and its load finished, never a frame's. Each
            // sets the title to the host shown (R347 b).
            .on_page_load(move |_w, p| {
                #[cfg(debug_assertions)]
                if let Some(report) = &traced_loads {
                    started_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                    println!("{}", library_probe::page_load_line(p.event() == PageLoadEvent::Finished, p.url(), report));
                }
                loaded.library.page_shown(&loaded, p.url());
                if p.event() == PageLoadEvent::Finished {
                    loaded.library.page_loaded(&loaded, p.url(), Instant::now());
                }
            })
            // R347 b: a page cannot set the window's title. Neither tauri 2.12.5 nor wry 0.57.2 carries
            // a page's title to the window on any platform (a page's title reaches only this handler,
            // which the window would otherwise not have); the shell's own is set again whenever a page
            // changes its own, so that no later version or platform could show the page's.
            .on_document_title_changed(move |_w, _page_title| {
                retitled.library.page_retitled(&retitled);
            })
            .devtools(cfg!(debug_assertions));
        #[cfg(debug_assertions)]
        let builder = match &probe {
            Some(report) => builder.initialization_script(library_probe::script(report)),
            None => builder,
        };
        let Ok(w) = window_store(builder, store).build() else { return false };
        #[cfg(debug_assertions)]
        if let Some(report) = &probe {
            library_probe::watch(w.clone(), report, started);
        }
        let closed = self.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                closed.library.window_closed(&closed);
            }
        });
        true
    }

    fn navigate(&self, url: &Url) -> bool {
        self.window().is_some_and(|w| w.navigate(url.clone()).is_ok())
    }

    fn set_title(&self, title: &str) {
        if let Some(w) = self.window() {
            let _ = w.set_title(title);
        }
    }

    fn current_url(&self) -> Option<Url> {
        self.window()?.url().ok()
    }

    fn close_window(&self) {
        if let Some(w) = self.window() {
            let _ = w.close();
        }
    }

    fn close_window_and_wait(&self) {
        self.close_window();
        if self.on_main_thread() {
            return;
        }
        let until = Instant::now() + Duration::from_secs(5);
        while self.window_exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn emit(&self, event: &LibraryEvent) {
        use tauri::Emitter;
        let _ = self.app.emit_to(tauri::EventTarget::webview_window(MAIN), EVENT, event.to_json());
        if self.test_mode() {
            println!("AO_SHELL_LIBRARY {}", event.state.word());
        }
    }

    fn start_fetch(&self, job: Job) {
        let host = self.clone();
        let (generation, ticket, slot) = (job.generation, job.ticket.clone(), job.abort.clone());
        let handle = tauri::async_runtime::spawn(async move {
            let outcome = host.fetch(job).await;
            host.library.finish(&host, generation, &ticket, outcome, Instant::now());
        });
        slot.set(Box::new(move || handle.abort()));
    }

    fn stopping(&self) -> bool {
        self.target.stopping()
    }

    fn device_path(&self) -> Option<PathBuf> {
        self.library.config().map(|c| c.device.clone())
    }

    fn store_can_stay(&self) -> bool {
        store_can_stay()
    }

    fn remove_data_stores(&self) -> bool {
        if self.on_main_thread() {
            // Its completion arrives on the main thread: waiting there would never end.
            return false;
        }
        remove_data_stores(&self.app)
    }
}

// ---------------------------------------------------------------------------------------------
// The launch check's probe of this window (Task F19, R343 b): debug builds only.

/// The sign-in window's probe (`library_probe.js`): compiled into debug builds only, and given to the
/// window only in test mode (`lib.rs` `test_mode()`: a debug build with NODE_ENV=test) with
/// `AO_SHELL_LIBRARY_PROBE` set to the launch check's report address, exactly
/// `http://127.0.0.1:<port>/report`. A release build has neither the script nor the switch (pinned
/// by `a_release_build_has_neither_the_sign_in_windows_probe_nor_its_switch`). The probe tries every
/// command from inside the window and reports what happened by navigating to that address.
#[cfg(debug_assertions)]
pub mod library_probe {
    use tauri::Url;

    const SCRIPT: &str = include_str!("library_probe.js");
    /// The switch (test mode only): the check's report address.
    pub const SWITCH: &str = "AO_SHELL_LIBRARY_PROBE";

    /// The report address, only in its one accepted form: `http://127.0.0.1:<port>/report`.
    pub fn report_address(v: &str) -> Option<Url> {
        let u = Url::parse(v).ok()?;
        let ok = u.scheme() == "http"
            && u.host_str() == Some("127.0.0.1")
            && u.port().is_some_and(|p| p != 0)
            && u.path() == "/report"
            && u.query().is_none()
            && u.fragment().is_none()
            && u.username().is_empty()
            && u.password().is_none()
            && u.as_str() == v;
        ok.then_some(u)
    }

    /// The report address when the probe is asked for: test mode and the switch in its accepted form.
    pub fn from_env(test_mode: bool) -> Option<Url> {
        if !test_mode {
            return None;
        }
        report_address(&std::env::var(SWITCH).ok()?)
    }

    /// The probe with its configuration: the report address and the check's own page beside it, and
    /// (Task MAC7) where it says how far it got (`/progress/<step>`, the same server).
    pub fn script(report: &Url) -> String {
        let mut page = report.clone();
        page.set_path("/page");
        let mut progress = report.clone();
        progress.set_path("/progress");
        let cfg = serde_json::json!({ "report": report.as_str(), "page": page.as_str(), "progress": progress.as_str() });
        SCRIPT.replace("__LIBRARY_PROBE_CONFIG__", &cfg.to_string())
    }

    /// Task MAC7: the sign-in window's own trace, printed in test mode with the probe asked for (and
    /// so never in a release build): each navigation the window asked the shell to decide and the
    /// decision, each page load started (committed) and finished, the window's address
    /// FALLBACK_AFTER after it was made, and the fallback. R325 (no address in any line the shell
    /// prints): only the check's OWN addresses are printed, by scheme, host, port and path (never a
    /// query or fragment) — those on 127.0.0.1 at the report address's port, which the check serves
    /// (`https://…/sign-in` included) — and `about:` documents; any other address by its scheme alone
    /// (`shown`). Neither tauri 2.12.5 nor wry
    /// 0.57.2 reports a load that FAILED on any platform (wry's WKWebView navigation delegate answers
    /// no `didFail…Navigation`, its WebKitGTK side connects no `load-failed`): a navigation allowed
    /// with no page load after it is how a failed load shows here, with the address the web view
    /// then holds (`url()`; on a Mac none after a failed first load, wry's `url_from_webview`).
    pub const TRACE: &str = "AO_SHELL_LIBRARY_TRACE";
    /// How long after the window is made the shell looks at what it holds, and opens the check's
    /// page itself when no page load has started (Task MAC7: the probe's way there is the error page
    /// of the first address, which a Mac's web view may never show).
    pub const FALLBACK_AFTER: std::time::Duration = std::time::Duration::from_secs(10);

    /// An address as the trace prints it (`report`: the check's report address): one of the check's
    /// own by scheme, host, port and path; `about:` with its path; any other by its scheme alone.
    /// Visible ASCII only, the path at most 100 characters.
    pub fn shown(url: &Url, report: &Url) -> String {
        let clean = |s: &str, max: usize| -> String {
            let t: String = s.chars().map(|c| if c.is_ascii_graphic() { c } else { '?' }).collect();
            if t.chars().count() > max {
                format!("{}…", t.chars().take(max).collect::<String>())
            } else {
                t
            }
        };
        let checks_own = matches!(url.scheme(), "http" | "https") && url.host_str() == Some("127.0.0.1") && url.port().is_some() && url.port() == report.port();
        match url.scheme() {
            "about" => format!("about:{}", clean(url.path(), 20)),
            scheme if checks_own => format!("{scheme}://127.0.0.1:{}{}", url.port().unwrap_or(0), clean(url.path(), 100)),
            scheme => format!("{} (an address not the check's)", clean(scheme, 16)),
        }
    }

    pub fn navigation_line(url: &Url, allowed: bool, report: &Url) -> String {
        format!("{TRACE} navigation {} {}", shown(url, report), if allowed { "allowed" } else { "refused" })
    }

    pub fn page_load_line(finished: bool, url: &Url, report: &Url) -> String {
        format!("{TRACE} page-load {} {}", if finished { "finished" } else { "started" }, shown(url, report))
    }

    /// The address the window holds FALLBACK_AFTER after it was made, or why there is none.
    pub fn address_line(url: Result<Url, String>, report: &Url) -> String {
        let secs = FALLBACK_AFTER.as_secs();
        match url {
            Ok(u) => format!("{TRACE} address after {secs} s: {}", shown(&u, report)),
            Err(e) => {
                let e: String = e.chars().take(200).map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '?' }).collect();
                format!("{TRACE} address after {secs} s: none ({e})")
            }
        }
    }

    pub fn fallback_line() -> String {
        format!("{TRACE} fallback: no page started in {} s; the shell opens the check's page", FALLBACK_AFTER.as_secs())
    }

    /// The navigation rule, with its decision printed when the probe is asked for (`report`).
    pub fn decided(url: &Url, report: Option<&Url>) -> bool {
        let allowed = super::navigation_allowed(url);
        if let Some(report) = report {
            println!("{}", navigation_line(url, allowed, report));
        }
        allowed
    }

    /// FALLBACK_AFTER after the window was made: prints the address it holds and, when no page load
    /// has started (`started`), opens the check's own page (beside the report address) in it, so
    /// that the probe runs there all the same; the check counts that as a failure of the item and
    /// prints why (launch-check.mjs).
    pub fn watch(window: tauri::WebviewWindow, report: &Url, started: std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let report = report.clone();
        let mut page = report.clone();
        page.set_path("/page");
        std::thread::spawn(move || {
            std::thread::sleep(FALLBACK_AFTER);
            println!("{}", address_line(window.url().map_err(|e| e.to_string()), &report));
            if !started.load(std::sync::atomic::Ordering::SeqCst) {
                println!("{}", fallback_line());
                let _ = window.navigate(page);
            }
        });
    }

    /// Where the main window's probe opens the sign-in window: an https address on the check's port,
    /// which the check does not serve over TLS — the window shows its error page, and the probe goes
    /// on from there to the check's own page (a page outside the app, as any library's is).
    pub fn open_address(report: &Url) -> String {
        format!("https://127.0.0.1:{}/sign-in", report.port().unwrap_or(0))
    }
}

// ---------------------------------------------------------------------------------------------
// What only a Mac runs: one small function per need, the other platforms' form beside it.

/// The window's own data store, by identifier (WKWebsiteDataStore, macOS 14+; the app needs 15).
#[cfg(target_os = "macos")]
fn window_store<'a>(b: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, store: [u8; 16]) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    b.data_store_identifier(store)
}

/// Elsewhere: an ephemeral store, gone with the window (WebKitGTK's ephemeral context).
#[cfg(not(target_os = "macos"))]
fn window_store<'a>(b: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, _store: [u8; 16]) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    b.incognito(true)
}

/// Only a Mac keeps the window's store across quits ("Stay signed in").
#[cfg(target_os = "macos")]
fn store_can_stay() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn store_can_stay() -> bool {
    false
}

/// Removes every data store the web view lists. Tauri's two calls post their work to the main
/// thread and wait for WebKit's answer there (tauri 2.12.5 app.rs:433-480), so this runs on another
/// thread while the event loop runs. A store still in use (the window's process not yet gone) is
/// tried again a few times.
#[cfg(target_os = "macos")]
fn remove_data_stores(app: &tauri::AppHandle) -> bool {
    // R457: WebKit first (`start_webkit`); where it could not be started, nothing is asked of it and
    // the emptying counts as failed, as any other failure of it does.
    if !start_webkit(app) {
        return false;
    }
    tauri::async_runtime::block_on(async {
        let Ok(ids) = app.fetch_data_store_identifiers().await else { return false };
        let mut all = true;
        for id in ids {
            let mut gone = false;
            for _ in 0..5 {
                if app.remove_data_store(id).await.is_ok() {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            all &= gone;
        }
        all
    })
}

/// Starts WebKit in this process, once, before `WKWebsiteDataStore`'s class methods are used (R457):
/// obtains the default data store on the main thread and waits for that (at most 10 s). True when
/// WebKit has been started. Never on the main thread (it waits for it).
///
/// Without it the first start crashed (Mac build 6): EXC_BAD_ACCESS at 0x30 on the queue
/// com.apple.WebKit.WebsiteDataStoreIO, in WTF::RunLoop::dispatch <- WebsiteDataStore::fetchAllDataStoreIdentifiers.
/// The store is emptied at start-up before the service and the main window exist (so that a sign-in
/// never outlives a forced quit), so no web view has started WebKit yet and its answer went to a
/// main run loop that did not exist; `+defaultDataStore` runs WebKit's initialisation.
#[cfg(target_os = "macos")]
fn start_webkit(app: &tauri::AppHandle) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.load(Ordering::SeqCst) {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let posted = app.run_on_main_thread(move || {
        let started = if let Some(mtm) = objc2::MainThreadMarker::new() {
            // SAFETY: on the main thread, as the marker proves; the method takes nothing and returns
            // the shared default store, retained, released again here on the same thread.
            let _store = unsafe { objc2_web_kit::WKWebsiteDataStore::defaultDataStore(mtm) };
            true
        } else {
            false
        };
        let _ = tx.send(started);
    });
    if posted.is_err() {
        return false;
    }
    let started = rx.recv_timeout(Duration::from_secs(10)).unwrap_or(false);
    if started {
        STARTED.store(true, Ordering::SeqCst);
    }
    started
}

/// Elsewhere the window's store is ephemeral: there is nothing to remove.
#[cfg(not(target_os = "macos"))]
fn remove_data_stores(_app: &tauri::AppHandle) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const TICKET: &str = "0123456789abcdef0123456789abcdef";
    const TICKET2: &str = "fedcba9876543210fedcba9876543210";
    const GRANT: &str = "00112233445566778899aabbccddeeff";

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// A folder under the temporary folder, removed with all it holds when the test ends, whether it
    /// passes or fails (R331 h).
    struct TmpDir(PathBuf);

    impl std::ops::Deref for TmpDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TmpDir {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tmp(name: &str) -> TmpDir {
        let d = std::env::temp_dir().join(format!("ao-library-window-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        TmpDir(d)
    }

    // ----- cookies -----

    fn ck(name: &'static str, value: &'static str, domain: &'static str, path: &'static str, secure: bool) -> Cookie<'static> {
        Cookie::build((name, value)).domain(domain).path(path).secure(secure).build()
    }

    fn header(jar: &[Cookie<'static>], url: &str) -> Option<String> {
        cookie_header(jar, &u(url), SystemTime::now())
    }

    fn library_jar() -> Vec<Cookie<'static>> {
        vec![
            // The proxy's session, set for its whole domain (EZproxy's hyphenated hosts sit under it).
            ck("ezp", "1", ".ezproxy.lib.edu", "/", true),
            // A host-only cookie of the proxy's login host.
            ck("login", "1", "ezproxy.lib.edu", "/", true),
            // The university's single sign-on, for its whole domain.
            ck("sso", "1", ".lib.edu", "/", true),
            // A publisher's own host-only cookie.
            ck("pub", "1", "www.jstor.org", "/", true),
        ]
    }

    #[test]
    fn cookies_for_hostile_host_carry_only_its_own() {
        let jar = library_jar();
        for hostile in [
            "https://lib.edu.evil.example/x.pdf",
            "https://evillib.edu/x.pdf",
            "https://www-jstor-org.ezproxy.lib.edu.evil.example/x.pdf",
            "https://ezproxy.lib.edu.evil.example/",
            "https://evil.example/",
            "https://jstor.org/",
            "https://sub.www.jstor.org/",
            "https://xezproxy.lib.edu/",
            "https://10.0.0.1/",
        ] {
            let got = header(&jar, hostile);
            // Only `sso` may reach a host under lib.edu; none reaches anything else.
            assert!(got.is_none() || got.as_deref() == Some("sso=1"), "{hostile}: {got:?}");
            if !hostile.contains(".lib.edu/") {
                assert_eq!(got, None, "{hostile}");
            }
        }
        assert_eq!(header(&jar, "https://xezproxy.lib.edu/"), Some("sso=1".into()));
        assert_eq!(header(&jar, "https://www.jstor.org/stable/pdf/1.pdf"), Some("pub=1".into()));
        // An IP address never takes a domain cookie.
        let ipjar = vec![ck("ip", "1", ".0.0.1", "/", false), ck("exact", "1", "10.0.0.1", "/", false)];
        assert_eq!(header(&ipjar, "https://10.0.0.1/"), Some("exact=1".into()));
    }

    #[test]
    fn domain_cookie_of_proxy_reaches_hyphenated_host() {
        let jar = library_jar();
        assert_eq!(header(&jar, "https://www-jstor-org.ezproxy.lib.edu/stable/pdf/1.pdf"), Some("ezp=1; sso=1".into()));
        // The host-only login cookie reaches its exact host only.
        assert_eq!(header(&jar, "https://ezproxy.lib.edu/login?url=x"), Some("ezp=1; login=1; sso=1".into()));
        // `cookies_for_url` of wry 0.57.2 would have given the hyphenated host nothing (exact domain only).
        let exact: Vec<&Cookie<'static>> = jar.iter().filter(|c| c.domain() == Some("www-jstor-org.ezproxy.lib.edu")).collect();
        assert!(exact.is_empty());
    }

    #[test]
    fn a_host_only_cookie_and_a_domain_cookie_are_told_apart() {
        let host_only = ck("a", "1", "lib.edu", "/", false);
        let domain = ck("b", "1", ".lib.edu", "/", false);
        assert_eq!(raw_domain(&host_only).as_deref(), Some("lib.edu"));
        assert_eq!(raw_domain(&domain).as_deref(), Some(".lib.edu"));
        assert!(store_cookie(&host_only).unwrap().host_only);
        assert!(!store_cookie(&domain).unwrap().host_only);
        // An owned domain string (as wry builds it from the web view's String) reads the same.
        let owned = Cookie::build(("c".to_string(), "1".to_string())).domain(".lib.edu".to_string()).build();
        assert_eq!(raw_domain(&owned).as_deref(), Some(".lib.edu"));
        // Parsed from a header string: treated as host-only (fewer hosts, never more).
        let parsed = Cookie::parse("d=1; Domain=.lib.edu").unwrap();
        assert!(store_cookie(&parsed).unwrap().host_only);
        // No domain at all: not sent anywhere.
        assert_eq!(header(&[Cookie::build(("e", "1")).build()], "https://lib.edu/"), None);
    }

    #[test]
    fn path_and_secure_rules() {
        let jar = vec![ck("a", "1", "h.test", "/a", false)];
        assert_eq!(header(&jar, "https://h.test/a"), Some("a=1".into()));
        assert_eq!(header(&jar, "https://h.test/a/b"), Some("a=1".into()));
        assert_eq!(header(&jar, "https://h.test/ab"), None);
        assert_eq!(header(&jar, "https://h.test/"), None);
        let slash = vec![ck("s", "1", "h.test", "/a/", false)];
        assert_eq!(header(&slash, "https://h.test/a/b"), Some("s=1".into()));
        assert_eq!(header(&slash, "https://h.test/a"), None);
        // Secure only over https.
        let sec = vec![ck("s", "1", "h.test", "/", true), ck("p", "2", "h.test", "/", false)];
        assert_eq!(header(&sec, "https://h.test/"), Some("s=1; p=2".into()));
        assert_eq!(header(&sec, "http://h.test/"), Some("p=2".into()));
        // Longer paths first, otherwise the store's order.
        let order = vec![ck("r", "1", "h.test", "/", false), ck("deep", "1", "h.test", "/a/b", false), ck("mid", "1", "h.test", "/a", false), ck("r2", "1", "h.test", "/", false)];
        assert_eq!(header(&order, "https://h.test/a/b/c"), Some("deep=1; mid=1; r=1; r2=1".into()));
        // Other schemes get nothing.
        assert_eq!(header(&sec, "ftp://h.test/"), None);
    }

    #[test]
    fn expired_cookie_is_dropped() {
        let past = Cookie::parse("x=y; Expires=Wed, 21 Oct 2015 07:28:00 GMT").unwrap().expires().unwrap();
        let future = Cookie::parse("x=y; Expires=Fri, 01 Jan 2100 00:00:00 GMT").unwrap().expires().unwrap();
        let zero = Cookie::parse("x=y; Max-Age=0").unwrap().max_age().unwrap();
        let jar = vec![
            Cookie::build(("old", "1")).domain("h.test").path("/").expires(past).build(),
            Cookie::build(("new", "1")).domain("h.test").path("/").expires(future).build(),
            Cookie::build(("session", "1")).domain("h.test").path("/").build(),
            Cookie::build(("gone", "1")).domain("h.test").path("/").max_age(zero).build(),
        ];
        assert_eq!(header(&jar, "https://h.test/"), Some("new=1; session=1".into()));
        // Judged against the time given.
        let after_2100 = UNIX_EPOCH + Duration::from_secs(4_200_000_000);
        assert_eq!(cookie_header(&jar, &u("https://h.test/"), after_2100), Some("session=1".into()));
        // Nothing applies: no header at all.
        assert_eq!(header(&jar[..1], "https://h.test/"), None);
        assert_eq!(header(&[], "https://h.test/"), None);
    }

    #[test]
    fn the_cookie_header_is_at_most_8_kib_and_drops_the_tail() {
        let v = "v".repeat(3000);
        let v: &'static str = Box::leak(v.into_boxed_str());
        let jar = vec![ck("c3", v, "h.test", "/", false), ck("c1", v, "h.test", "/a/b", false), ck("c2", v, "h.test", "/a", false)];
        let h = header(&jar, "https://h.test/a/b/c").unwrap();
        assert!(h.len() <= COOKIE_HEADER_MAX);
        assert!(h.starts_with("c1=") && h.contains("; c2=") && !h.contains("c3="));
        let huge: &'static str = Box::leak("w".repeat(9000).into_boxed_str());
        assert_eq!(header(&[ck("big", huge, "h.test", "/", false)], "https://h.test/"), None);
        // A cookie whose name or value could break the header is never sent.
        let bad = vec![ck("a;b", "1", "h.test", "/", false), ck("c", "1\r\nX: y", "h.test", "/", false), ck("", "v", "h.test", "/", false)];
        assert_eq!(header(&bad, "https://h.test/"), None);
    }

    #[test]
    fn no_cookie_value_is_in_a_debug_output() {
        let c = ck("SESSIONNAME", "SECRETVALUE", ".lib.edu", "/", true);
        let shown = format!("{:?}", store_cookie(&c).unwrap());
        assert!(!shown.contains("SECRETVALUE") && !shown.contains("SESSIONNAME"), "{shown}");
        let input = FetchInput { url: u("https://h.test/SECRETPATH?t=SECRETQUERY"), previous: Some(u("https://h.test/PREV")), user_agent: "ua".into(), sign_in_hosts: vec!["SECRETHOST".into()] };
        let job = Job { generation: 1, ticket: TICKET.into(), input: input.clone(), abort: AbortSlot::default() };
        let event = LibraryEvent::new(Some(TICKET), State::Opened);
        let part = PartFile::new(PathBuf::from("/SECRETDIR"), GRANT.into());
        let device = DeviceState { stay_signed_in: true, store: [0xab; 16], sign_in_hosts: vec!["SECRETHOST.example".into()] };
        let config = Config { device: PathBuf::from("/SECRETDIR/x"), config_dir: PathBuf::from("/SECRETDIR"), test_mode: false, main_thread: std::thread::current().id() };
        for shown in [format!("{input:?}"), format!("{job:?}"), format!("{event:?}"), format!("{part:?}"), format!("{device:?}"), format!("{config:?}")] {
            for secret in ["SECRET", TICKET, GRANT, "abababab"] {
                assert!(!shown.contains(secret), "{shown}");
            }
        }
        drop(part);
    }

    // ----- addresses -----

    #[test]
    fn pdf_addresses_recognised() {
        for yes in [
            "https://p.test/article.pdf",
            "https://p.test/ARTICLE.PDF",
            "https://p.test/doi/pdf/10.1/x",
            "https://p.test/doi/pdfdirect/10.1/x",
            "https://p.test/content/pdf/10.1.pdf",
            "https://p.test/article-pdf/1/2/3",
            "https://p.test/bitstream/handle/1/2",
            "https://p.test/pdfft?md5=1",
            "https://p.test/files/download/123",
            "https://p.test/view?pdf=1",
            "https://p.test/view?download=true",
            "https://p.test/a%2Epdf",
        ] {
            assert!(looks_like_pdf_address(&u(yes)), "{yes}");
        }
        for no in ["https://p.test/article", "https://p.test/pdfs-about-us.html", "https://p.test/?q=pdf", "https://p.test/article.pdf.html", "ftp://p.test/a.pdf", "javascript:x.pdf", "https://p.test/#a.pdf"] {
            assert!(!looks_like_pdf_address(&u(no)), "{no}");
        }
    }

    #[test]
    fn never_fetches_saml_or_login_paths() {
        for sign_in in [
            "https://idp.lib.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=x",
            "https://lib.edu/Shibboleth.sso/SAML2/POST",
            "https://lib.edu/cas/login?service=x",
            "https://lib.edu/oauth/authorize?x",
            "https://login.lib.edu/LOGIN",
            "https://p.test/action/sso?redirect=x",
            "https://p.test/saml/acs",
            "https://p.test/x?SAMLResponse=abc",
            "https://p.test/%6Cogin/file.pdf",
            "https://p.test/signin.pdf",
            "https://ezproxy.lib.edu/anything.pdf",
        ] {
            assert!(sign_in_address(&u(sign_in), Some("ezproxy.lib.edu")), "{sign_in}");
        }
        for not in ["https://www-jstor-org.ezproxy.lib.edu/stable/pdf/1.pdf", "https://p.test/doi/pdf/10.1/x", "https://p.test/article.pdf"] {
            assert!(!sign_in_address(&u(not), Some("ezproxy.lib.edu")), "{not}");
        }
        assert!(!sign_in_address(&u("https://ezproxy.lib.edu/x.pdf"), None));
    }

    #[test]
    fn more_sign_in_forms_are_never_fetched() {
        let proxy = Some("ezproxy.lib.edu");
        for sign_in in [
            // The proxy's own host written with a trailing dot.
            "https://ezproxy.lib.edu./x.pdf",
            "https://EZPROXY.lib.edu./x.pdf",
            // SAML artifact, CAS service ticket, OAuth/OpenID answer.
            "https://p.test/acs?SAMLart=AAQAA",
            "https://p.test/acs?samlart=AAQAA",
            "https://p.test/x.pdf?ticket=ST-1-abcdef-cas",
            "https://p.test/x.pdf?TICKET=ST-9",
            "https://p.test/cb.pdf?code=abc&state=xyz",
            "https://p.test/cb.pdf?state=xyz&Code=abc",
            // ADFS, Keycloak (and other OpenID Connect servers), simpleSAMLphp.
            "https://sts.lib.edu/adfs/ls/?wa=wsignin1.0",
            "https://sts.lib.edu/ADFS/ls/x.pdf",
            "https://kc.lib.edu/realms/u/protocol/openid-connect/auth",
            "https://kc.lib.edu/realms/u/protocol/openid%2Dconnect/x.pdf",
            "https://idp.lib.edu/simplesaml/module.php/saml/x.pdf",
            "https://idp.lib.edu/simpleSAMLphp/x.pdf",
            "https://idp.lib.edu/%61dfs/x.pdf",
        ] {
            assert!(sign_in_address(&u(sign_in), proxy), "{sign_in}");
        }
        // A proxy host given with a trailing dot matches the host written without one.
        assert!(sign_in_address(&u("https://ezproxy.lib.edu/x.pdf"), Some("ezproxy.lib.edu.")));
        for not in [
            "https://p.test/x.pdf?code=abc",
            "https://p.test/x.pdf?state=xyz",
            "https://p.test/codes/state.pdf",
            "https://p.test/x.pdf?ticket=12345",
            "https://p.test/x.pdf?ticket=st-1",
            "https://p.test/x.pdf?t=ST-1",
            "https://p.test/adfsx/x.pdf",
            "https://p.test/openid-connected.pdf",
            "https://ezproxy.lib.edu.evil.example/x.pdf",
            "https://www-jstor-org.ezproxy.lib.edu./stable/pdf/1.pdf",
        ] {
            assert!(!sign_in_address(&u(not), proxy), "{not}");
        }
    }

    #[test]
    fn what_the_page_may_pass() {
        assert!(valid_ticket(TICKET));
        for bad in ["", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "0123456789abcdef0123456789abcdef0", "g123456789abcdef0123456789abcdef", " 123456789abcdef0123456789abcdef"] {
            assert!(!valid_ticket(bad), "{bad}");
        }
        assert!(window_address("https://ezproxy.lib.edu/login?url=https://doi.org/10.1/x").is_some());
        let long_ok = format!("https://h.test/{}", "a".repeat(WINDOW_URL_MAX - 15));
        assert!(window_address(&long_ok).is_some());
        let long = format!("https://h.test/{}", "a".repeat(WINDOW_URL_MAX));
        for bad in ["http://h.test/", "https://user@h.test/", "https://u:p@h.test/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "tauri://localhost/", "https://", " https://h.test/", "https://h.test/\nx", "https://h.test/a b", "", "h.test", long.as_str()] {
            assert!(window_address(bad).is_none(), "{bad}");
        }
        let b_ok = format!("https://h.test/{}", "a".repeat(BROWSER_URL_MAX - 15));
        let b_long = format!("https://h.test/{}", "a".repeat(BROWSER_URL_MAX));
        assert!(browser_address(&b_ok).is_some());
        assert!(browser_address(&b_long).is_none());
    }

    #[test]
    fn the_window_stays_on_web_pages_and_opens_no_second_window() {
        for ok in ["https://lib.edu/", "http://old.lib.edu/", "about:blank", "about:srcdoc", "blob:https://p.test/1-2"] {
            assert!(navigation_allowed(&u(ok)), "{ok}");
        }
        for refused in ["tauri://localhost/", "ipc://localhost/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:config", "blob:tauri://localhost/1", "mailto:a@b.test", "zoommtg://x", "x-apple.systempreferences:x"] {
            assert!(!navigation_allowed(&u(refused)), "{refused}");
        }
        assert_eq!(new_window_target(&u("https://p.test/a.pdf")), Some(u("https://p.test/a.pdf")));
        assert_eq!(new_window_target(&u("http://p.test/")), Some(u("http://p.test/")));
        for refused in ["javascript:alert(1)", "tauri://localhost/", "file:///x", "data:text/html,x", "about:blank", "mailto:a@b.test"] {
            assert_eq!(new_window_target(&u(refused)), None, "{refused}");
        }
    }

    #[test]
    fn private_and_loopback_addresses_are_refused_outside_test_mode() {
        let refused = [
            "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "0.0.0.0", "0.1.2.3",
            "224.0.0.1", "255.255.255.255", "240.0.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
            "::ffff:169.254.169.254", "::10.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1",
        ];
        for a in refused {
            assert!(!address_allowed(a.parse().unwrap(), false), "{a}");
        }
        for a in ["93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"] {
            assert!(address_allowed(a.parse().unwrap(), false), "{a}");
        }
        // Test mode allows the loopback address only.
        for a in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            assert!(address_allowed(a.parse().unwrap(), true), "{a}");
        }
        for a in ["10.0.0.1", "192.168.1.1", "fd00::1", "169.254.1.1", "0.0.0.0"] {
            assert!(!address_allowed(a.parse().unwrap(), true), "{a}");
        }
    }

    #[test]
    fn transition_reserved_and_documentation_ranges_are_refused() {
        // (range, an address inside, an address just outside)
        let table = [
            ("2002::/16 (6to4)", "2002:a00:1::1", "2003::1"),
            ("2002::/16 (6to4 of loopback)", "2002:7f00:1::", "2001:ffff:ffff:ffff::1"),
            ("2001::/32 (Teredo)", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:1::1"),
            ("64:ff9b:1::/48 (local NAT64)", "64:ff9b:1::a00:1", "64:ff9b:2::1"),
            ("64:ff9b:1::/48 (public inside)", "64:ff9b:1:ffff::5db8:d822", "64:ff9b:0:1::5db8:d822"),
            ("::ffff:0:0:0/96 (SIIT)", "::ffff:0:7f00:1", "::ffff:1:7f00:1"),
            ("::ffff:0:0:0/96 (SIIT, public inside)", "::ffff:0:5db8:d822", "::fffe:0:5db8:d822"),
            ("192.0.0.0/24", "192.0.0.9", "192.0.1.1"),
            ("192.0.0.0/24 (low edge)", "192.0.0.0", "191.255.255.255"),
            ("198.18.0.0/15", "198.19.255.255", "198.20.0.1"),
            ("198.18.0.0/15 (low edge)", "198.18.0.1", "198.17.255.255"),
            ("192.0.2.0/24", "192.0.2.1", "192.0.3.1"),
            ("198.51.100.0/24", "198.51.100.7", "198.51.101.1"),
            ("203.0.113.0/24", "203.0.113.9", "203.0.114.1"),
            ("2001:db8::/32", "2001:db8::1", "2001:db9::1"),
            ("2001:db8::/32 (high edge)", "2001:db8:ffff:ffff::1", "2001:db7:ffff::1"),
        ];
        for (range, inside, outside) in table {
            assert!(!address_allowed(inside.parse().unwrap(), false), "{range}: {inside}");
            assert!(address_allowed(outside.parse().unwrap(), false), "{range}: {outside}");
        }
        // The IPv4 ranges hold in their IPv6 forms too.
        for a in ["::ffff:192.0.2.1", "::ffff:198.18.0.1", "64:ff9b::c000:201", "::ffff:203.0.113.9"] {
            assert!(!address_allowed(a.parse().unwrap(), false), "{a}");
        }
    }

    // ----- the line -----

    #[test]
    fn file_grant_line_escapes_and_bounds() {
        let path = PathBuf::from("/Users/r/Library/Application Support/x/settings/library-inbox/a \"b\"\n\\c é 文/x.pdf");
        let line = file_grant_line(GRANT, TICKET, &path).unwrap();
        assert_eq!(
            line,
            format!("{{\"type\":\"file-grant\",\"id\":\"{GRANT}\",\"ticket\":\"{TICKET}\",\"path\":\"/Users/r/Library/Application Support/x/settings/library-inbox/a \\\"b\\\"\\n\\\\c é 文/x.pdf\"}}\n")
        );
        assert_eq!(line.matches('\n').count(), 1);
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["path"].as_str().unwrap(), path.to_str().unwrap());
        assert_eq!(v.as_object().unwrap().keys().cloned().collect::<Vec<_>>().len(), 4);
        // The same writer's rules as the folder grant line: a hostile name stays inside its string.
        let hostile = PathBuf::from("/x\",\"path\":\"/etc\"}\n{\"type\":\"folder-grant");
        let line = file_grant_line(GRANT, TICKET, &hostile).unwrap();
        assert_eq!(line.matches('\n').count(), 1);
        // Refused: bad ids, a relative path, a NUL, an over-long path, a line over 8 KiB.
        assert_eq!(file_grant_line("ABC", TICKET, &path), None);
        assert_eq!(file_grant_line(GRANT, "x", &path), None);
        assert_eq!(file_grant_line(GRANT, &TICKET.to_uppercase(), &path), None);
        assert_eq!(file_grant_line(GRANT, TICKET, Path::new("relative/x.pdf")), None);
        assert_eq!(file_grant_line(GRANT, TICKET, Path::new("/a\0b")), None);
        let ok = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES - 1));
        assert!(file_grant_line(GRANT, TICKET, Path::new(&ok)).is_some());
        let long = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES));
        assert_eq!(file_grant_line(GRANT, TICKET, Path::new(&long)), None);
        let escaped = format!("/{}", "\u{1}".repeat(1400));
        assert_eq!(file_grant_line(GRANT, TICKET, Path::new(&escaped)), None);
        let quotes = format!("/{}", "\"".repeat(4000));
        assert!(file_grant_line(GRANT, TICKET, Path::new(&quotes)).unwrap().len() <= GRANT_LINE_MAX_BYTES);
    }

    // ----- the start-up script -----

    /// Runs the start-up script in Node against a plain stand-in DOM at `href`, with the given
    /// `meta` contents, and reports what it did: the addresses it went to, what it stored, whether
    /// it touched anything that makes a request or reaches the shell, and the globals it added.
    fn run_script(href: &str, metas: &[&str], stored: &[&str], framed: bool) -> serde_json::Value {
        run_script_on_page(href, metas, stored, framed, "")
    }

    /// As `run_script`, with the page's own code `page` run after the script's start and before the
    /// document is loaded (where a page's scripts run).
    fn run_script_on_page(href: &str, metas: &[&str], stored: &[&str], framed: bool, page: &str) -> serde_json::Value {
        let harness = format!(
            r#"
const touched = [];
const href = {href};
const loc = new URL(href);
const assigned = [];
const location = {{ href: loc.href, origin: loc.origin, protocol: loc.protocol, assign(u) {{ assigned.push(String(u)); }} }};
class Storage {{ constructor() {{ this.m = new Map(); }} getItem(k) {{ return this.m.has(k) ? this.m.get(k) : null; }} setItem(k, v) {{ this.m.set(k, String(v)); }} }}
class Element {{ constructor(c) {{ this.c = c; }} getAttribute(n) {{ return n === "content" ? this.c : null; }} }}
let ready;
class Document {{
  querySelectorAll(sel) {{ return sel === 'meta[name="citation_pdf_url"]' ? {metas}.map((c) => new Element(c)) : []; }}
  addEventListener(type, fn) {{ if (type === "DOMContentLoaded") ready = fn; }}
}}
const document = new Proxy(new Document(), {{ get(t, k) {{ if (!["querySelectorAll", "addEventListener"].includes(k)) touched.push("document." + String(k)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; }} }});
const sessionStorage = new Storage();
for (const k of {stored}) sessionStorage.setItem(k, "1");
const w = {{ location, document, URL, sessionStorage, Document, Element, Storage }};
w.top = {framed} ? {{}} : w;
for (const k of ["fetch", "XMLHttpRequest", "navigator", "Image", "WebSocket", "EventSource", "postMessage", "__TAURI_INTERNALS__", "__TAURI__", "ipc", "webkit", "chrome", "opener", "parent", "localStorage", "indexedDB", "cookieStore"]) {{
  Object.defineProperty(w, k, {{ get() {{ touched.push(k); return undefined; }} }});
}}
const keysBefore = Object.keys(w).sort().join(",");
const window = w;
const gBefore = Object.keys(globalThis).sort().join(",");
(new Function("window", "document", "location", "sessionStorage", {script}))(w, document, location, sessionStorage);
{page}
if (ready) ready();
process.stdout.write(JSON.stringify({{
  assigned, touched, stored: [...sessionStorage.m.keys()],
  added: Object.keys(w).sort().join(",") !== keysBefore || Object.keys(globalThis).sort().join(",") !== gBefore,
  listened: !!ready,
}}));
"#,
            href = serde_json::Value::from(href),
            metas = serde_json::to_string(metas).unwrap(),
            stored = serde_json::to_string(stored).unwrap(),
            framed = framed,
            script = serde_json::Value::from(SCRIPT),
            page = page,
        );
        let out = std::process::Command::new("node").args(["--input-type=module", "-e", &harness]).output().expect("node on PATH");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).unwrap()
    }

    fn quiet(r: &serde_json::Value) {
        assert_eq!(r["assigned"], serde_json::json!([]), "{r}");
        assert_eq!(r["touched"], serde_json::json!([]), "{r}");
        assert_eq!(r["added"], false, "{r}");
    }

    #[test]
    fn the_start_up_script_is_small_and_goes_to_the_pages_own_pdf_once() {
        assert!(SCRIPT.len() <= SCRIPT_MAX_BYTES, "{} bytes", SCRIPT.len());
        let page = "https://www-jstor-org.ezproxy.lib.edu/stable/1";
        let pdf = "https://www-jstor-org.ezproxy.lib.edu/stable/pdf/1.pdf";
        let r = run_script(page, &[pdf], &[], false);
        assert_eq!(r["assigned"], serde_json::json!([pdf]), "{r}");
        assert_eq!(r["stored"], serde_json::json!([format!("ao-library-pdf {pdf}")]));
        assert_eq!(r["touched"], serde_json::json!([]), "{r}");
        assert_eq!(r["added"], false);
    }

    #[test]
    fn the_start_up_script_does_nothing_on_hostile_pages() {
        let page = "https://p.test/article/1";
        let long = format!("https://p.test/{}", "a".repeat(5000));
        let cases: Vec<(&str, Vec<&str>, Vec<String>)> = vec![
            ("another origin", vec!["https://evil.example/x.pdf"], vec![]),
            ("another port", vec!["https://p.test:8443/x.pdf"], vec![]),
            ("http", vec!["http://p.test/x.pdf"], vec![]),
            ("javascript", vec!["javascript:alert(1)//https://p.test/x.pdf"], vec![]),
            ("data", vec!["data:application/pdf;base64,JVBERi0="], vec![]),
            ("relative", vec!["/x.pdf"], vec![]),
            ("protocol-relative", vec!["//p.test/x.pdf"], vec![]),
            ("user name", vec!["https://user@p.test/x.pdf"], vec![]),
            ("user and password", vec!["https://u:p@p.test/x.pdf"], vec![]),
            ("already visited", vec!["https://p.test/x.pdf"], vec!["ao-library-pdf https://p.test/x.pdf".to_string()]),
            ("two metas", vec!["https://p.test/x.pdf", "https://p.test/y.pdf"], vec![]),
            ("5,000 characters", vec![long.as_str()], vec![]),
            ("the page itself", vec![page], vec![]),
            ("no meta", vec![], vec![]),
        ];
        for (what, metas, stored) in cases {
            let stored: Vec<&str> = stored.iter().map(String::as_str).collect();
            let r = run_script(page, &metas, &stored, false);
            quiet(&r);
            assert_eq!(r["stored"].as_array().unwrap().len(), stored.len(), "{what}: {r}");
        }
        // Not on an http page, not in a frame.
        quiet(&run_script("http://p.test/a", &["http://p.test/x.pdf"], &[], false));
        let framed = run_script(page, &["https://p.test/x.pdf"], &[], true);
        quiet(&framed);
        assert_eq!(framed["listened"], false);
    }

    #[test]
    fn a_page_that_redefines_url_cannot_bend_the_same_origin_rule() {
        let page = "https://p.test/article/1";
        let evil = "https://evil.example/x.pdf";
        // The reviewer's page: `origin` made to answer the page's own origin.
        let origin = "Object.defineProperty(URL.prototype, 'origin', { get() { return location.origin; } });";
        // Every getter the script reads, made to say \"same origin, https, no user\".
        let all = "for (const [k, v] of [['origin', location.origin], ['protocol', 'https:'], ['username', ''], ['password', '']]) Object.defineProperty(URL.prototype, k, { get() { return v; } }); Object.defineProperty(URL.prototype, 'href', { get() { return 'https://p.test/y.pdf'; } });";
        for code in [origin, all] {
            let r = run_script_on_page(page, &[evil], &[], false, code);
            quiet(&r);
            assert_eq!(r["stored"], serde_json::json!([]), "{r}");
        }
        // The script's own rule still holds on such a page for the page's own PDF.
        let own = "https://p.test/x.pdf";
        let r = run_script_on_page(page, &[own], &[], false, origin);
        assert_eq!(r["assigned"], serde_json::json!([own]), "{r}");
    }

    // ----- the inbox -----

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn the_inbox_is_a_private_folder_of_the_user() {
        let d = tmp("inbox");
        let inbox = prepare_inbox(&d).unwrap();
        assert_eq!(inbox, d.join(INBOX));
        assert_eq!(mode(&inbox), 0o700);
        // A wider mode is narrowed.
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&inbox, fs::Permissions::from_mode(0o755)).unwrap();
        prepare_inbox(&d).unwrap();
        assert_eq!(mode(&inbox), 0o700);
        // A symlink, or a file, is refused.
        let e = tmp("inbox-link");
        let elsewhere = tmp("inbox-elsewhere");
        std::os::unix::fs::symlink(&elsewhere, e.join(INBOX)).unwrap();
        assert_eq!(prepare_inbox(&e), Err(InboxError::NotAFolder));
        assert_eq!(empty_inbox(&e), Err(InboxError::NotAFolder));
        let f = tmp("inbox-file");
        fs::write(f.join(INBOX), b"x").unwrap();
        assert_eq!(prepare_inbox(&f), Err(InboxError::NotAFolder));
        // Another user's folder is refused (only checkable as root).
        if unsafe { libc::geteuid() } == 0 {
            let o = tmp("inbox-other");
            let other = o.join(INBOX);
            fs::create_dir(&other).unwrap();
            let c = std::ffi::CString::new(other.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::chown(c.as_ptr(), 12345, 12345) }, 0);
            assert_eq!(prepare_inbox(&o), Err(InboxError::NotYours));
            fs::remove_dir_all(&o).unwrap();
        }
        for x in [d, e, elsewhere, f] {
            fs::remove_dir_all(x).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_inbox_is_emptied_without_following_a_link() {
        let d = tmp("empty");
        let inbox = prepare_inbox(&d).unwrap();
        let outside = tmp("empty-outside");
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        fs::write(inbox.join(format!("{GRANT}.pdf")), b"%PDF-").unwrap();
        fs::write(inbox.join(format!("{GRANT}.part")), b"%PDF-").unwrap();
        fs::create_dir(inbox.join("sub")).unwrap();
        fs::write(inbox.join("sub").join("x"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, inbox.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("keep.txt"), inbox.join("filelink")).unwrap();
        empty_inbox(&d).unwrap();
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 0);
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        fs::remove_dir_all(&d).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_part_file_is_private_exclusive_and_removed_unless_completed() {
        let d = tmp("part");
        let inbox = prepare_inbox(&d).unwrap();
        // Completed: 0600, renamed, the part gone.
        let mut p = PartFile::new(inbox.clone(), GRANT.into());
        p.write(b"%PDF-1.7 a").unwrap();
        p.write(b"b").unwrap();
        assert_eq!(mode(&inbox.join(format!("{GRANT}.part"))), 0o600);
        let done = p.commit().unwrap();
        assert_eq!(done, inbox.join(format!("{GRANT}.pdf")));
        assert_eq!(fs::read(&done).unwrap(), b"%PDF-1.7 ab");
        assert_eq!(mode(&done), 0o600);
        assert!(!inbox.join(format!("{GRANT}.part")).exists());
        fs::remove_file(&done).unwrap();
        // Dropped (a failure, a cancellation): removed.
        let mut p = PartFile::new(inbox.clone(), GRANT.into());
        p.write(b"%PDF-").unwrap();
        drop(p);
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 0);
        // Never written: nothing to remove, nothing made.
        drop(PartFile::new(inbox.clone(), GRANT.into()));
        // A file or a link already at its name is not written through, and not removed.
        let planted = inbox.join(format!("{GRANT}.part"));
        fs::write(&planted, b"theirs").unwrap();
        let mut p = PartFile::new(inbox.clone(), GRANT.into());
        assert!(p.write(b"%PDF-").is_err());
        drop(p);
        assert_eq!(fs::read(&planted).unwrap(), b"theirs");
        fs::remove_file(&planted).unwrap();
        let target = d.join("target");
        std::os::unix::fs::symlink(&target, &planted).unwrap();
        let mut p = PartFile::new(inbox.clone(), GRANT.into());
        assert!(p.write(b"%PDF-").is_err());
        drop(p);
        assert!(!target.exists());
        fs::remove_dir_all(&d).unwrap();
    }

    // ----- the hand-over -----

    use crate::service::ServiceInput;

    #[derive(Clone, Default)]
    struct Written(Arc<Mutex<Vec<u8>>>);
    impl io::Write for Written {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Written {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    struct FakeTarget {
        stopping: AtomicBool,
        input: Option<ServiceInput>,
    }
    impl GrantTarget for FakeTarget {
        fn stopping(&self) -> bool {
            self.stopping.load(Ordering::SeqCst)
        }
        fn service_input(&self) -> Option<ServiceInput> {
            self.input.clone()
        }
    }

    /// A gate whose ticket is open: the line is written.
    const OPEN: fn(&mut dyn FnMut() -> bool) -> Option<bool> = |send| Some(send());

    fn written_part(inbox: &Path) -> PartFile {
        let mut p = PartFile::new(inbox.to_path_buf(), GRANT.into());
        p.write(b"%PDF-1.7 x").unwrap();
        p
    }

    #[test]
    fn the_file_is_named_to_the_service_by_one_line_on_the_same_writer() {
        let d = tmp("handover");
        let inbox = prepare_inbox(&d).unwrap();
        let w = Written::default();
        let target = FakeTarget { stopping: AtomicBool::new(false), input: Some(ServiceInput::for_test(w.clone())) };
        hand_over(&target, TICKET, written_part(&inbox), &OPEN).unwrap();
        let file = inbox.join(format!("{GRANT}.pdf"));
        assert_eq!(w.text(), file_grant_line(GRANT, TICKET, &file).unwrap());
        assert!(file.is_file());
        fs::remove_file(&file).unwrap();
        // The app is closing, the service is gone, or its pipe is closed: no line, and no file left.
        let stopping = FakeTarget { stopping: AtomicBool::new(true), input: Some(ServiceInput::for_test(w.clone())) };
        assert_eq!(hand_over(&stopping, TICKET, written_part(&inbox), &OPEN), Err(HandOverError::NoService));
        let gone = FakeTarget { stopping: AtomicBool::new(false), input: None };
        assert_eq!(hand_over(&gone, TICKET, written_part(&inbox), &OPEN), Err(HandOverError::NoService));
        let closed = FakeTarget { stopping: AtomicBool::new(false), input: Some(ServiceInput::for_test(w.clone())) };
        closed.input.as_ref().unwrap().close_for_test();
        assert_eq!(hand_over(&closed, TICKET, written_part(&inbox), &OPEN), Err(HandOverError::Write));
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 0);
        assert_eq!(w.text().matches('\n').count(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    // ----- the device file -----

    #[test]
    fn the_device_file_is_private_atomic_and_strict() {
        let d = tmp("device");
        let p = d.join(DEVICE_FILE);
        assert_eq!(read_device(&p), None);
        let s = DeviceState { stay_signed_in: true, store: new_store_id().unwrap(), sign_in_hosts: vec!["ezproxy.lib.edu".into(), "[2606:4700::1111]".into()] };
        write_device(&p, &s).unwrap();
        assert_eq!(read_device(&p), Some(s.clone()));
        #[cfg(unix)]
        assert_eq!(mode(&p), 0o600);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        let text = fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("{\"staySignedIn\":true,\"store\":\""));
        for bad in [
            "",
            "{}",
            "[]",
            "{\"staySignedIn\":true}",
            "{\"staySignedIn\":\"yes\",\"store\":\"00112233445566778899aabbccddeeff\"}",
            "{\"staySignedIn\":true,\"store\":\"00112233445566778899AABBCCDDEEFF\"}",
            "{\"staySignedIn\":true,\"store\":\"0011\"}",
            "{\"staySignedIn\":true,\"store\":\"00112233445566778899aabbccddeeff\",\"x\":1}",
        ] {
            assert_eq!(parse_device(bad), None, "{bad}");
        }
        fs::write(&p, format!("{}{}", " ".repeat(5000), device_text(&s))).unwrap();
        assert_eq!(read_device(&p), None);
        let a = new_store_id().unwrap();
        assert_ne!(a, new_store_id().unwrap());
        assert_eq!(a[6] >> 4, 4);
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_device_file_that_is_a_link_is_not_read() {
        let d = tmp("device-link");
        let elsewhere = d.join("elsewhere.json");
        let kept = DeviceState { stay_signed_in: true, store: [7; 16], sign_in_hosts: Vec::new() };
        write_device(&elsewhere, &kept).unwrap();
        let p = d.join(DEVICE_FILE);
        std::os::unix::fs::symlink(&elsewhere, &p).unwrap();
        assert_eq!(read_device(&p), None);
        // At the start it counts as unreadable: not kept, a new store id; what it pointed to is left.
        let host = FakeHost::new(Some(p.clone()), true);
        let lib = Library::default();
        assert!(lib.at_start(&host));
        assert!(!lib.stay_signed_in());
        assert!(!fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
        let now = read_device(&p).unwrap();
        assert!(!now.stay_signed_in);
        assert_ne!(now.store, kept.store);
        assert_eq!(read_device(&elsewhere), Some(kept.clone()));
        fs::remove_dir_all(d).unwrap();
    }

    // ----- the controller -----

    struct FakeHost {
        exists: AtomicBool,
        create_ok: bool,
        navigate_ok: AtomicBool,
        created: Mutex<Vec<(Url, [u8; 16])>>,
        navigated: Mutex<Vec<Url>>,
        titles: Mutex<Vec<String>>,
        current: Mutex<Option<Url>>,
        events: Mutex<Vec<LibraryEvent>>,
        jobs: Mutex<Vec<Job>>,
        stopping: AtomicBool,
        close_asked: AtomicUsize,
        /// The window refuses to close within the wait (R361).
        close_refused: AtomicBool,
        device: Option<PathBuf>,
        can_stay: bool,
        removed: AtomicUsize,
        /// Runs once while the window is being built (FR-561: what else happens before an open answers).
        on_create: Mutex<Option<Box<dyn FnOnce(&FakeHost) + Send>>>,
    }

    impl FakeHost {
        fn new(device: Option<PathBuf>, can_stay: bool) -> Self {
            FakeHost {
                exists: AtomicBool::new(false),
                create_ok: true,
                navigate_ok: AtomicBool::new(true),
                created: Mutex::default(),
                navigated: Mutex::default(),
                titles: Mutex::default(),
                current: Mutex::default(),
                events: Mutex::default(),
                jobs: Mutex::default(),
                stopping: AtomicBool::new(false),
                close_asked: AtomicUsize::new(0),
                close_refused: AtomicBool::new(false),
                device,
                can_stay,
                removed: AtomicUsize::new(0),
                on_create: Mutex::default(),
            }
        }
        fn events(&self) -> Vec<LibraryEvent> {
            self.events.lock().unwrap().clone()
        }
        fn last(&self) -> LibraryEvent {
            self.events().last().cloned().unwrap()
        }
        fn jobs(&self) -> usize {
            self.jobs.lock().unwrap().len()
        }
        fn at(&self, url: &str) {
            *self.current.lock().unwrap() = Some(u(url));
        }
    }

    impl Host for FakeHost {
        fn window_exists(&self) -> bool {
            self.exists.load(Ordering::SeqCst)
        }
        fn create_window(&self, url: &Url, store: [u8; 16], title: &str) -> bool {
            let during = self.on_create.lock().unwrap().take();
            if let Some(f) = during {
                f(self);
            }
            self.created.lock().unwrap().push((url.clone(), store));
            self.titles.lock().unwrap().push(title.to_string());
            self.exists.store(self.create_ok, Ordering::SeqCst);
            self.create_ok
        }
        fn navigate(&self, url: &Url) -> bool {
            self.navigated.lock().unwrap().push(url.clone());
            self.navigate_ok.load(Ordering::SeqCst)
        }
        fn set_title(&self, title: &str) {
            self.titles.lock().unwrap().push(title.to_string());
        }
        fn current_url(&self) -> Option<Url> {
            self.current.lock().unwrap().clone()
        }
        fn close_window(&self) {
            self.close_asked.fetch_add(1, Ordering::SeqCst);
        }
        fn close_window_and_wait(&self) {
            self.close_asked.fetch_add(1, Ordering::SeqCst);
            if !self.close_refused.load(Ordering::SeqCst) {
                self.exists.store(false, Ordering::SeqCst);
            }
        }
        fn emit(&self, event: &LibraryEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
        fn start_fetch(&self, job: Job) {
            self.jobs.lock().unwrap().push(job);
        }
        fn stopping(&self) -> bool {
            self.stopping.load(Ordering::SeqCst)
        }
        fn device_path(&self) -> Option<PathBuf> {
            self.device.clone()
        }
        fn store_can_stay(&self) -> bool {
            self.can_stay
        }
        fn remove_data_stores(&self) -> bool {
            self.removed.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    const START: &str = "https://ezproxy.lib.edu/login?url=https://doi.org/10.1/x";
    const PDF: &str = "https://www-jstor-org.ezproxy.lib.edu/stable/pdf/1.pdf";

    fn started(name: &str) -> (Library, FakeHost, TmpDir) {
        let d = tmp(name);
        let host = FakeHost::new(Some(d.join(DEVICE_FILE)), false);
        let lib = Library::default();
        assert!(lib.at_start(&host));
        (lib, host, d)
    }

    #[test]
    fn open_needs_the_main_window_a_ticket_and_an_https_address() {
        let (lib, host, d) = started("open");
        for (caller, ticket, url) in [
            ("library", TICKET, START),
            ("", TICKET, START),
            ("Main", TICKET, START),
            ("main", "", START),
            ("main", &TICKET.to_uppercase(), START),
            ("main", &TICKET[..31], START),
            ("main", TICKET, "http://ezproxy.lib.edu/login"),
            ("main", TICKET, "https://user:pw@ezproxy.lib.edu/login"),
            ("main", TICKET, "javascript:alert(1)"),
            ("main", TICKET, "tauri://localhost/"),
            ("main", TICKET, &format!("https://h.test/{}", "a".repeat(5000))),
        ] {
            assert!(!lib.open(&host, caller, ticket, url, Start::Library), "{caller} {url}");
        }
        assert!(host.created.lock().unwrap().is_empty());
        assert!(host.events().is_empty());
        // A good open builds the window once, with the store id of the device file.
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        let created = host.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].0, u(START));
        assert_eq!(Some(created[0].1), read_device(&d.join(DEVICE_FILE)).map(|s| s.store));
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Opened));
        // A second open while a ticket is open is refused.
        assert!(!lib.open(&host, "main", TICKET2, START, Start::Library));
        assert!(!lib.open(&host, "main", TICKET, START, Start::Library));
        assert_eq!(host.created.lock().unwrap().len(), 1);
        // The app closing: refused.
        let (lib2, host2, d2) = started("open-stopping");
        host2.stopping.store(true, Ordering::SeqCst);
        assert!(!lib2.open(&host2, "main", TICKET, START, Start::Library));
        for x in [d, d2] {
            fs::remove_dir_all(x).unwrap();
        }
    }

    #[test]
    fn a_window_that_could_not_be_built_leaves_no_ticket() {
        let d = tmp("open-fail");
        let mut host = FakeHost::new(Some(d.join(DEVICE_FILE)), false);
        host.create_ok = false;
        let lib = Library::default();
        lib.at_start(&host);
        assert!(!lib.open(&host, "main", TICKET, START, Start::Library));
        host.create_ok = true;
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_page_reaching_three_pdf_addresses_fetches_once_and_one_file_per_ticket() {
        let (lib, host, d) = started("three");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u("https://www-jstor-org.ezproxy.lib.edu/stable/1"), t0);
        assert_eq!(host.jobs(), 0);
        for p in [PDF, "https://www-jstor-org.ezproxy.lib.edu/stable/pdf/2.pdf", "https://www-jstor-org.ezproxy.lib.edu/stable/pdf/3.pdf"] {
            lib.page_loaded(&host, &u(p), t0);
        }
        assert_eq!(host.jobs(), 1);
        let job = host.jobs.lock().unwrap().remove(0);
        assert_eq!(job.ticket, TICKET);
        assert_eq!(job.input.url, u(PDF));
        assert_eq!(job.input.previous, Some(u("https://www-jstor-org.ezproxy.lib.edu/stable/1")));
        assert_eq!(job.input.user_agent, USER_AGENT);
        assert_eq!(job.input.sign_in_hosts, vec!["ezproxy.lib.edu"]);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Fetching));
        // Handed over: the ticket ends in the shell too; nothing more is fetched for it.
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::HandedOver));
        lib.page_loaded(&host, &u("https://www-jstor-org.ezproxy.lib.edu/stable/pdf/4.pdf"), t0 + Duration::from_secs(60));
        assert_eq!(host.jobs(), 0);
        host.at(PDF);
        assert!(!lib.take_pdf(&host, "main", t0 + Duration::from_secs(60)));
        assert_eq!(host.last(), LibraryEvent::refused(None, State::Failed, Reason::NoTicket));
        // A fetch that ended without a file leaves the ticket open for another try.
        lib.open(&host, "main", TICKET2, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0 + Duration::from_secs(60));
        let job = host.jobs.lock().unwrap().remove(0);
        lib.finish(&host, job.generation, TICKET2, Outcome::Fetch(FetchError::NotPdf), t0 + Duration::from_secs(61));
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET2), State::NotAPdf));
        assert!(lib.take_pdf(&host, "main", t0 + Duration::from_secs(62)));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_open_for_a_new_ticket_reuses_the_window_and_goes_to_the_address() {
        let (lib, host, d) = started("reuse");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0);
        let job = host.jobs.lock().unwrap().remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        let next = "https://ezproxy.lib.edu/login?url=https://doi.org/10.2/y";
        assert!(lib.open(&host, "main", TICKET2, next, Start::Library));
        assert_eq!(host.created.lock().unwrap().len(), 1);
        assert_eq!(host.navigated.lock().unwrap().clone(), vec![u(next)]);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET2), State::Opened));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn take_pdf_with_no_ticket_fetches_nothing() {
        let (lib, host, d) = started("noticket");
        host.at(PDF);
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.jobs(), 0);
        assert_eq!(host.last(), LibraryEvent::refused(None, State::Failed, Reason::NoTicket));
        assert_eq!(host.last().to_json(), serde_json::json!({ "ticket": null, "state": "failed", "reason": "no-ticket" }));
        lib.page_loaded(&host, &u(PDF), Instant::now());
        assert_eq!(host.jobs(), 0);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_fetch_within_20_s_of_the_last_hand_over_is_refused() {
        let (lib, host, d) = started("pause");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0);
        let job = host.jobs.lock().unwrap().remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        lib.open(&host, "main", TICKET2, START, Start::Library);
        host.at(PDF);
        assert!(!lib.take_pdf(&host, "main", t0 + Duration::from_secs(10)));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::Failed, Reason::Pause));
        lib.page_loaded(&host, &u(PDF), t0 + Duration::from_secs(19));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::Failed, Reason::Pause));
        assert_eq!(host.jobs(), 0);
        assert!(lib.take_pdf(&host, "main", t0 + Duration::from_secs(21)));
        assert_eq!(host.jobs(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_second_fetch_while_one_runs_is_refused() {
        let (lib, host, d) = started("busy");
        lib.open(&host, "main", TICKET, START, Start::Library);
        host.at(PDF);
        assert!(lib.take_pdf(&host, "main", Instant::now()));
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::Failed, Reason::Busy));
        assert_eq!(host.jobs(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_sign_in_address_is_never_fetched_and_the_window_is_left_where_it_is() {
        let (lib, host, d) = started("signin");
        lib.open(&host, "main", TICKET, START, Start::Library);
        for p in ["https://ezproxy.lib.edu/download/x.pdf", "https://idp.lib.edu/idp/profile/SAML2/Redirect/SSO.pdf", "https://p.test/login/file.pdf"] {
            lib.page_loaded(&host, &u(p), Instant::now());
            host.at(p);
            assert!(!lib.take_pdf(&host, "main", Instant::now()));
            assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::SignIn));
        }
        host.at("http://p.test/a.pdf");
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::NotHttps));
        assert_eq!(host.jobs(), 0);
        assert!(host.navigated.lock().unwrap().is_empty());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_window_closing_ends_the_ticket_and_cancels_the_fetch() {
        let (lib, host, d) = started("close");
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), Instant::now());
        let job = host.jobs.lock().unwrap().remove(0);
        let aborted = Arc::new(AtomicBool::new(false));
        let a = aborted.clone();
        job.abort.set(Box::new(move || a.store(true, Ordering::SeqCst)));
        lib.window_closed(&host);
        assert!(aborted.load(Ordering::SeqCst));
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Closed));
        // The cancelled fetch's end is not said again.
        let n = host.events().len();
        lib.finish(&host, job.generation, TICKET, Outcome::Fetch(FetchError::Network), Instant::now());
        assert_eq!(host.events().len(), n);
        // The ticket is gone.
        host.at(PDF);
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(None, State::Failed, Reason::NoTicket));
        // close_library_window asks the window to close; without a window it ends the ticket at once.
        lib.open(&host, "main", TICKET2, START, Start::Library);
        lib.close(&host, "library");
        assert_eq!(host.close_asked.load(Ordering::SeqCst), 1);
        lib.close(&host, "main");
        assert_eq!(host.close_asked.load(Ordering::SeqCst), 2);
        host.exists.store(false, Ordering::SeqCst);
        lib.close(&host, "main");
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET2), State::Closed));
        fs::remove_dir_all(d).unwrap();
    }

    // ----- FR-561 (R472): a window is closed only on behalf of the open that made it -----

    #[test]
    fn the_decision_which_open_the_window_open_now_belongs_to() {
        // An open's answer: true while no other open has taken the window (its own, or none: closed meanwhile).
        assert!(open_still_its_own(Some(TICKET), TICKET));
        assert!(open_still_its_own(None, TICKET));
        assert!(!open_still_its_own(Some(TICKET2), TICKET));
        // A close for a ticket: only the window that ticket's open made; twice, or late, it touches no other.
        assert!(close_allowed(Some(TICKET), Some(TICKET)));
        assert!(!close_allowed(Some(TICKET2), Some(TICKET)));
        assert!(!close_allowed(None, Some(TICKET)));
        assert!(!close_allowed(Some(TICKET), Some("not-a-ticket")));
        // A close with no ticket (the page's close of a window it did not open, R342 b): whatever is open, as before.
        assert!(close_allowed(Some(TICKET2), None));
        assert!(close_allowed(None, None));
    }

    /// The reviewer's case in the shell (R472): the page gave up on an open (TICKET) and closed what was there
    /// (R342 b, no ticket); a newer open (TICKET2: a later start, or "Test" on Your library) took the window before
    /// the first open answered. The first open answers false and says nothing, so the page's late handler closes
    /// nothing; a close for the first ticket, late or twice, leaves the newer window alone.
    #[test]
    fn a_late_success_of_an_older_open_answers_false_and_touches_the_newer_window_not() {
        let (lib, host, d) = started("fr561-late-success");
        let lib = Arc::new(lib);
        let inner = lib.clone();
        *host.on_create.lock().unwrap() = Some(Box::new(move |h: &FakeHost| {
            inner.close(h, "main");
            assert!(inner.open(h, "main", TICKET2, START, Start::Library));
        }));
        assert!(!lib.open(&host, "main", TICKET, START, Start::Library), "the older open answers false");
        let opened: Vec<_> = host.events().into_iter().filter(|e| e.state == State::Opened).collect();
        assert_eq!(opened, vec![LibraryEvent::new(Some(TICKET2), State::Opened)]);
        // The newer open keeps its ticket: its fetch still starts.
        lib.page_loaded(&host, &u(PDF), Instant::now());
        assert_eq!(host.jobs(), 1);
        assert_eq!(host.jobs.lock().unwrap()[0].ticket, TICKET2);
        // A late close for the older ticket, and the same close again: nothing is closed, nothing ended.
        let asked = host.close_asked.load(Ordering::SeqCst);
        lib.close_for(&host, "main", Some(TICKET));
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked);
        host.exists.store(false, Ordering::SeqCst);
        let n = host.events().len();
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.events().len(), n, "no window: the newer ticket is not ended either");
        host.exists.store(true, Ordering::SeqCst);
        // Its own close closes it.
        lib.close_for(&host, "main", Some(TICKET2));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_late_failure_of_an_older_open_leaves_the_newer_window_and_ticket_as_they_are() {
        let (lib, mut host, d) = started("fr561-late-failure");
        host.create_ok = false;
        let lib = Arc::new(lib);
        let inner = lib.clone();
        *host.on_create.lock().unwrap() = Some(Box::new(move |h: &FakeHost| {
            inner.close(h, "main");
            h.exists.store(true, Ordering::SeqCst);
            h.navigate_ok.store(true, Ordering::SeqCst);
            assert!(inner.open(h, "main", TICKET2, START, Start::Library));
        }));
        let asked = host.close_asked.load(Ordering::SeqCst);
        assert!(!lib.open(&host, "main", TICKET, START, Start::Library));
        // The stand-in's failed build marked the window gone; the newer open's window is there.
        host.exists.store(true, Ordering::SeqCst);
        lib.page_loaded(&host, &u(PDF), Instant::now());
        assert_eq!(host.jobs.lock().unwrap().iter().map(|j| j.ticket.clone()).collect::<Vec<_>>(), vec![TICKET2.to_string()]);
        // Nothing closed on the older open's behalf: only the page's own close of what was there (no window then).
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked);
        // A late close for the older ticket leaves the newer window.
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked);
        fs::remove_dir_all(d).unwrap();
    }

    /// The reviewer's sequence (R486 g, A-M1): the page gave up on an open (TICKET) and closed what was there
    /// before its window stood (no window yet: the ticket ends); the older open's window then stands, and a newer
    /// open (TICKET2) re-uses it and fails. The window is still the older open's: its ticketed close closes it.
    #[test]
    fn a_newer_open_failing_while_an_older_window_is_built_leaves_that_window_to_the_older_open() {
        let (lib, host, d) = started("fr561-failed-newer");
        let lib = Arc::new(lib);
        let inner = lib.clone();
        *host.on_create.lock().unwrap() = Some(Box::new(move |h: &FakeHost| {
            inner.close(h, "main");
            h.exists.store(true, Ordering::SeqCst);
            h.navigate_ok.store(false, Ordering::SeqCst);
            assert!(!inner.open(h, "main", TICKET2, START, Start::Library), "the newer open fails");
        }));
        assert!(lib.open(&host, "main", TICKET, START, Start::Library), "the older open's window stands");
        assert!(host.window_exists());
        let asked = host.close_asked.load(Ordering::SeqCst);
        // The failed open's ticket owns nothing.
        lib.close_for(&host, "main", Some(TICKET2));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked);
        // The older open's ticketed close closes its window.
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1, "the older open's close was refused");
        fs::remove_dir_all(d).unwrap();
    }

    /// R489: an open is building its window; the page's close (no ticket) finds no window yet, ends the open and
    /// clears the owner; the window is then built and the open answers true. The window stands owned by nobody
    /// no more: it is that open's, so the page's ticketed close for it closes it.
    #[test]
    fn a_window_built_after_its_open_was_closed_is_that_open_s_and_its_ticketed_close_closes_it() {
        let (lib, host, d) = started("fr561-built-after-close");
        let lib = Arc::new(lib);
        let inner = lib.clone();
        *host.on_create.lock().unwrap() = Some(Box::new(move |h: &FakeHost| inner.close(h, "main")));
        assert!(lib.open(&host, "main", TICKET, START, Start::Library), "the open answers true");
        assert_eq!(host.events().iter().filter(|e| e.state == State::Closed).count(), 1, "the close ended the open");
        assert!(host.window_exists());
        let asked = host.close_asked.load(Ordering::SeqCst);
        lib.close_for(&host, "main", Some(TICKET2));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked, "another ticket's close closed the window");
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1, "the open's ticketed close was refused");
        fs::remove_dir_all(d).unwrap();
    }

    /// R486 g (A-M2): a failed open puts the window back to the open whose window it is — the window a hand-over
    /// left stays its open's, so that open's close still closes it — and to none when no window stands.
    #[test]
    fn a_failed_open_leaves_the_window_to_the_open_whose_window_it_is_and_none_when_none_stands() {
        let (lib, mut host, d) = started("fr561-failed-reuse");
        let t0 = Instant::now();
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        lib.page_loaded(&host, &u(PDF), t0);
        let job = host.jobs.lock().unwrap().remove(0);
        assert_eq!(lib.send_if_current(&host, job.generation, TICKET, t0, &mut || true), Some(true));
        // The hand-over ended the ticket; the window stays. A newer open re-uses it and fails.
        host.navigate_ok.store(false, Ordering::SeqCst);
        assert!(!lib.open(&host, "main", TICKET2, START, Start::Library));
        let asked = host.close_asked.load(Ordering::SeqCst);
        lib.close_for(&host, "main", Some(TICKET2));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked, "the failed open's close closed the window");
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1, "the window's own open could not close it");
        // The window is gone (its end not yet heard) and a newer open fails to build one: no window stands, so
        // the window belongs to no open, and no ticketed close does anything.
        host.exists.store(false, Ordering::SeqCst);
        host.create_ok = false;
        assert!(!lib.open(&host, "main", TICKET2, START, Start::Library));
        let n = host.events().len();
        for t in [TICKET, TICKET2] {
            lib.close_for(&host, "main", Some(t));
        }
        assert_eq!(host.events().len(), n, "a ticketed close acted for a window that does not stand");
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn after_a_hand_over_the_window_still_belongs_to_its_open_and_a_newer_one_is_not_closed_by_an_older_close() {
        let (lib, host, d) = started("fr561-handover");
        let t0 = Instant::now();
        let asked = host.close_asked.load(Ordering::SeqCst);
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        lib.page_loaded(&host, &u(PDF), t0);
        let job = host.jobs.lock().unwrap().remove(0);
        assert_eq!(lib.send_if_current(&host, job.generation, TICKET, t0, &mut || true), Some(true));
        // The window stays after the hand-over: its own close still closes it.
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1);
        host.exists.store(false, Ordering::SeqCst);
        lib.window_closed(&host);
        // A newer open; the older close, said again, leaves it.
        assert!(lib.open(&host, "main", TICKET2, START, Start::Library));
        lib.close_for(&host, "main", Some(TICKET));
        assert_eq!(host.close_asked.load(Ordering::SeqCst), asked + 1);
        assert!(!lib.open(&host, "main", TICKET, START, Start::Library), "the newer ticket is still held");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_window_closing_between_a_fetch_s_start_and_its_abort_still_cancels_it() {
        let (lib, host, d) = started("race");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0);
        let job = host.jobs.lock().unwrap().remove(0);
        // The reviewer's interleaving: the fetch is started, the window closes, and only then is the
        // way to cancel the fetch kept.
        lib.window_closed(&host);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Closed));
        let aborted = Arc::new(AtomicBool::new(false));
        let a = aborted.clone();
        job.abort.set(Box::new(move || a.store(true, Ordering::SeqCst)));
        assert!(aborted.load(Ordering::SeqCst), "the fetch was not cancelled");
        // Its outcome, should one still arrive, is dropped: nothing said, no pause started.
        let n = host.events().len();
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        assert_eq!(host.events().len(), n);
        // A new ticket's fetch starts at once, the old one cancelled before it.
        assert!(lib.open(&host, "main", TICKET2, START, Start::Library));
        lib.page_loaded(&host, &u(PDF), t0 + Duration::from_secs(1));
        assert_eq!(host.jobs(), 1);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET2), State::Fetching));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_outcome_that_arrives_after_its_ticket_ended_hands_nothing_over() {
        let (lib, host, d) = started("late");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0);
        let old = host.jobs.lock().unwrap().remove(0);
        lib.window_closed(&host);
        // A new ticket's fetch is running when the old fetch's file is complete.
        lib.open(&host, "main", TICKET2, START, Start::Library);
        lib.page_loaded(&host, &u("https://www-jstor-org.ezproxy.lib.edu/stable/pdf/2.pdf"), t0);
        let new = host.jobs.lock().unwrap().remove(0);
        let inbox = prepare_inbox(&d).unwrap();
        let w = Written::default();
        let target = FakeTarget { stopping: AtomicBool::new(false), input: Some(ServiceInput::for_test(w.clone())) };
        let n = host.events().len();
        for ticket in [TICKET, TICKET2] {
            let gate = |send: &mut dyn FnMut() -> bool| lib.send_if_current(&host, old.generation, ticket, t0, send);
            assert_eq!(hand_over(&target, ticket, written_part(&inbox), &gate), Err(HandOverError::Ended), "{ticket}");
        }
        assert_eq!(w.text(), "", "a line was written for an ended ticket");
        assert!(inbox_is_empty(&d), "a file was left");
        assert_eq!(host.events().len(), n, "{:?}", host.events());
        lib.finish(&host, old.generation, TICKET, Outcome::HandOver(HandOverError::Ended), t0);
        assert_eq!(host.events().len(), n);
        // The new ticket's file is handed over as before: one line, the ticket ended, said once.
        let gate = |send: &mut dyn FnMut() -> bool| lib.send_if_current(&host, new.generation, TICKET2, t0, send);
        hand_over(&target, TICKET2, written_part(&inbox), &gate).unwrap();
        let file = inbox.join(format!("{GRANT}.pdf"));
        assert_eq!(w.text(), file_grant_line(GRANT, TICKET2, &file).unwrap());
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET2), State::HandedOver));
        lib.finish(&host, new.generation, TICKET2, Outcome::HandedOver, t0);
        assert_eq!(host.events().iter().filter(|e| e.state == State::HandedOver).count(), 1);
        host.at(PDF);
        assert!(!lib.take_pdf(&host, "main", t0 + Duration::from_secs(60)));
        assert_eq!(host.last(), LibraryEvent::refused(None, State::Failed, Reason::NoTicket));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_download_the_window_would_start_is_fetched_by_the_shell_under_every_rule() {
        let (lib, host, d) = started("download");
        let t0 = Instant::now();
        let page = "https://www-jstor-org.ezproxy.lib.edu/stable/1";
        // An address that does not look like a PDF's: a download is taken as the PDF all the same.
        let dl = "https://www-jstor-org.ezproxy.lib.edu/stable/get/1?attachment=1";
        // Without a ticket: nothing, and nothing said.
        lib.download_requested(&host, &u(dl), t0);
        assert_eq!(host.jobs(), 0);
        assert!(host.events().is_empty());
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(page), t0);
        // Not https, a sign-in address, not a web address: nothing, and nothing said.
        let n = host.events().len();
        for no in ["http://p.test/a.pdf", "https://ezproxy.lib.edu/x.pdf", "https://p.test/login/file.pdf", "https://p.test/x.pdf?SAMLart=1", "data:application/pdf;base64,JVBERi0=", "blob:https://p.test/1"] {
            lib.download_requested(&host, &u(no), t0);
        }
        assert_eq!(host.jobs(), 0);
        assert_eq!(host.events().len(), n);
        // With an open ticket: ONE fetch of that address, the window's current page as its Referer.
        lib.download_requested(&host, &u(dl), t0);
        assert_eq!(host.jobs(), 1);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Fetching));
        // A second download while it runs: nothing.
        lib.download_requested(&host, &u("https://www-jstor-org.ezproxy.lib.edu/stable/get/2"), t0);
        lib.page_loaded(&host, &u(PDF), t0);
        assert_eq!(host.jobs(), 1);
        let job = host.jobs.lock().unwrap().remove(0);
        assert_eq!(job.ticket, TICKET);
        assert_eq!(job.input.url, u(dl));
        assert_eq!(job.input.previous, Some(u(page)));
        assert_eq!(job.input.user_agent, USER_AGENT);
        assert_eq!(job.input.sign_in_hosts, vec!["ezproxy.lib.edu"]);
        // After the ticket's file was handed over: nothing more for it.
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        lib.download_requested(&host, &u(dl), t0 + Duration::from_secs(30));
        assert_eq!(host.jobs(), 0);
        // The next ticket waits for the pause, which is said.
        lib.open(&host, "main", TICKET2, START, Start::Library);
        lib.download_requested(&host, &u(dl), t0 + Duration::from_secs(10));
        assert_eq!(host.jobs(), 0);
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::Failed, Reason::Pause));
        lib.download_requested(&host, &u(dl), t0 + Duration::from_secs(21));
        assert_eq!(host.jobs(), 1);
        // Nothing starts while the app closes.
        let (lib2, host2, d2) = started("download-stopping");
        lib2.open(&host2, "main", TICKET, START, Start::Library);
        host2.stopping.store(true, Ordering::SeqCst);
        lib2.download_requested(&host2, &u(dl), t0);
        assert_eq!(host2.jobs(), 0);
        for x in [d, d2] {
            fs::remove_dir_all(x).unwrap();
        }
    }

    #[test]
    fn the_commands_from_any_other_window_do_nothing() {
        let (lib, host, d) = started("callers");
        lib.open(&host, "main", TICKET, START, Start::Library);
        host.at(PDF);
        let before = host.events().len();
        let removed = host.removed.load(Ordering::SeqCst);
        for caller in ["library", "", "Main", "main ", "anything"] {
            assert!(!lib.open(&host, caller, TICKET2, START, Start::Library));
            assert!(!lib.take_pdf(&host, caller, Instant::now()));
            lib.close(&host, caller);
            assert!(!lib.sign_out(&host, caller));
            assert!(!lib.set_stay(&host, caller, false));
            assert!(!open_in_browser(caller, "https://p.test/", &|_| panic!("opened")));
        }
        assert_eq!(host.events().len(), before);
        assert_eq!(host.jobs(), 0);
        assert_eq!(host.removed.load(Ordering::SeqCst), removed);
        assert_eq!(host.close_asked.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn nothing_starts_while_the_app_closes() {
        let (lib, host, d) = started("stopping");
        lib.open(&host, "main", TICKET, START, Start::Library);
        host.stopping.store(true, Ordering::SeqCst);
        host.at(PDF);
        lib.page_loaded(&host, &u(PDF), Instant::now());
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::Failed, Reason::Stopping));
        assert_eq!(host.jobs(), 0);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_store_is_emptied_at_start_at_quit_and_on_sign_out_unless_kept() {
        // Linux (no keeping): emptied at every start and quit, and stay cannot be set.
        let d = tmp("store");
        let path = d.join(DEVICE_FILE);
        let host = FakeHost::new(Some(path.clone()), false);
        let lib = Library::default();
        assert!(lib.at_start(&host));
        let first = read_device(&path).unwrap();
        assert!(!first.stay_signed_in);
        assert_eq!(host.removed.load(Ordering::SeqCst), 1);
        assert!(!lib.set_stay(&host, "main", true));
        assert!(lib.set_stay(&host, "main", false));
        assert!(lib.at_quit(&host));
        assert_ne!(read_device(&path).unwrap().store, first.store);
        assert_eq!(host.removed.load(Ordering::SeqCst), 2);
        // A file that says "stay" is not obeyed where the store cannot be kept.
        write_device(&path, &DeviceState { stay_signed_in: true, store: first.store, sign_in_hosts: Vec::new() }).unwrap();
        let lib = Library::default();
        lib.at_start(&host);
        assert_eq!(host.removed.load(Ordering::SeqCst), 3);
        assert!(!read_device(&path).unwrap().stay_signed_in);
        // macOS (keeping allowed): kept across start and quit when chosen, never across a sign-out.
        let mac = FakeHost::new(Some(path.clone()), true);
        let lib = Library::default();
        lib.at_start(&mac);
        assert!(lib.set_stay(&mac, "main", true));
        let kept = read_device(&path).unwrap();
        assert!(kept.stay_signed_in);
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        assert!(lib.at_quit(&mac));
        assert_eq!(read_device(&path).unwrap(), kept);
        let removed = mac.removed.load(Ordering::SeqCst);
        assert!(lib.sign_out(&mac, "main"));
        assert_eq!(mac.removed.load(Ordering::SeqCst), removed + 1);
        let after = read_device(&path).unwrap();
        assert_ne!(after.store, kept.store);
        assert!(after.stay_signed_in, "the choice stays as it was");
        // Unreadable or misshapen: not kept, a new store id.
        fs::write(&path, b"{not json").unwrap();
        let lib = Library::default();
        lib.at_start(&mac);
        let fresh = read_device(&path).unwrap();
        assert!(!fresh.stay_signed_in);
        assert_ne!(fresh.store, after.store);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn open_in_browser_takes_one_https_address() {
        let got = Mutex::new(Vec::<String>::new());
        let opener = |s: &str| {
            got.lock().unwrap().push(s.to_string());
            true
        };
        assert!(open_in_browser("main", "https://doi.org/10.1/x?a=b&c=d", &opener));
        for bad in ["http://doi.org/x", "https://u:p@doi.org/x", "https://u@doi.org/", "javascript:alert(1)", "file:///etc/passwd", "-a Calculator", "https://doi.org/a b", "https://doi.org/x\n--args", ""] {
            assert!(!open_in_browser("main", bad, &opener), "{bad}");
        }
        let long = format!("https://doi.org/{}", "a".repeat(BROWSER_URL_MAX));
        assert!(!open_in_browser("main", &long, &opener));
        assert_eq!(got.lock().unwrap().clone(), vec!["https://doi.org/10.1/x?a=b&c=d".to_string()]);
    }

    #[test]
    fn the_browser_takes_an_address_as_long_as_the_window_does() {
        // R356 f: 4,096 characters, the sign-in window's bound and the longest library address the
        // service builds; one more is refused. Every other rule is `open_in_browser_takes_one_https_address`'s.
        let opened = Mutex::new(0usize);
        let opener = |_: &str| {
            *opened.lock().unwrap() += 1;
            true
        };
        let at = |n: usize| format!("https://doi.org/{}", "a".repeat(n - "https://doi.org/".len()));
        assert_eq!(at(4096).chars().count(), 4096);
        assert!(browser_address(&at(4096)).is_some());
        assert!(browser_address(&at(4097)).is_none());
        assert!(open_in_browser("main", &at(4096), &opener));
        assert!(!open_in_browser("main", &at(4097), &opener));
        assert_eq!(*opened.lock().unwrap(), 1);
        assert_eq!(BROWSER_URL_MAX, WINDOW_URL_MAX);
        assert!(window_address(&at(4096)).is_some() && window_address(&at(4097)).is_none());
    }

    // ----- the kind of start (R347 a) -----

    const LINK: &str = "https://repository.example.org/handle/10/1?show=full";
    const LINK_PDF: &str = "https://repository.example.org/bitstream/10/1/paper.pdf";

    fn jobs_of(host: &FakeHost) -> Vec<Job> {
        std::mem::take(&mut *host.jobs.lock().unwrap())
    }

    #[test]
    fn the_kind_of_start_is_read_from_the_page_exactly() {
        use serde_json::json;
        assert_eq!(Start::from_arg(None), Some(Start::Library));
        assert_eq!(Start::from_arg(Some(&json!("library"))), Some(Start::Library));
        assert_eq!(Start::from_arg(Some(&json!("link"))), Some(Start::Link));
        for bad in [json!("Link"), json!("LIBRARY"), json!(" link"), json!("link "), json!(""), json!("browser"), json!(null), json!(1), json!(true), json!(["link"]), json!({ "from": "link" })] {
            assert_eq!(Start::from_arg(Some(&bad)), None, "{bad}");
        }
    }

    #[test]
    fn an_unknown_kind_of_start_is_refused_and_takes_no_ticket() {
        use serde_json::json;
        let (lib, host, _d) = started("from-unknown");
        for bad in [json!("Link"), json!("links"), json!(2), json!(null), json!(["library"])] {
            assert!(!lib.open_from(&host, "main", TICKET, LINK, Some(&bad)), "{bad}");
        }
        assert!(host.created.lock().unwrap().is_empty());
        assert!(host.events().is_empty());
        // The same ticket then opens: nothing was taken. Absent means "library": the opened host is its sign-in host.
        assert!(lib.open_from(&host, "main", TICKET, LINK, None));
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Opened));
        host.at(LINK_PDF);
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::SignIn));
        assert_eq!(host.titles.lock().unwrap().clone(), vec![format!("repository.example.org — {TITLE_LIBRARY}")]);
    }

    #[test]
    fn a_link_s_window_fetches_a_pdf_on_the_host_it_was_opened_at() {
        let (lib, host, _d) = started("link-own-host");
        let t0 = Instant::now();
        assert!(lib.open_from(&host, "main", TICKET, LINK, Some(&serde_json::json!("link"))));
        lib.page_loaded(&host, &u(LINK), t0);
        lib.page_loaded(&host, &u(LINK_PDF), t0);
        let jobs = jobs_of(&host);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].input.url, u(LINK_PDF));
        assert_eq!(jobs[0].input.sign_in_hosts, Vec::<String>::new(), "no host is a sign-in host for a link's window");
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::Fetching));
        // "Add the PDF showing" on the opened host too.
        lib.finish(&host, jobs[0].generation, TICKET, Outcome::Fetch(FetchError::NotPdf), t0);
        host.at("https://repository.example.org/view/1");
        assert!(lib.take_pdf(&host, "main", t0));
        assert_eq!(jobs_of(&host).len(), 1);
    }

    #[test]
    fn a_library_s_window_never_fetches_from_the_host_it_was_opened_at() {
        let (lib, host, _d) = started("library-own-host");
        assert!(lib.open_from(&host, "main", TICKET, LINK, Some(&serde_json::json!("library"))));
        lib.page_loaded(&host, &u(LINK_PDF), Instant::now());
        assert_eq!(host.jobs(), 0);
        host.at(LINK_PDF);
        assert!(!lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::SignIn));
        assert_eq!(host.jobs(), 0);
        // Another host is fetched from, as before.
        host.at("https://www.publisher.example/pdf/1.pdf");
        assert!(lib.take_pdf(&host, "main", Instant::now()));
        assert_eq!(jobs_of(&host)[0].input.sign_in_hosts, vec!["repository.example.org"]);
    }

    #[test]
    fn a_link_s_window_never_fetches_a_sign_in_path_on_any_host() {
        let (lib, host, _d) = started("link-paths");
        assert!(lib.open(&host, "main", TICKET, LINK, Start::Link));
        for p in [
            "https://repository.example.org/login?next=/bitstream/1.pdf",
            "https://any.example/login?url=x.pdf",
            "https://any.example/Shibboleth.sso/x.pdf",
            "https://any.example/x.pdf?SAMLart=1",
            "https://any.example/x.pdf?ticket=ST-1",
            "https://any.example/cb.pdf?code=1&state=2",
        ] {
            lib.page_loaded(&host, &u(p), Instant::now());
            host.at(p);
            assert!(!lib.take_pdf(&host, "main", Instant::now()), "{p}");
            assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::SignIn), "{p}");
        }
        assert_eq!(host.jobs(), 0);
    }

    #[test]
    fn the_kind_belongs_to_the_ticket_and_ends_with_the_window() {
        let (lib, host, _d) = started("kind-ticket");
        let t0 = Instant::now();
        // A link's ticket; a retry of the same press while it is open changes nothing (the open is refused).
        assert!(lib.open(&host, "main", TICKET, LINK, Start::Link));
        assert!(!lib.open(&host, "main", TICKET, LINK, Start::Library));
        assert!(!lib.open(&host, "main", TICKET2, LINK, Start::Library));
        lib.page_loaded(&host, &u(LINK_PDF), t0);
        let job = jobs_of(&host).remove(0);
        assert_eq!(job.input.sign_in_hosts, Vec::<String>::new());
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        // The window stays without a ticket; a library's start re-uses it under the library's rule.
        assert!(lib.open(&host, "main", TICKET2, LINK, Start::Library));
        let later = t0 + Duration::from_secs(30);
        lib.page_loaded(&host, &u(LINK_PDF), later);
        assert_eq!(host.jobs(), 0);
        host.at(LINK_PDF);
        assert!(!lib.take_pdf(&host, "main", later));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
        // The window closes: its ticket ends, and with its own (ephemeral) store the library's sign-in hosts.
        // A link's start then has no sign-in host again.
        lib.window_closed(&host);
        host.exists.store(false, Ordering::SeqCst);
        let t3 = "0123456789abcdef0123456789abcde3";
        assert!(lib.open(&host, "main", t3, LINK, Start::Link));
        lib.page_loaded(&host, &u(LINK_PDF), later);
        assert_eq!(jobs_of(&host)[0].input.sign_in_hosts, Vec::<String>::new());
        // And the reverse: a library's window, then a link's start at the library's host.
        lib.window_closed(&host);
        let t4 = "0123456789abcdef0123456789abcde4";
        assert!(lib.open(&host, "main", t4, START, Start::Library));
        lib.window_closed(&host);
        let t5 = "0123456789abcdef0123456789abcde5";
        assert!(lib.open(&host, "main", t5, START, Start::Link));
        host.at("https://ezproxy.lib.edu/files/1.pdf");
        assert!(lib.take_pdf(&host, "main", later));
    }

    #[test]
    fn a_sign_in_hop_of_the_shell_s_own_fetch_says_why() {
        let (lib, host, _d) = started("hop-reason");
        let t0 = Instant::now();
        lib.open(&host, "main", TICKET, START, Start::Library);
        lib.page_loaded(&host, &u(PDF), t0);
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::Fetch(FetchError::SignIn), t0);
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET), State::NotAPdf, Reason::SignIn));
        assert_eq!(host.last().to_json(), serde_json::json!({ "ticket": TICKET, "state": "not-a-pdf", "reason": "sign-in-address" }));
        // A page that is not a PDF still says no reason.
        host.at(PDF);
        assert!(lib.take_pdf(&host, "main", t0));
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::Fetch(FetchError::NotPdf), t0);
        assert_eq!(host.last(), LibraryEvent::new(Some(TICKET), State::NotAPdf));
    }

    // ----- the library's sign-in hosts live as long as the window's store (R360 a) -----

    const OWN_PDF: &str = "https://ezproxy.lib.edu/files/own.pdf";
    const T3: &str = "0123456789abcdef0123456789abcde3";
    const T4: &str = "0123456789abcdef0123456789abcde4";
    const T5: &str = "0123456789abcdef0123456789abcde5";

    /// A library's ticket ended by its hand-over at `t0`, the window kept.
    fn library_handed_over(lib: &Library, host: &FakeHost, ticket: &str, at: &str, t0: Instant) {
        assert!(lib.open(host, "main", ticket, at, Start::Library));
        lib.page_loaded(host, &u(PDF), t0);
        let job = jobs_of(host).remove(0);
        lib.finish(host, job.generation, ticket, Outcome::HandedOver, t0);
    }

    #[test]
    fn a_library_s_sign_in_host_stays_one_for_a_later_link_s_ticket() {
        // The reviewer's sequence (I1): a library's ticket, its hand-over, a link's start re-using the window.
        let (lib, host, _d) = started("i1");
        let t0 = Instant::now();
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        lib.page_loaded(&host, &u(OWN_PDF), t0);
        assert_eq!(host.jobs(), 0, "the library's sign-in host, under the library's ticket");
        lib.page_loaded(&host, &u(PDF), t0);
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        let later = t0 + Duration::from_secs(60);
        assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
        assert_eq!(host.created.lock().unwrap().len(), 1, "the window is re-used");
        // A PDF-looking page on the library's sign-in host under the link's ticket: no job, nothing said.
        let n = host.events().len();
        lib.page_loaded(&host, &u(OWN_PDF), later);
        lib.download_requested(&host, &u(OWN_PDF), later);
        assert_eq!(host.jobs(), 0);
        assert_eq!(host.events().len(), n);
        // "Add the PDF showing in the sign-in window" there: refused, the reason said.
        host.at(OWN_PDF);
        assert!(!lib.take_pdf(&host, "main", later));
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
        assert_eq!(host.jobs(), 0);
        // The link's own opened-at host and another host: fetched as before, the library's host still kept back on every hop.
        lib.page_loaded(&host, &u(LINK_PDF), later);
        let job = jobs_of(&host).remove(0);
        assert_eq!(job.input.url, u(LINK_PDF));
        assert_eq!(job.input.sign_in_hosts, vec!["ezproxy.lib.edu"]);
        assert_eq!(check_hop(&u(OWN_PDF), &job.input.sign_in_hosts), Err(FetchError::SignIn));
        assert_eq!(check_hop(&u("https://EZPROXY.lib.edu./x.pdf"), &job.input.sign_in_hosts), Err(FetchError::SignIn));
        assert_eq!(check_hop(&u(LINK_PDF), &job.input.sign_in_hosts), Ok(()));
        lib.finish(&host, job.generation, TICKET2, Outcome::Fetch(FetchError::NotPdf), later);
        host.at("https://www.publisher.example/pdf/1.pdf");
        assert!(lib.take_pdf(&host, "main", later));
        let job = jobs_of(&host).remove(0);
        // A hop of the shell's own request that reaches the library's host: not requested, the reason said.
        lib.finish(&host, job.generation, TICKET2, Outcome::Fetch(FetchError::SignIn), later);
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
    }

    #[test]
    fn every_host_a_library_s_start_opened_the_window_at_is_a_sign_in_host() {
        let (lib, host, _d) = started("two-libraries");
        let t0 = Instant::now();
        library_handed_over(&lib, &host, TICKET, START, t0);
        let other = "https://login.other-library.ac.uk/login?url=https://doi.org/10.1/x";
        let later = t0 + Duration::from_secs(30);
        library_handed_over(&lib, &host, TICKET2, other, later);
        // A link's start adds none of its own.
        let last = later + Duration::from_secs(30);
        assert!(lib.open(&host, "main", T3, LINK, Start::Link));
        lib.page_loaded(&host, &u(LINK_PDF), last);
        let job = jobs_of(&host).remove(0);
        assert_eq!(job.input.sign_in_hosts, vec!["ezproxy.lib.edu", "login.other-library.ac.uk"]);
        for at in [OWN_PDF, "https://login.other-library.ac.uk/files/1.pdf"] {
            host.at(at);
            lib.finish(&host, job.generation, T3, Outcome::Fetch(FetchError::NotPdf), last);
            assert!(!lib.take_pdf(&host, "main", last), "{at}");
            assert_eq!(host.last(), LibraryEvent::refused(Some(T3), State::NotAPdf, Reason::SignIn), "{at}");
        }
        // A refused open (a ticket is open) adds nothing either.
        assert!(!lib.open(&host, "main", T4, "https://third-library.example/login", Start::Library));
        host.at("https://third-library.example/files/1.pdf");
        assert!(lib.take_pdf(&host, "main", last));
        assert_eq!(jobs_of(&host)[0].input.sign_in_hosts.len(), 2);
    }

    #[test]
    fn the_sign_in_hosts_are_forgotten_when_the_store_is_emptied() {
        // Every platform: the sign-out empties the store, and the hosts go with it.
        for can_stay in [false, true] {
            let d = tmp(&format!("forget-{can_stay}"));
            let host = FakeHost::new(Some(d.join(DEVICE_FILE)), can_stay);
            let lib = Library::default();
            assert!(lib.at_start(&host));
            let t0 = Instant::now();
            library_handed_over(&lib, &host, TICKET, START, t0);
            assert!(lib.sign_out(&host, "main"));
            assert_eq!(read_device(&d.join(DEVICE_FILE)).unwrap().sign_in_hosts, Vec::<String>::new());
            host.exists.store(false, Ordering::SeqCst);
            assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
            host.at(OWN_PDF);
            assert!(lib.take_pdf(&host, "main", t0 + Duration::from_secs(30)), "can_stay {can_stay}");
            assert_eq!(jobs_of(&host)[0].input.sign_in_hosts, Vec::<String>::new());
            // The quit that empties the store, and the start-up clean-up after a forced quit, likewise.
            lib.window_closed(&host);
            library_handed_over(&lib, &host, T3, START, t0 + Duration::from_secs(60));
            assert!(lib.at_quit(&host));
            let lib = Library::default();
            assert!(lib.at_start(&host));
            assert!(lib.open(&host, "main", T4, LINK, Start::Link));
            host.at(OWN_PDF);
            assert!(lib.take_pdf(&host, "main", t0 + Duration::from_secs(90)));
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn a_sign_out_whose_window_does_not_close_keeps_the_sign_in_hosts_and_does_not_complete() {
        // R361 (the review's N1 probe), on both platform forms: the window is still there after the
        // wait, so its session lives on; the store is not renewed and the hosts are kept.
        for can_stay in [false, true] {
            let d = tmp(&format!("stuck-{can_stay}"));
            let path = d.join(DEVICE_FILE);
            let host = FakeHost::new(Some(path.clone()), can_stay);
            let lib = Library::default();
            assert!(lib.at_start(&host));
            if can_stay {
                assert!(lib.set_stay(&host, "main", true));
            }
            let t0 = Instant::now();
            library_handed_over(&lib, &host, TICKET, START, t0);
            let before = lib.lock().device.clone().unwrap();
            assert_eq!(before.sign_in_hosts, vec!["ezproxy.lib.edu"]);
            let on_disk = read_device(&path).unwrap();
            let removed = host.removed.load(Ordering::SeqCst);
            host.close_refused.store(true, Ordering::SeqCst);
            assert!(!lib.sign_out(&host, "main"), "the sign-out did not complete (can_stay {can_stay})");
            assert!(host.window_exists());
            assert_eq!(lib.lock().device.clone().unwrap(), before, "the hosts, the store and the choice unchanged");
            assert_eq!(read_device(&path).unwrap(), on_disk, "nothing written");
            assert_eq!(host.removed.load(Ordering::SeqCst), removed, "no store removed");
            // A link's start re-using that window: nothing is fetched from the library's host.
            let later = t0 + Duration::from_secs(30);
            assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
            assert_eq!(host.created.lock().unwrap().len(), 1, "the window is re-used");
            lib.page_loaded(&host, &u(OWN_PDF), later);
            assert_eq!(host.jobs(), 0, "can_stay {can_stay}");
            host.at(OWN_PDF);
            assert!(!lib.take_pdf(&host, "main", later));
            assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
            assert_eq!(host.jobs(), 0);
            // Once the window closes, a later sign-out completes as before.
            host.close_refused.store(false, Ordering::SeqCst);
            assert!(lib.sign_out(&host, "main"));
            assert!(!host.window_exists());
            let after = lib.lock().device.clone().unwrap();
            assert_eq!(after.sign_in_hosts, Vec::<String>::new());
            assert_ne!(after.store, before.store);
            assert_eq!(after.stay_signed_in, can_stay, "the choice stays as it was");
            assert_eq!(read_device(&path).unwrap(), after);
            assert_eq!(host.removed.load(Ordering::SeqCst), removed + 1);
            fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn where_the_store_is_the_window_s_own_the_sign_in_hosts_end_with_the_window() {
        // Linux and Windows: the window's store is ephemeral (`window_store`), gone with the window, and so are the hosts.
        let (lib, host, _d) = started("window-own-store");
        let t0 = Instant::now();
        library_handed_over(&lib, &host, TICKET, START, t0);
        lib.window_closed(&host);
        host.exists.store(false, Ordering::SeqCst);
        assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
        host.at(OWN_PDF);
        assert!(lib.take_pdf(&host, "main", t0 + Duration::from_secs(30)));
        assert_eq!(jobs_of(&host)[0].input.sign_in_hosts, Vec::<String>::new());
    }

    #[test]
    fn where_the_store_outlives_the_window_so_do_the_sign_in_hosts() {
        // macOS: the store by identifier outlives the window within a run; the hosts are kept with it.
        let d = tmp("mac-store");
        let path = d.join(DEVICE_FILE);
        let mac = FakeHost::new(Some(path.clone()), true);
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        let t0 = Instant::now();
        library_handed_over(&lib, &mac, TICKET, START, t0);
        lib.window_closed(&mac);
        mac.exists.store(false, Ordering::SeqCst);
        assert!(lib.open(&mac, "main", TICKET2, LINK, Start::Link));
        mac.at(OWN_PDF);
        assert!(!lib.take_pdf(&mac, "main", t0 + Duration::from_secs(30)));
        assert_eq!(mac.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
        // Without "Stay signed in" nothing of it is written down: the quit empties the store.
        assert_eq!(read_device(&path).unwrap().sign_in_hosts, Vec::<String>::new());
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn with_stay_signed_in_the_sign_in_hosts_are_kept_across_a_quit_in_the_device_file() {
        let d = tmp("stay-hosts");
        let path = d.join(DEVICE_FILE);
        let mac = FakeHost::new(Some(path.clone()), true);
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        let t0 = Instant::now();
        // Chosen after a library's start: the hosts are written with the choice.
        library_handed_over(&lib, &mac, TICKET, START, t0);
        assert!(lib.set_stay(&mac, "main", true));
        assert_eq!(read_device(&path).unwrap().sign_in_hosts, vec!["ezproxy.lib.edu"]);
        // A later library's start writes its host BEFORE the window goes there (a forced quit then loses nothing).
        let other = "https://login.other-library.ac.uk/login?url=x";
        assert!(lib.open(&mac, "main", TICKET2, other, Start::Library));
        assert_eq!(read_device(&path).unwrap().sign_in_hosts, vec!["ezproxy.lib.edu", "login.other-library.ac.uk"]);
        lib.window_closed(&mac);
        // The quit keeps the store and the hosts; the next start reads them back.
        assert!(lib.at_quit(&mac));
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        mac.exists.store(false, Ordering::SeqCst);
        assert!(lib.open(&mac, "main", T3, LINK, Start::Link));
        for at in [OWN_PDF, "https://login.other-library.ac.uk/files/1.pdf"] {
            mac.at(at);
            assert!(!lib.take_pdf(&mac, "main", t0 + Duration::from_secs(60)), "{at}");
            assert_eq!(mac.last(), LibraryEvent::refused(Some(T3), State::NotAPdf, Reason::SignIn), "{at}");
        }
        // A forced quit (no `at_quit`) keeps them too: the next start reads the file.
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        assert_eq!(lib.lock().device.as_ref().unwrap().sign_in_hosts.len(), 2);
        // The sign-out forgets them, on disk too, the choice kept.
        assert!(lib.sign_out(&mac, "main"));
        let after = read_device(&path).unwrap();
        assert!(after.stay_signed_in);
        assert_eq!(after.sign_in_hosts, Vec::<String>::new());
        // A host that cannot be written down where it must be: the library's start is refused, nothing taken.
        let lib = Library::default();
        assert!(lib.at_start(&mac));
        mac.exists.store(false, Ordering::SeqCst);
        let mut opened = 0;
        let mut refused = None;
        for i in 0..200 {
            let at = format!("https://login-{i}.{}.example/login", "a".repeat(60));
            let t = format!("{:032x}", 1000 + i);
            if !lib.open(&mac, "main", &t, &at, Start::Library) {
                refused = Some(at);
                break;
            }
            opened += 1;
            lib.window_closed(&mac);
        }
        let refused = refused.expect("a start refused once the file is full");
        assert!(opened > 10, "{opened}");
        assert!(fs::metadata(&path).unwrap().len() as usize <= DEVICE_MAX_BYTES);
        assert_eq!(read_device(&path).unwrap().sign_in_hosts.len(), opened);
        assert!(lib.lock().ticket.is_none());
        assert!(!lib.lock().device.as_ref().unwrap().sign_in_hosts.contains(&Url::parse(&refused).unwrap().host_str().unwrap().to_string()));
        // A link's start is not refused: it adds nothing.
        assert!(lib.open(&mac, "main", T5, LINK, Start::Link));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_device_file_keeps_the_sign_in_hosts_strictly() {
        let s = DeviceState { stay_signed_in: true, store: [1; 16], sign_in_hosts: vec!["ezproxy.lib.edu".into(), "xn--bcher-kva.example".into()] };
        assert_eq!(device_text(&s), "{\"staySignedIn\":true,\"store\":\"01010101010101010101010101010101\",\"signInHosts\":[\"ezproxy.lib.edu\",\"xn--bcher-kva.example\"]}\n");
        assert_eq!(parse_device(&device_text(&s)), Some(s));
        let store = "\"store\":\"00112233445566778899aabbccddeeff\"";
        for bad in [
            format!("{{\"staySignedIn\":true,{store}}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":\"ezproxy.lib.edu\"}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[\"\"]}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[\"EZproxy.lib.edu\"]}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[\"a b\"]}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[1]}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[null]}}"),
            format!("{{\"staySignedIn\":true,{store},\"signInHosts\":[],\"x\":1}}"),
        ] {
            assert_eq!(parse_device(&bad), None, "{bad}");
        }
    }

    // ----- the title (R347 b) -----

    #[test]
    fn the_title_names_the_host_shown_and_the_kind() {
        let lib_words = "sign in to your library, then open the PDF and the app will fetch it for you to check";
        let link_words = "open the PDF on this page and the app will fetch it for you to check";
        assert_eq!(window_title(&u("https://ezproxy.lib.edu/login?url=https://doi.org/10.1/x"), Start::Library), format!("ezproxy.lib.edu — {lib_words}"));
        assert_eq!(window_title(&u("https://repository.example.org/handle/1"), Start::Link), format!("repository.example.org — {link_words}"));
        for (url, host) in [
            ("https://EZProxy.Lib.EDU/x", "ezproxy.lib.edu"),
            ("https://reader:secret@h.test/x", "h.test"),
            ("https://h.test:443/x", "h.test"),
            ("https://h.test:8443/x", "h.test:8443"),
            ("http://h.test/x", "h.test:80"),
            ("https://bücher.example/x", "xn--bcher-kva.example"),
            ("https://93.184.216.34/x", "93.184.216.34"),
            ("https://[2606:4700::1111]:8443/x", "[2606:4700::1111]:8443"),
            ("blob:https://p.test/1-2", "p.test"),
            ("about:blank", "no web address"),
            ("https://h.test./x", "h.test."),
        ] {
            assert_eq!(title_host(&u(url)), host, "{url}");
        }
        // A right-to-left name: its xn-- form, ASCII only.
        let rtl = title_host(&u("https://مثال.إختبار/"));
        assert!(rtl.starts_with("xn--") && rtl.contains(".xn--") && rtl.is_ascii(), "{rtl}");
        // A very long host keeps its end (the name it is registered under) in sight, bounded.
        let long = format!("https://www.library.example.edu.{}.evil.example/", "a".repeat(60));
        let shown = title_host(&u(&long));
        assert_eq!(shown.chars().count(), TITLE_HOST_MAX);
        assert!(shown.starts_with('…') && shown.ends_with(".evil.example"), "{shown}");
        let huge = format!("https://{}x.test/", "a".repeat(5000));
        if let Ok(parsed) = Url::parse(&huge) {
            assert!(title_host(&parsed).chars().count() <= TITLE_HOST_MAX);
        }
        // Nothing but printable ASCII from the address (no line end, control or bidirectional character).
        for url in ["https://xn--ls8h.la/", "https://a\u{202e}b.test/", "https://a%2eb.test/", "https://A-B_c.test/", "https://a\u{200b}b.test/"] {
            if let Ok(parsed) = Url::parse(url) {
                let h = title_host(&parsed);
                assert!(h.chars().all(|c| c.is_ascii_graphic()), "{url}: {h:?}");
                assert!(!window_title(&parsed, Start::Link).chars().any(|c| c.is_control()));
            }
        }
    }

    #[test]
    fn the_title_follows_the_top_page_and_the_page_cannot_set_it() {
        let (lib, host, _d) = started("title");
        let titles = || host.titles.lock().unwrap().clone();
        assert!(lib.open(&host, "main", TICKET, START, Start::Library));
        // Before the first page has loaded: the host of the address asked for.
        assert_eq!(titles(), vec![format!("ezproxy.lib.edu — {TITLE_LIBRARY}")]);
        // A navigation (a server's redirect included) to another host: that host.
        lib.page_shown(&host, &u(PDF));
        assert_eq!(titles().last().unwrap(), &format!("www-jstor-org.ezproxy.lib.edu — {TITLE_LIBRARY}"));
        // The page changing its own title: the shell's is set again, unchanged.
        let n = titles().len();
        lib.page_retitled(&host);
        assert_eq!(titles().len(), n + 1);
        assert_eq!(titles().last().unwrap(), &format!("www-jstor-org.ezproxy.lib.edu — {TITLE_LIBRARY}"));
        lib.page_loaded(&host, &u(PDF), Instant::now());
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, Instant::now());
        // The window re-used for a link's start (R360 b): the link's words at once, but the host stays that of the
        // page still shown until the new address commits (the asked host is not shown before it is).
        assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
        assert_eq!(titles().last().unwrap(), &format!("www-jstor-org.ezproxy.lib.edu — {TITLE_LINK}"));
        assert!(!titles().iter().any(|t| t.starts_with("repository.example.org")));
        lib.page_retitled(&host);
        assert_eq!(titles().last().unwrap(), &format!("www-jstor-org.ezproxy.lib.edu — {TITLE_LINK}"));
        lib.page_shown(&host, &u(LINK));
        assert_eq!(titles().last().unwrap(), &format!("repository.example.org — {TITLE_LINK}"));
        lib.page_shown(&host, &u("https://cdn.example.net/x"));
        assert_eq!(titles().last().unwrap(), &format!("cdn.example.net — {TITLE_LINK}"));
        // A window built anew (nothing shown yet): the asked host.
        lib.window_closed(&host);
        host.exists.store(false, Ordering::SeqCst);
        assert!(lib.open(&host, "main", "0123456789abcdef0123456789abcde3", START, Start::Library));
        assert_eq!(titles().last().unwrap(), &format!("ezproxy.lib.edu — {TITLE_LIBRARY}"));
    }

    #[test]
    fn a_re_use_whose_navigation_fails_puts_the_kind_the_sign_in_hosts_and_the_title_back() {
        let (lib, host, _d) = started("title-failed");
        let titles = || host.titles.lock().unwrap().clone();
        let t0 = Instant::now();
        // A link's ticket, its page shown, its file handed over: the window stays, showing the repository's page.
        assert!(lib.open(&host, "main", TICKET, LINK, Start::Link));
        lib.page_shown(&host, &u(LINK));
        lib.page_loaded(&host, &u(LINK_PDF), t0);
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        let shown = format!("repository.example.org — {TITLE_LINK}");
        assert_eq!(titles().last().unwrap(), &shown);
        // A library's start re-using the window, whose navigation fails: refused, the ticket cleared, nothing of it kept.
        host.navigate_ok.store(false, Ordering::SeqCst);
        let n = titles().len();
        let events = host.events().len();
        assert!(!lib.open(&host, "main", TICKET2, "https://login.other-library.ac.uk/login?url=x", Start::Library));
        assert_eq!(titles().len(), n, "the title is not touched");
        assert_eq!(host.events().len(), events);
        // Later title updates of the page still shown use the link's words, as before that open.
        lib.page_retitled(&host);
        assert_eq!(titles().last().unwrap(), &shown);
        lib.page_shown(&host, &u("https://repository.example.org/handle/10/2"));
        assert_eq!(titles().last().unwrap(), &shown);
        // The failed start's host is not a sign-in host; the ticket is free again.
        host.navigate_ok.store(true, Ordering::SeqCst);
        let later = t0 + Duration::from_secs(30);
        assert!(lib.open(&host, "main", TICKET2, LINK, Start::Link));
        host.at("https://login.other-library.ac.uk/files/1.pdf");
        assert!(lib.take_pdf(&host, "main", later));
        assert_eq!(jobs_of(&host)[0].input.sign_in_hosts, Vec::<String>::new());
    }

    // ----- the fetch, against a local https test server -----

    /// The test server's certificate and key, kept in memory: the folder they are made in is removed
    /// at once, and each server writes them into its own folder, removed when it stops (R331 h).
    struct TestCert {
        key: Vec<u8>,
        pem: Vec<u8>,
    }

    fn test_cert() -> &'static TestCert {
        static CERT: OnceLock<TestCert> = OnceLock::new();
        CERT.get_or_init(|| {
            let d = tmp("cert");
            let (key, cert) = (d.join("key.pem"), d.join("cert.pem"));
            let out = std::process::Command::new("openssl")
                .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=a.test", "-addext", "subjectAltName=DNS:a.test,DNS:b.test,DNS:c.test,DNS:localhost"])
                .arg("-keyout")
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .output()
                .expect("openssl");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            TestCert { key: fs::read(&key).unwrap(), pem: fs::read(&cert).unwrap() }
        })
    }

    const SERVER: &str = r#"
import https from "node:https";
import { appendFileSync, readFileSync } from "node:fs";
const [key, cert, log] = process.argv.slice(1);
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3000, 97)]);
const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const u = new URL(req.url, "https://" + req.headers.host);
  appendFileSync(log, JSON.stringify({ host: req.headers.host.split(":")[0], path: u.pathname, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null, accept: req.headers.accept ?? null, ua: req.headers["user-agent"] ?? null }) + "\n");
  const p = u.pathname;
  if (p === "/paper.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(pdf); }
  else if (p === "/small.pdf") { res.writeHead(200); res.end("%PDF-1.4 tiny"); }
  else if (p === "/redirect") { res.writeHead(302, { location: u.searchParams.get("to") }); res.end(); }
  else if (p.startsWith("/chain/")) { const n = Number(p.slice(7)); res.writeHead(n % 2 ? 302 : 307, { location: n > 1 ? "/chain/" + (n - 1) : "/paper.pdf" }); res.end(); }
  else if (p === "/page.html") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("<html>" + "x".repeat(3000)); }
  else if (p === "/late-mark") { res.writeHead(200); res.end(Buffer.concat([Buffer.alloc(1100, 32), Buffer.from("%PDF-1.7")])); }
  else if (p === "/big") { res.writeHead(200, { "content-length": "1000000" }); res.write(pdf); }
  else if (p === "/endless") { res.writeHead(200); res.write(pdf); res.end(Buffer.alloc(300000, 98)); }
  else if (p === "/stall") { res.writeHead(200); res.write(pdf); }
  else if (p === "/liar") { res.writeHead(200, { "content-length": "5000" }); res.write(pdf.subarray(0, 100)); setTimeout(() => req.socket.destroy(), 100); }
  else if (p === "/missing") { res.writeHead(404); res.end("no"); }
  else { res.writeHead(500); res.end(); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
"#;

    struct Server {
        child: std::process::Child,
        port: u16,
        log: PathBuf,
        dir: TmpDir,
    }

    impl Server {
        fn start(name: &str) -> Server {
            use std::io::BufRead;
            let c = test_cert();
            let dir = tmp(&format!("server-{name}"));
            let log = dir.join("log");
            fs::write(&log, b"").unwrap();
            let (key, cert) = (dir.join("key.pem"), dir.join("cert.pem"));
            fs::write(&key, &c.key).unwrap();
            fs::write(&cert, &c.pem).unwrap();
            let mut child = std::process::Command::new("node")
                .args(["--input-type=module", "-e", SERVER])
                .arg(&key)
                .arg(&cert)
                .arg(&log)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("node on PATH");
            let mut line = String::new();
            io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
            let port = line.trim().strip_prefix("PORT ").unwrap().parse().unwrap();
            Server { child, port, log, dir }
        }

        fn url(&self, host: &str, path: &str) -> Url {
            u(&format!("https://{host}:{}{path}", self.port))
        }

        fn requests(&self) -> Vec<serde_json::Value> {
            fs::read_to_string(&self.log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
        }

        fn paths(&self) -> Vec<String> {
            self.requests().iter().map(|r| format!("{}{}", r["host"].as_str().unwrap(), r["path"].as_str().unwrap())).collect()
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&*self.dir);
        }
    }

    struct MapResolver(HashMap<&'static str, IpAddr>);

    impl HostResolver for MapResolver {
        fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
            self.0.get(host).map(|ip| vec![SocketAddr::new(*ip, port)]).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
    }

    fn resolver() -> Arc<dyn HostResolver> {
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        Arc::new(MapResolver(HashMap::from([("a.test", lo), ("b.test", lo), ("c.test", "10.0.0.1".parse().unwrap())])))
    }

    /// A host that answers several addresses.
    struct ListResolver(HashMap<&'static str, Vec<IpAddr>>);

    impl HostResolver for ListResolver {
        fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
            self.0.get(host).map(|ips| ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect()).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
        }
    }

    #[test]
    fn a_host_answering_an_allowed_and_a_refused_address_is_refused_in_either_order() {
        let s = Server::start("multi");
        let (lo, private): (IpAddr, IpAddr) = ("127.0.0.1".parse().unwrap(), "10.0.0.1".parse().unwrap());
        let two: Arc<dyn HostResolver> = Arc::new(ListResolver(HashMap::from([("a.test", vec![lo, private]), ("b.test", vec![private, lo])])));
        for host in ["a.test", "b.test"] {
            let read: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(jar);
            let got = tauri::async_runtime::block_on(fetch_pdf(input(s.url(host, "/paper.pdf"), None), read, &rules(), two.clone(), &mut Vec::new()));
            assert_eq!(got, Err(FetchError::Refused), "{host}");
        }
        assert!(s.paths().is_empty(), "{:?}", s.paths());
    }

    fn rules() -> FetchRules {
        let mut r = FetchRules::for_shell(true);
        r.roots = vec![reqwest::Certificate::from_pem(&test_cert().pem).unwrap()];
        r
    }

    fn jar() -> Vec<Cookie<'static>> {
        vec![ck("a", "1", "a.test", "/", true), ck("b", "2", "b.test", "/", true), ck("other", "3", "evil.test", "/", false)]
    }

    fn input(url: Url, previous: Option<Url>) -> FetchInput {
        FetchInput { url, previous, user_agent: USER_AGENT.into(), sign_in_hosts: vec!["lib.test".into()] }
    }

    fn fetch(input: FetchInput, rules: &FetchRules, sink: &mut dyn PdfSink) -> Result<u64, FetchError> {
        let read: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(jar);
        tauri::async_runtime::block_on(fetch_pdf(input, read, rules, resolver(), sink))
    }

    #[test]
    fn a_pdf_is_fetched_with_its_hosts_cookies_the_window_s_user_agent_and_a_bare_referer() {
        let s = Server::start("plain");
        let mut sink = Vec::new();
        let prev = s.url("a.test", "/article/1?session=SECRETTICKET#x");
        let n = fetch(input(s.url("a.test", "/paper.pdf"), Some(prev)), &rules(), &mut sink).unwrap();
        assert_eq!(n, 3009);
        assert!(sink.starts_with(b"%PDF-1.7"));
        let r = &s.requests()[0];
        assert_eq!(r["cookie"], "a=1");
        assert_eq!(r["accept"], "application/pdf");
        assert_eq!(r["ua"], USER_AGENT);
        assert_eq!(r["referer"], format!("https://a.test:{}/article/1", s.port));
        // A small PDF (under 1,024 bytes) is a PDF too.
        let mut small = Vec::new();
        fetch(input(s.url("a.test", "/small.pdf"), None), &rules(), &mut small).unwrap();
        assert_eq!(small, b"%PDF-1.4 tiny");
        assert!(s.requests()[1]["referer"].is_null());
    }

    #[test]
    fn a_redirect_across_hosts_carries_only_the_new_hosts_cookies() {
        let s = Server::start("cross");
        let to = s.url("b.test", "/paper.pdf");
        let start = s.url("a.test", &format!("/redirect?to={}", to.as_str()));
        let mut sink = Vec::new();
        fetch(input(start, Some(s.url("a.test", "/article"))), &rules(), &mut sink).unwrap();
        let r = s.requests();
        assert_eq!(r.len(), 2);
        assert_eq!((r[0]["host"].as_str(), r[0]["cookie"].as_str()), (Some("a.test"), Some("a=1")));
        assert_eq!((r[1]["host"].as_str(), r[1]["cookie"].as_str()), (Some("b.test"), Some("b=2")));
        // Another origin hears the previous page's origin only.
        assert_eq!(r[1]["referer"], format!("https://a.test:{}/", s.port));
    }

    #[test]
    fn a_redirect_to_http_is_not_followed() {
        let s = Server::start("http");
        let start = s.url("a.test", &format!("/redirect?to=http://a.test:{}/paper.pdf", s.port));
        assert_eq!(fetch(input(start, None), &rules(), &mut Vec::new()), Err(FetchError::NotHttps));
        assert_eq!(s.paths(), vec!["a.test/redirect"]);
    }

    #[test]
    fn five_redirects_are_followed_and_six_are_not() {
        let s = Server::start("chain");
        let mut sink = Vec::new();
        fetch(input(s.url("a.test", "/chain/5"), None), &rules(), &mut sink).unwrap();
        assert_eq!(s.paths().len(), 6);
        assert_eq!(fetch(input(s.url("a.test", "/chain/6"), None), &rules(), &mut Vec::new()), Err(FetchError::TooManyRedirects));
        assert_eq!(s.paths().len(), 12);
        assert!(!s.paths()[6..].contains(&"a.test/paper.pdf".to_string()));
    }

    #[test]
    fn a_redirect_to_a_private_address_is_refused_before_any_connection() {
        let s = Server::start("private");
        let start = s.url("a.test", &format!("/redirect?to=https://c.test:{}/paper.pdf", s.port));
        let t = Instant::now();
        assert_eq!(fetch(input(start, None), &rules(), &mut Vec::new()), Err(FetchError::Refused));
        assert!(t.elapsed() < Duration::from_secs(5));
        assert_eq!(s.paths(), vec!["a.test/redirect"]);
        // An address literal is checked the same way.
        let lit = s.url("a.test", &format!("/redirect?to=https://192.168.1.1:{}/paper.pdf", s.port));
        assert_eq!(fetch(input(lit, None), &rules(), &mut Vec::new()), Err(FetchError::Refused));
        // A host the resolver does not know.
        let unknown = s.url("a.test", &format!("/redirect?to=https://unknown.test:{}/paper.pdf", s.port));
        assert_eq!(fetch(input(unknown, None), &rules(), &mut Vec::new()), Err(FetchError::Unresolved));
    }

    #[test]
    fn a_loopback_address_is_refused_outside_test_mode() {
        let s = Server::start("loopback");
        let mut r = rules();
        r.allow_loopback = false;
        assert_eq!(fetch(input(s.url("a.test", "/paper.pdf"), None), &r, &mut Vec::new()), Err(FetchError::Refused));
        assert!(s.paths().is_empty());
        // `FetchRules::for_shell` allows it only in test mode.
        assert!(!FetchRules::for_shell(false).allow_loopback);
    }

    #[test]
    fn a_sign_in_address_is_never_requested_even_by_redirect() {
        let s = Server::start("saml");
        let saml = s.url("b.test", "/idp/profile/SAML2/Redirect/SSO?SAMLRequest=abc");
        let start = s.url("a.test", &format!("/redirect?to={}", urlencode(saml.as_str())));
        let err = fetch(input(start, None), &rules(), &mut Vec::new()).unwrap_err();
        assert_eq!(err, FetchError::SignIn);
        assert_eq!(err.state(), State::NotAPdf);
        assert_eq!(s.paths(), vec!["a.test/redirect"]);
        // The library's own sign-in host, and a sign-in path at the start: nothing is requested and
        // the cookies are not even read.
        let read: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(|| panic!("the cookies were read"));
        let mut i = input(s.url("a.test", "/paper.pdf"), None);
        i.sign_in_hosts = vec!["a.test".into()];
        assert_eq!(tauri::async_runtime::block_on(fetch_pdf(i, read, &rules(), resolver(), &mut Vec::new())), Err(FetchError::SignIn));
        assert_eq!(fetch(input(s.url("a.test", "/login/paper.pdf"), None), &rules(), &mut Vec::new()), Err(FetchError::SignIn));
        assert_eq!(s.paths(), vec!["a.test/redirect"]);
    }

    /// R347 a, end to end through the controller and the one request path: the job a link's window
    /// makes for a PDF on its own host is fetched; a library's window makes none, and its sign-in host
    /// is never asked; a sign-in path is refused for both kinds.
    #[test]
    fn the_kind_of_start_decides_the_opened_host_and_nothing_else() {
        let s = Server::start("kind");
        let landing = s.url("a.test", "/landing");
        let pdf = s.url("a.test", "/paper.pdf");
        let run = |input: FetchInput| {
            let read: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(jar);
            tauri::async_runtime::block_on(fetch_pdf(input, read, &rules(), resolver(), &mut Vec::new()))
        };
        // A link's window opened at a.test: the PDF on a.test is fetched.
        let (lib, host, _d) = started("kind-link-fetch");
        assert!(lib.open(&host, "main", TICKET, landing.as_str(), Start::Link));
        lib.page_loaded(&host, &pdf, Instant::now());
        let job = std::mem::take(&mut *host.jobs.lock().unwrap()).remove(0);
        assert_eq!(run(job.input), Ok(3009));
        assert_eq!(s.paths(), vec!["a.test/paper.pdf"]);
        // A library's window opened at a.test: no job; and were a.test reached by a hop, it is not asked.
        let (lib2, host2, _d2) = started("kind-library-fetch");
        assert!(lib2.open(&host2, "main", TICKET, landing.as_str(), Start::Library));
        lib2.page_loaded(&host2, &pdf, Instant::now());
        assert_eq!(host2.jobs(), 0);
        let mut i = input(s.url("b.test", &format!("/redirect?to={}", urlencode(pdf.as_str()))), None);
        i.sign_in_hosts = vec!["a.test".into()];
        assert_eq!(run(i), Err(FetchError::SignIn));
        assert_eq!(s.paths(), vec!["a.test/paper.pdf", "b.test/redirect"]);
        // A sign-in path, for a link's fetch too (no sign-in host): nothing requested.
        let mut i = input(s.url("a.test", "/login/paper.pdf"), None);
        i.sign_in_hosts = Vec::new();
        assert_eq!(run(i), Err(FetchError::SignIn));
        assert_eq!(s.paths().len(), 2);
    }

    /// R360 a, through the controller and the one request path: a link's ticket in a window a library's
    /// start opened at a.test fetches from its own host, and a hop of the shell's own request that reaches
    /// a.test is not requested.
    #[test]
    fn a_hop_to_the_library_s_sign_in_host_under_a_link_s_ticket_is_not_requested() {
        let s = Server::start("link-after-library");
        let run = |input: FetchInput| {
            let read: Box<dyn FnOnce() -> Vec<Cookie<'static>> + Send> = Box::new(jar);
            tauri::async_runtime::block_on(fetch_pdf(input, read, &rules(), resolver(), &mut Vec::new()))
        };
        let (lib, host, _d) = started("link-after-library-fetch");
        let t0 = Instant::now();
        assert!(lib.open(&host, "main", TICKET, s.url("a.test", "/login?url=x").as_str(), Start::Library));
        lib.page_loaded(&host, &s.url("c.test", "/paper.pdf"), t0);
        let job = jobs_of(&host).remove(0);
        lib.finish(&host, job.generation, TICKET, Outcome::HandedOver, t0);
        let later = t0 + Duration::from_secs(30);
        assert!(lib.open(&host, "main", TICKET2, s.url("b.test", "/landing").as_str(), Start::Link));
        // On the link's own host: fetched.
        lib.page_loaded(&host, &s.url("b.test", "/paper.pdf"), later);
        let job = jobs_of(&host).remove(0);
        assert_eq!(run(job.input), Ok(3009));
        lib.finish(&host, job.generation, TICKET2, Outcome::Fetch(FetchError::NotPdf), later);
        // A redirect from the link's host to the library's sign-in host: the hop is not requested, the reason said.
        let pdf = s.url("a.test", "/paper.pdf");
        host.at(s.url("b.test", &format!("/redirect?to={}", urlencode(pdf.as_str()))).as_str());
        assert!(lib.take_pdf(&host, "main", later));
        let job = jobs_of(&host).remove(0);
        let got = run(job.input);
        assert_eq!(got, Err(FetchError::SignIn));
        lib.finish(&host, job.generation, TICKET2, Outcome::Fetch(got.unwrap_err()), later);
        assert_eq!(host.last(), LibraryEvent::refused(Some(TICKET2), State::NotAPdf, Reason::SignIn));
        assert_eq!(s.paths(), vec!["b.test/paper.pdf", "b.test/redirect"], "a.test is never asked");
    }

    /// The client uses no proxy even where the environment names one. Run in a child process of
    /// this test program whose environment alone names the proxy (a local listener that must see no
    /// connection): the variables never reach this process or any other test, and reqwest reads them
    /// once per process, so no other test can be affected or affect this one.
    #[test]
    fn the_client_uses_no_proxy_even_when_one_is_set() {
        const CHILD: &str = "AO_LIBRARY_WINDOW_PROXY_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let s = Server::start("proxy-child");
            let mut r = rules();
            r.idle = Duration::from_secs(3);
            r.total = Duration::from_secs(6);
            let mut sink = Vec::new();
            assert_eq!(fetch(input(s.url("a.test", "/small.pdf"), None), &r, &mut sink), Ok(13));
            assert_eq!(s.paths(), vec!["a.test/small.pdf"]);
            return;
        }
        let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        proxy.set_nonblocking(true).unwrap();
        let at = format!("http://127.0.0.1:{}", proxy.local_addr().unwrap().port());
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args(["--exact", "library_window::tests::the_client_uses_no_proxy_even_when_one_is_set", "--nocapture", "--test-threads=1"]).env(CHILD, "1");
        for k in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            child.env(k, &at);
        }
        child.env_remove("NO_PROXY").env_remove("no_proxy");
        let out = child.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && text.contains("test result: ok. 1 passed"), "{text}");
        assert_eq!(proxy.accept().map(|_| ()).map_err(|e| e.kind()), Err(io::ErrorKind::WouldBlock), "the proxy was connected to");
    }

    #[test]
    fn a_host_with_no_checked_address_is_never_looked_up() {
        let s = Server::start("nolookup");
        let checked = SocketAddr::new("127.0.0.1".parse().unwrap(), s.port);
        let client = hop_client(&s.url("a.test", "/"), checked, &rules(), USER_AGENT, Duration::from_secs(10)).unwrap();
        tauri::async_runtime::block_on(async {
            // The checked host is reached at its checked address.
            let ok = client.get(s.url("a.test", "/small.pdf")).send().await.unwrap();
            assert_eq!(ok.status().as_u16(), 200);
            // A name the client was not given an address for is not looked up: the request fails
            // before any connection. (`localhost` is in the system's hosts file and in the test
            // certificate, so a client that looked it up would reach the test server; nothing outside
            // is asked.)
            assert!(client.get(s.url("localhost", "/small.pdf")).send().await.is_err());
        });
        assert_eq!(s.paths(), vec!["a.test/small.pdf"]);
    }

    #[test]
    fn an_answer_from_another_address_than_the_checked_one_is_refused() {
        let s = Server::start("remote");
        let url = s.url("a.test", "/small.pdf");
        let real = SocketAddr::new("127.0.0.1".parse().unwrap(), s.port);
        let client = hop_client(&url, real, &rules(), USER_AGENT, Duration::from_secs(10)).unwrap();
        // The connection went to `real`; the address that was checked is another one.
        for checked in [SocketAddr::new("127.0.0.2".parse().unwrap(), s.port), SocketAddr::new("::ffff:127.0.0.1".parse().unwrap(), s.port), SocketAddr::new(real.ip(), s.port + 1)] {
            let got = tauri::async_runtime::block_on(send_to(client.get(url.clone()), checked));
            assert_eq!(got.err(), Some(FetchError::Refused), "{checked}");
        }
        // The answer from the checked address is taken.
        assert!(tauri::async_runtime::block_on(send_to(client.get(url), real)).is_ok());
    }

    fn urlencode(s: &str) -> String {
        s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
    }

    fn part_in(name: &str) -> (TmpDir, PartFile) {
        let d = tmp(name);
        let inbox = prepare_inbox(&d).unwrap();
        let p = PartFile::new(inbox, GRANT.into());
        (d, p)
    }

    fn inbox_is_empty(d: &Path) -> bool {
        fs::read_dir(d.join(INBOX)).unwrap().count() == 0
    }

    #[test]
    fn a_page_that_is_not_a_pdf_keeps_nothing() {
        let s = Server::start("notpdf");
        for path in ["/page.html", "/late-mark"] {
            let (d, mut part) = part_in("notpdf");
            assert_eq!(fetch(input(s.url("a.test", path), None), &rules(), &mut part), Err(FetchError::NotPdf), "{path}");
            drop(part);
            assert!(inbox_is_empty(&d));
            fs::remove_dir_all(d).unwrap();
        }
        assert_eq!(fetch(input(s.url("a.test", "/missing"), None), &rules(), &mut Vec::new()), Err(FetchError::Status(404)));
    }

    #[test]
    fn the_size_limits_hold() {
        let s = Server::start("size");
        let mut r = rules();
        r.max_bytes = 100_000;
        // A Content-Length above the limit is refused at once.
        let t = Instant::now();
        assert_eq!(fetch(input(s.url("a.test", "/big"), None), &r, &mut Vec::new()), Err(FetchError::TooLarge));
        assert!(t.elapsed() < Duration::from_secs(5));
        // A body without a length is counted as it passes.
        let (d, mut part) = part_in("size");
        assert_eq!(fetch(input(s.url("a.test", "/endless"), None), &r, &mut part), Err(FetchError::TooLarge));
        drop(part);
        assert!(inbox_is_empty(&d));
        fs::remove_dir_all(d).unwrap();
        assert_eq!(MAX_BYTES, 209_715_200);
    }

    #[test]
    fn a_body_that_stalls_or_lies_about_its_length_is_dropped() {
        let s = Server::start("stall");
        let mut r = rules();
        r.idle = Duration::from_secs(1);
        let (d, mut part) = part_in("stall");
        let t = Instant::now();
        assert_eq!(fetch(input(s.url("a.test", "/stall"), None), &r, &mut part), Err(FetchError::TimedOut));
        assert!(t.elapsed() < Duration::from_secs(10));
        drop(part);
        assert!(inbox_is_empty(&d));
        // The whole fetch is bounded too.
        let mut r = rules();
        r.total = Duration::from_millis(1500);
        let t = Instant::now();
        assert_eq!(fetch(input(s.url("a.test", "/stall"), None), &r, &mut Vec::new()), Err(FetchError::TimedOut));
        assert!(t.elapsed() < Duration::from_secs(8));
        // A body shorter than its Content-Length.
        let (d2, mut part) = part_in("liar");
        assert_eq!(fetch(input(s.url("a.test", "/liar"), None), &rules(), &mut part), Err(FetchError::Network));
        drop(part);
        assert!(inbox_is_empty(&d2));
        for x in [d, d2] {
            fs::remove_dir_all(x).unwrap();
        }
    }

    #[test]
    fn the_error_texts_name_nothing_of_the_fetch() {
        let all = [
            FetchError::NotPdf,
            FetchError::SignIn,
            FetchError::NotHttps,
            FetchError::TooManyRedirects,
            FetchError::Refused,
            FetchError::Unresolved,
            FetchError::TooLarge,
            FetchError::TimedOut,
            FetchError::Status(503),
            FetchError::Network,
            FetchError::Write,
        ];
        let mut texts: Vec<String> = all.iter().flat_map(|e| [e.to_string(), format!("{e:?}")]).collect();
        texts.extend([InboxError::NotAFolder, InboxError::NotYours, InboxError::Io].iter().flat_map(|e| [e.to_string(), format!("{e:?}")]));
        texts.extend([HandOverError::NoService, HandOverError::Write, HandOverError::Ended].iter().flat_map(|e| [e.to_string(), format!("{e:?}")]));
        for t in texts {
            // No address (no `/`, no scheme's `:`), no query or cookie (`=`).
            assert!(!t.contains('/') && !t.contains(':') && !t.contains('='), "{t}");
        }
        assert_eq!(FetchError::Status(503).to_string(), "The server answered with status 503.");
    }

    // ----- nothing printed, nothing granted -----

    #[test]
    fn nothing_of_a_cookie_address_ticket_or_path_is_printed() {
        let src = include_str!("library_window.rs");
        let all_prod = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        // Task MAC7: the launch check's probe module (debug builds only: the release test above) prints
        // the sign-in window's trace in test mode, each line made by one of its own functions, which
        // print only the check's own addresses (`the_sign_in_windows_trace_…`). Judged apart; the
        // rest of the module as before.
        let at = all_prod.find("pub mod library_probe {").unwrap();
        let end = block_end(all_prod, at + all_prod[at..].find('{').unwrap());
        let probe = &all_prod[at..end];
        let probe_prints: Vec<&str> = probe.lines().filter(|l| l.contains("println!")).map(str::trim).collect();
        assert_eq!(
            probe_prints,
            vec![
                "println!(\"{}\", navigation_line(url, allowed, report));",
                "println!(\"{}\", address_line(window.url().map_err(|e| e.to_string()), &report));",
                "println!(\"{}\", fallback_line());",
            ]
        );
        let traced_prints: Vec<&str> = all_prod.lines().filter(|l| l.contains("println!(\"{}\", library_probe::")).map(str::trim).collect();
        assert_eq!(traced_prints, vec!["println!(\"{}\", library_probe::page_load_line(p.event() == PageLoadEvent::Finished, p.url(), report));"]);
        let prod_owned = format!("{}{}", &all_prod[..at], &all_prod[end..]);
        let prod_owned = prod_owned.lines().filter(|l| !l.contains("println!(\"{}\", library_probe::page_load_line(")).collect::<Vec<_>>().join("\n");
        let prod = prod_owned.as_str();
        for forbidden in ["eprintln!", "eprint!", "dbg!", "panic!", "unreachable!", "todo!", "unimplemented!", "log::", "tracing::", ".expect(", ".unwrap()", "assert!", "print!("] {
            assert!(!prod.contains(forbidden), "{forbidden}");
        }
        let prints: Vec<&str> = prod.lines().filter(|l| l.contains("println!")).map(str::trim).collect();
        assert_eq!(prints, vec!["println!(\"AO_SHELL_LIBRARY {}\", event.state.word());"]);
        // The shell's own lines about the sign-in window (lib.rs) carry no value either.
        let lib = include_str!("lib.rs");
        for l in lib.lines().filter(|l| l.contains("println!") || l.contains("eprintln!")) {
            for word in ["ticket", "url", "cookie", "grant", "path", "inbox", "store"] {
                assert!(!l.to_ascii_lowercase().contains(word), "{l}");
            }
        }
    }

    #[test]
    fn the_sign_in_window_is_granted_nothing_and_the_main_window_its_six_commands() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let six = ["open_library_window", "library_window_take_pdf", "close_library_window", "sign_out_of_library", "set_stay_signed_in", "open_in_browser"];
        let read = |p: PathBuf| -> serde_json::Value { serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap() };
        // Every capability file: the main window only, local pages only, no remote scope.
        let files: Vec<PathBuf> = fs::read_dir(root.join("capabilities")).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 1);
        let check = |cap: &serde_json::Value| {
            assert_eq!(cap["windows"], serde_json::json!(["main"]), "{cap}");
            assert!(cap.get("webviews").is_none() && cap.get("remote").is_none() && cap.get("platforms").is_none(), "{cap}");
            assert_eq!(cap["local"], true);
            let text = cap.to_string();
            assert!(!text.contains("\"library\"") && !text.contains('*'), "{cap}");
        };
        let cap = read(files[0].clone());
        check(&cap);
        let perms: Vec<&str> = cap["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        for c in six {
            let id = format!("allow-{}", c.replace('_', "-"));
            assert!(perms.contains(&id.as_str()), "{id}");
            let toml = fs::read_to_string(root.join("permissions/autogenerated").join(format!("{c}.toml"))).unwrap();
            assert!(toml.contains(&format!("identifier = \"{id}\"")) && toml.contains(&format!("commands.allow = [\"{c}\"]")), "{c}");
        }
        // The configuration names that one capability and builds no window of its own.
        let conf = read(root.join("tauri.conf.json"));
        assert_eq!(conf["app"]["security"]["capabilities"], serde_json::json!(["main-window"]));
        assert_eq!(conf["app"]["windows"], serde_json::json!([]));
        // The set the build made (tauri-build's output, compiled into this program).
        let built = read(root.join("gen/schemas/capabilities.json"));
        let built = built.as_object().unwrap();
        assert_eq!(built.keys().collect::<Vec<_>>(), vec!["main-window"]);
        built.values().for_each(check);
        let acl = read(root.join("gen/schemas/acl-manifests.json"));
        let mut app_perms: Vec<&String> = acl["__app-acl__"]["permissions"].as_object().unwrap().keys().collect();
        app_perms.sort();
        let mut want: Vec<String> = six.iter().chain(["pick_watch_folder"].iter()).flat_map(|c| [format!("allow-{}", c.replace('_', "-")), format!("deny-{}", c.replace('_', "-"))]).collect();
        want.sort();
        assert_eq!(app_perms, want.iter().collect::<Vec<_>>());
    }

    // ----- the launch check's probe of this window (Task F19, R343 b) -----

    /// `src` as a release build compiles it: every item under `#[cfg(debug_assertions)]` or
    /// `#[cfg(test)]` (with the attributes and doc comments after that attribute) removed — a block
    /// to its matching brace, anything else to its `;`. (`cfg!(…)` expressions are compiled in
    /// every build, so they are kept.)
    fn as_released(src: &str) -> String {
        let mut out = String::new();
        let mut rest = src;
        loop {
            let at = [rest.find("#[cfg(debug_assertions)]"), rest.find("#[cfg(test)]")].into_iter().flatten().min();
            let Some(at) = at else {
                out.push_str(rest);
                return out;
            };
            out.push_str(&rest[..at]);
            let mut i = at + rest[at..].find(']').unwrap() + 1;
            let b = rest.as_bytes();
            // Further attributes and doc comments belong to the same item.
            loop {
                while i < b.len() && (b[i] as char).is_whitespace() {
                    i += 1;
                }
                if rest[i..].starts_with("#[") {
                    i += rest[i..].find(']').unwrap() + 1;
                } else if rest[i..].starts_with("//") {
                    i += rest[i..].find('\n').unwrap_or(rest.len() - i);
                } else {
                    break;
                }
            }
            let semi = rest[i..].find(';').map(|k| i + k);
            let brace = rest[i..].find('{').map(|k| i + k);
            let end = match (brace, semi) {
                (Some(o), s) if s.is_none_or(|s| o < s) => block_end(rest, o),
                (_, Some(s)) => s + 1,
                _ => rest.len(),
            };
            rest = &rest[end..];
        }
    }

    /// The end (just past the matching `}`) of the block opening at `open`, with the braces inside
    /// string literals (plain, byte and raw), character literals and comments not counted.
    fn block_end(src: &str, open: usize) -> usize {
        let b = src.as_bytes();
        let mut depth = 0usize;
        let mut k = open;
        while k < b.len() {
            match b[k] {
                b'/' if b.get(k + 1) == Some(&b'/') => k += src[k..].find('\n').unwrap_or(src.len() - k),
                b'/' if b.get(k + 1) == Some(&b'*') => k += src[k..].find("*/").map_or(src.len() - k, |e| e + 1),
                b'r' if matches!(b.get(k + 1), Some(b'"') | Some(b'#')) && (!b[k - 1].is_ascii_alphanumeric() || (b[k - 1] == b'b' && !b[k - 2].is_ascii_alphanumeric())) => {
                    let hashes = b[k + 1..].iter().take_while(|&&c| c == b'#').count();
                    let close = format!("\"{}", "#".repeat(hashes));
                    let body = k + 2 + hashes;
                    k = body + src[body..].find(&close).unwrap() + close.len() - 1;
                }
                b'"' => {
                    k += 1;
                    while b[k] != b'"' {
                        k += if b[k] == b'\\' { 2 } else { 1 };
                    }
                }
                // A character literal ('x', '\n', '\''), not a lifetime ('a).
                b'\'' if b.get(k + 1) == Some(&b'\\') => k += 3 + src[k + 3..].find('\'').unwrap(),
                b'\'' if b.get(k + 2) == Some(&b'\'') => k += 2,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return k + 1;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        src.len()
    }

    #[test]
    fn a_release_build_has_neither_the_sign_in_windows_probe_nor_its_switch() {
        let files = [("library_window.rs", include_str!("library_window.rs")), ("lib.rs", include_str!("lib.rs"))];
        let mut seen_in_debug = (false, false, false);
        for (name, src) in files {
            seen_in_debug.0 |= src.contains("library_probe.js");
            seen_in_debug.1 |= src.contains("AO_SHELL_LIBRARY_PROBE");
            seen_in_debug.2 |= src.contains("AO_SHELL_LIBRARY_TRACE");
            // Comment lines compile to nothing (a doc comment goes with its item).
            let released: String = as_released(src).lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            assert!(!released.contains("library_probe"), "{name}: a release build would hold the sign-in window's probe");
            assert!(!released.contains("AO_SHELL_LIBRARY_PROBE"), "{name}: a release build would read the probe's switch");
            // Task MAC7: nor the sign-in window's trace, its fallback or its traced navigation rule.
            assert!(!released.contains("AO_SHELL_LIBRARY_TRACE"), "{name}: a release build would print the sign-in window's trace");
            assert!(!released.contains("traced"), "{name}: a release build would trace the sign-in window");
            // The main window's probe module is debug-only as well (it reads the same switch).
            assert!(!released.contains("probe::"), "{name}: a release build would call a probe");
        }
        // The control: the debug build has both (so the stripping above is what removed them).
        assert_eq!(seen_in_debug, (true, true, true));
        // The release build's navigation rule is the plain one, given as it is.
        let released = as_released(include_str!("library_window.rs"));
        assert!(released.contains(".on_navigation(navigation_allowed)"));
        // And the stripping itself: a gated block, a gated statement and a gated item with its doc go; the rest stays.
        let s = "a();\n#[cfg(debug_assertions)]\n{ b({}); }\nc();\n#[cfg(debug_assertions)]\nlet x = 1;\n#[cfg(test)]\n/// doc\n#[allow(x)]\nmod t { fn y() {} }\nd();\n#[cfg(test)]\nmod u { const S: &str = \"}{\\\"}\"; const C: char = '}'; const R: &str = r#\"}\"#; // }\n }\ne();";
        assert_eq!(as_released(s).split_whitespace().collect::<String>(), "a();c();d();e();");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_probe_reports_only_to_the_checks_own_loopback_address() {
        use super::library_probe::{open_address, report_address, script};
        let r = report_address("http://127.0.0.1:40125/report").unwrap();
        assert_eq!(r.as_str(), "http://127.0.0.1:40125/report");
        let s = script(&r);
        assert!(!s.contains("__LIBRARY_PROBE_CONFIG__"));
        // Task MAC7: and where it says how far it got (`/progress/<step>`), on the same server.
        assert!(s.contains(r#"{"page":"http://127.0.0.1:40125/page","progress":"http://127.0.0.1:40125/progress","report":"http://127.0.0.1:40125/report"}"#), "{s}");
        // The main window's probe opens the sign-in window at an https address of the same port.
        assert_eq!(open_address(&r), "https://127.0.0.1:40125/sign-in");
        assert!(window_address(&open_address(&r)).is_some());
        for bad in [
            "",
            "https://127.0.0.1:40125/report",
            "http://127.0.0.2:40125/report",
            "http://localhost:40125/report",
            "http://127.0.0.1/report",
            "http://127.0.0.1:0/report",
            "http://127.0.0.1:40125/report?x=1",
            "http://127.0.0.1:40125/other",
            "http://u:p@127.0.0.1:40125/report",
            "http://127.0.0.1:40125/report#x",
            "http://example.org:40125/report",
        ] {
            assert!(report_address(bad).is_none(), "{bad}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_sign_in_windows_trace_names_scheme_host_port_and_path_never_the_query() {
        use super::library_probe::{address_line, fallback_line, navigation_line, page_load_line, shown, FALLBACK_AFTER};
        let u = |s: &str| Url::parse(s).unwrap();
        let r = u("http://127.0.0.1:40125/report");
        // The check's own addresses: scheme, host, port and path, never the query or fragment.
        assert_eq!(shown(&u("http://127.0.0.1:40125/report?r=%7B%22secret%22%7D#x"), &r), "http://127.0.0.1:40125/report");
        assert_eq!(shown(&u("https://127.0.0.1:40125/sign-in"), &r), "https://127.0.0.1:40125/sign-in");
        assert_eq!(shown(&u("about:blank"), &r), "about:blank");
        let long = format!("http://127.0.0.1:40125/{}", "p".repeat(300));
        assert!(shown(&u(&long), &r).chars().count() <= 130, "{}", shown(&u(&long), &r));
        // Any other address (R325): its scheme alone.
        for other in ["https://user:pw@library.example.org/sign-in?ticket=abc", "https://127.0.0.1:40126/page", "http://127.0.0.1/page", "http://127.0.0.2:40125/page", "data:text/html,<p>secret</p>", "file:///home/someone/x.pdf", "tauri://localhost/index.html"] {
            let s = shown(&u(other), &r);
            assert!(s.ends_with(" (an address not the check's)") && !s.contains('/') && !s.contains("example") && !s.contains("secret"), "{other}: {s}");
        }
        assert_eq!(navigation_line(&u("http://127.0.0.1:40125/report?r=x"), true, &r), "AO_SHELL_LIBRARY_TRACE navigation http://127.0.0.1:40125/report allowed");
        assert_eq!(navigation_line(&u("file:///etc/passwd"), false, &r), "AO_SHELL_LIBRARY_TRACE navigation file (an address not the check's) refused");
        assert_eq!(page_load_line(false, &u("http://127.0.0.1:40125/page?q=1"), &r), "AO_SHELL_LIBRARY_TRACE page-load started http://127.0.0.1:40125/page");
        assert_eq!(page_load_line(true, &u("http://127.0.0.1:40125/page"), &r), "AO_SHELL_LIBRARY_TRACE page-load finished http://127.0.0.1:40125/page");
        assert_eq!(address_line(Ok(u("https://127.0.0.1:40125/sign-in?x")), &r), "AO_SHELL_LIBRARY_TRACE address after 10 s: https://127.0.0.1:40125/sign-in");
        assert_eq!(address_line(Err("WKWebView URL is nil\n".to_string()), &r), "AO_SHELL_LIBRARY_TRACE address after 10 s: none (WKWebView URL is nil?)");
        assert_eq!(fallback_line(), "AO_SHELL_LIBRARY_TRACE fallback: no page started in 10 s; the shell opens the check's page");
        assert_eq!(FALLBACK_AFTER, std::time::Duration::from_secs(10));
    }
}
