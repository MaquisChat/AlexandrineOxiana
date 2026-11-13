fn main() {
    // The shell's own commands the page may be granted (capabilities/main-window.json): only the
    // watched-folder chooser (Task W6, R207). Declaring them here makes Tauri generate the
    // `allow-pick-watch-folder` permission and refuse the command to any window not granted it.
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["pick_watch_folder"]));
    tauri_build::try_build(attributes).expect("the Tauri build step failed");
}
