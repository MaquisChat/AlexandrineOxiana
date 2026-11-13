//! Folder grants (Task W6, R207). A watched folder is approved only through the shell's own native
//! folder chooser: `pick_watch_folder` (lib.rs) opens it, and the chosen path goes to the service as
//! ONE line on the standard-input pipe the shell already holds, never to the page:
//!
//!   {"type":"folder-grant","id":"<32 lowercase hex>","path":"<absolute path>"}\n
//!
//! The service keeps that path for one use, for at most 10 minutes (folder-grants.ts); the page gets
//! only the grant's id and the folder's last name, and exchanges the id at a service route (W7).
//! Every value in the line is encoded by serde_json (the JSON library this crate already uses), so
//! a folder name with quotes, back-slashes, line ends or other control characters cannot break out
//! of its string or start a second line. The service accepts exactly the text this module writes:
//! keys in this order, no spaces, serde_json's escapes (which are JavaScript's `JSON.stringify`'s).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::service::ServiceInput;

/// The longest grant line, in bytes, its line end included (the service reads at most 8 KiB without it).
pub const GRANT_LINE_MAX_BYTES: usize = 8192;
/// The longest path a grant may carry, in bytes of UTF-8.
pub const GRANT_PATH_MAX_BYTES: usize = 4096;
/// The longest chooser title the page may set, in characters.
pub const TITLE_MAX_CHARS: usize = 200;
const DEFAULT_TITLE: &str = "Choose a folder to watch";

/// What the page receives for a chosen folder: the grant's id and the folder's last name. Never the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickedFolder {
    pub grant_id: String,
    pub name: String,
}

impl PickedFolder {
    /// The answer as the page reads it: `{"grantId": "...", "name": "..."}`.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "grantId": self.grant_id, "name": self.name })
    }
}

/// A new grant id: 16 bytes from the operating system's secure random source, as 32 lowercase hex.
pub fn new_grant_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The grant line for `path`, ended by `\n`; None when the id is not 32 lowercase hex, the path is
/// relative, not valid UTF-8, holds a NUL or is longer than GRANT_PATH_MAX_BYTES, or the line would
/// be longer than GRANT_LINE_MAX_BYTES.
pub fn grant_line(id: &str, path: &Path) -> Option<String> {
    if !valid_id(id) || !path.is_absolute() {
        return None;
    }
    let p = path.to_str()?;
    if p.is_empty() || p.contains('\0') || p.len() > GRANT_PATH_MAX_BYTES {
        return None;
    }
    let line = format!(
        "{{\"type\":\"folder-grant\",\"id\":{},\"path\":{}}}\n",
        serde_json::to_string(id).ok()?,
        serde_json::to_string(p).ok()?
    );
    (line.len() <= GRANT_LINE_MAX_BYTES).then_some(line)
}

/// The folder's last name component, as the page may show it (through `UserText`). None for a path
/// with no last component (a root: `/`, `C:\`, `\\server\share\`), which cannot be a watched folder;
/// never the whole path.
pub fn folder_name(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(str::to_owned)
}

/// What a folder choice needs from the shell: whether it is stopping, and the service's standard
/// input (None when there is no running service).
pub trait GrantTarget {
    fn stopping(&self) -> bool;
    fn service_input(&self) -> Option<ServiceInput>;
}

/// One watched-folder chooser at a time.
#[derive(Default)]
pub struct Picker {
    open: AtomicBool,
}

/// Marks the chooser open while it lives.
struct Open<'a>(&'a AtomicBool);

impl Drop for Open<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Everything `pick_watch_folder` (lib.rs) does, around the chooser `choose` (the system dialog in
/// the app; a stand-in in tests). Answers None, writing nothing, when:
/// - the asking window is not the main window (no chooser opens);
/// - a chooser is already open (no second one opens);
/// - the shell is stopping, before the chooser or once it has closed;
/// - the choice was cancelled, or the folder is a root or cannot be put in a grant line;
/// - there is no running service once the chooser has closed (looked up only then), or the write fails.
///
/// Otherwise exactly one grant line is written and the page's answer returned.
pub fn pick_with(picker: &Picker, window_label: &str, target: &dyn GrantTarget, choose: impl FnOnce() -> Option<PathBuf>) -> Option<PickedFolder> {
    if window_label != "main" || target.stopping() {
        return None;
    }
    if picker.open.swap(true, Ordering::SeqCst) {
        return None;
    }
    let _open = Open(&picker.open);
    let path = choose()?;
    let name = folder_name(&path)?;
    let id = new_grant_id()?;
    let line = grant_line(&id, &path)?;
    drop(path);
    if target.stopping() {
        return None;
    }
    let input = target.service_input()?;
    if !input.send_line(&line) {
        return None;
    }
    Some(PickedFolder { grant_id: id, name })
}

/// The chooser's title from the page: plain text, control characters removed, at most
/// TITLE_MAX_CHARS characters; a default when nothing is left.
pub fn chooser_title(title: &str) -> String {
    let t: String = title.chars().filter(|c| !c.is_control()).take(TITLE_MAX_CHARS).collect();
    let t = t.trim();
    if t.is_empty() { DEFAULT_TITLE.to_string() } else { t.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn grant_line_escapes_quotes_and_newlines() {
        let path = PathBuf::from("/Users/r/a \"b\"\n\\c\u{1} é\u{2028} ﬁ/}{");
        let line = grant_line(ID, &path).unwrap();
        // The exact text folder-grants.test.ts › parseGrantLine reads back.
        assert_eq!(line, "{\"type\":\"folder-grant\",\"id\":\"0123456789abcdef0123456789abcdef\",\"path\":\"/Users/r/a \\\"b\\\"\\n\\\\c\\u0001 é\u{2028} ﬁ/}{\"}\n");
        // One line only, and the JSON reads back to the same path.
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["path"].as_str().unwrap(), path.to_str().unwrap());
        assert_eq!(v["type"], "folder-grant");
        assert_eq!(v["id"], ID);
        assert_eq!(v.as_object().unwrap().len(), 3);
        // A name that tries to close the string and add a key stays inside the path.
        let hostile = PathBuf::from("/x\",\"path\":\"/etc\"}\n{\"type\":\"folder-grant");
        let line = grant_line(ID, &hostile).unwrap();
        assert_eq!(line.matches('\n').count(), 1);
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["path"].as_str().unwrap(), hostile.to_str().unwrap());
    }

    #[test]
    fn grant_line_refuses_relative_paths() {
        for p in ["relative/folder", "./x", "../x", "~/Documents", ""] {
            assert_eq!(grant_line(ID, Path::new(p)), None, "{p}");
        }
    }

    #[test]
    fn grant_line_refuses_a_bad_id_and_a_nul() {
        for id in ["", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "0123456789abcdef0123456789abcdefa", "g123456789abcdef0123456789abcdef"] {
            assert_eq!(grant_line(id, Path::new("/x")), None, "{id}");
        }
        assert_eq!(grant_line(ID, Path::new("/a\0b")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_yields_none() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let p = Path::new(OsStr::from_bytes(b"/Users/r/caf\xe9"));
        assert_eq!(grant_line(ID, p), None);
        assert_eq!(folder_name(p), None);
    }

    #[test]
    fn a_line_over_8_kib_yields_none() {
        // 4,096 bytes of path is the limit; one more is refused.
        let ok = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES - 1));
        assert!(grant_line(ID, Path::new(&ok)).is_some());
        let long = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES));
        assert_eq!(grant_line(ID, Path::new(&long)), None);
        // A path within 4,096 bytes whose escaped form makes the line longer than 8 KiB.
        let escaped = format!("/{}", "\u{1}".repeat(1400));
        assert!(escaped.len() <= GRANT_PATH_MAX_BYTES);
        assert_eq!(grant_line(ID, Path::new(&escaped)), None);
        // Every line made is at most 8 KiB with its line end.
        let quotes = format!("/{}", "\"".repeat(4000));
        let line = grant_line(ID, Path::new(&quotes)).unwrap();
        assert!(line.len() <= GRANT_LINE_MAX_BYTES);
    }

    #[test]
    fn grant_ids_are_32_lowercase_hex_and_new_each_time() {
        let a = new_grant_id().unwrap();
        let b = new_grant_id().unwrap();
        assert!(valid_id(&a) && valid_id(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn the_page_gets_the_id_and_the_last_name_only() {
        let p = Path::new("/Users/r/Library/CloudStorage/GoogleDrive-r@x.org/My Drive/Fieldwork <b>");
        let picked = PickedFolder { grant_id: ID.into(), name: folder_name(p).unwrap() };
        let v = picked.to_json();
        assert_eq!(v, serde_json::json!({ "grantId": ID, "name": "Fieldwork <b>" }));
        assert!(!v.to_string().contains("CloudStorage"));
    }

    #[test]
    fn a_root_has_no_name_and_the_whole_path_is_never_the_name() {
        for root in ["/", "/a/..", "/."] {
            assert_eq!(folder_name(Path::new(root)), None, "{root}");
        }
        assert_eq!(folder_name(Path::new("/Users/r/Fieldwork/")), Some("Fieldwork".into()));
        assert_eq!(folder_name(Path::new("/Users/r/a b")), Some("a b".into()));
    }

    // The Windows shapes are parsed as roots only on Windows (on Linux `\` is an ordinary character).
    #[cfg(windows)]
    #[test]
    fn windows_roots_have_no_name() {
        for root in ["C:\\", "C:/", "\\\\server\\share\\", "\\\\server\\share", "\\\\?\\C:\\"] {
            assert_eq!(folder_name(Path::new(root)), None, "{root}");
        }
        assert_eq!(folder_name(Path::new("C:\\Users\\r\\Fieldwork")), Some("Fieldwork".into()));
    }

    #[test]
    fn the_title_is_cut_by_characters_never_inside_one() {
        let t = chooser_title(&"📁".repeat(250));
        assert_eq!(t, "📁".repeat(TITLE_MAX_CHARS));
    }

    // ----- what the command does around the chooser (M4) -----

    use crate::service::ServiceInput;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Written(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Written {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Written {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    struct FakeShell {
        stopping: AtomicBool,
        input: Option<ServiceInput>,
        lookups: std::sync::atomic::AtomicUsize,
    }
    impl FakeShell {
        fn new(w: &Written) -> Self {
            FakeShell { stopping: AtomicBool::new(false), input: Some(ServiceInput::for_test(w.clone())), lookups: Default::default() }
        }
    }
    impl GrantTarget for FakeShell {
        fn stopping(&self) -> bool {
            self.stopping.load(Ordering::SeqCst)
        }
        fn service_input(&self) -> Option<ServiceInput> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            self.input.clone()
        }
    }

    const FOLDER: &str = "/Users/r/Library/CloudStorage/Dropbox/Fieldwork";

    #[test]
    fn a_good_pick_writes_exactly_one_line_and_answers_the_id_and_the_name() {
        let w = Written::default();
        let shell = FakeShell::new(&w);
        let picker = Picker::default();
        let picked = pick_with(&picker, "main", &shell, || Some(PathBuf::from(FOLDER))).unwrap();
        assert!(valid_id(&picked.grant_id));
        assert_eq!(picked.name, "Fieldwork");
        assert_eq!(w.text(), grant_line(&picked.grant_id, Path::new(FOLDER)).unwrap());
        assert_eq!(w.text().matches('\n').count(), 1);
        assert!(!picked.to_json().to_string().contains("CloudStorage"));
        // The chooser is free again afterwards.
        assert!(pick_with(&picker, "main", &shell, || Some(PathBuf::from(FOLDER))).is_some());
        assert_eq!(w.text().matches('\n').count(), 2);
    }

    #[test]
    fn another_window_gets_nothing_and_no_chooser_opens() {
        let w = Written::default();
        let shell = FakeShell::new(&w);
        let picker = Picker::default();
        for label in ["second", "", "Main", "main "] {
            let opened = AtomicBool::new(false);
            assert_eq!(pick_with(&picker, label, &shell, || { opened.store(true, Ordering::SeqCst); Some(PathBuf::from(FOLDER)) }), None, "{label}");
            assert!(!opened.load(Ordering::SeqCst));
        }
        assert_eq!(w.text(), "");
    }

    #[test]
    fn a_second_pick_while_one_is_open_gets_nothing() {
        let w = Written::default();
        let shell = FakeShell::new(&w);
        let picker = Picker::default();
        let first = pick_with(&picker, "main", &shell, || {
            // Asked again while the chooser is open: no second chooser, nothing written.
            let opened = AtomicBool::new(false);
            assert_eq!(pick_with(&picker, "main", &shell, || { opened.store(true, Ordering::SeqCst); Some(PathBuf::from("/other")) }), None);
            assert!(!opened.load(Ordering::SeqCst));
            Some(PathBuf::from(FOLDER))
        });
        assert!(first.is_some());
        assert_eq!(w.text().matches('\n').count(), 1);
        assert!(!w.text().contains("/other"));
    }

    #[test]
    fn a_stopping_or_gone_service_gets_nothing() {
        let picker = Picker::default();
        // Stopping before: no chooser.
        let w = Written::default();
        let shell = FakeShell::new(&w);
        shell.stopping.store(true, Ordering::SeqCst);
        let opened = AtomicBool::new(false);
        assert_eq!(pick_with(&picker, "main", &shell, || { opened.store(true, Ordering::SeqCst); Some(PathBuf::from(FOLDER)) }), None);
        assert!(!opened.load(Ordering::SeqCst));
        // Stopping begins while the chooser is open: nothing written.
        let shell = FakeShell::new(&w);
        assert_eq!(pick_with(&picker, "main", &shell, || { shell.stopping.store(true, Ordering::SeqCst); Some(PathBuf::from(FOLDER)) }), None);
        assert_eq!(w.text(), "");
        // The service is gone (no input), or its input is closed.
        let gone = FakeShell { stopping: AtomicBool::new(false), input: None, lookups: Default::default() };
        assert_eq!(pick_with(&picker, "main", &gone, || Some(PathBuf::from(FOLDER))), None);
        let closed = FakeShell::new(&w);
        closed.input.as_ref().unwrap().close_for_test();
        assert_eq!(pick_with(&picker, "main", &closed, || Some(PathBuf::from(FOLDER))), None);
        assert_eq!(w.text(), "");
        // The service is looked up only after the chooser closed.
        let late = FakeShell::new(&w);
        pick_with(&picker, "main", &late, || { assert_eq!(late.lookups.load(Ordering::SeqCst), 0); None });
        assert_eq!(late.lookups.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_cancelled_pick_a_root_or_a_path_that_fits_no_line_gets_nothing() {
        let w = Written::default();
        let shell = FakeShell::new(&w);
        let picker = Picker::default();
        assert_eq!(pick_with(&picker, "main", &shell, || None), None);
        assert_eq!(pick_with(&picker, "main", &shell, || Some(PathBuf::from("/"))), None);
        assert_eq!(pick_with(&picker, "main", &shell, || Some(PathBuf::from("relative"))), None);
        assert_eq!(pick_with(&picker, "main", &shell, || Some(PathBuf::from(format!("/{}", "a".repeat(5000))))), None);
        assert_eq!(w.text(), "");
    }

    #[test]
    fn the_title_is_plain_bounded_text() {
        assert_eq!(chooser_title("Choose a folder to watch"), "Choose a folder to watch");
        assert_eq!(chooser_title("a\nb\u{0}c\u{7}"), "abc");
        assert_eq!(chooser_title(&"t".repeat(5000)).chars().count(), TITLE_MAX_CHARS);
        assert_eq!(chooser_title("  \n "), "Choose a folder to watch");
    }
}
