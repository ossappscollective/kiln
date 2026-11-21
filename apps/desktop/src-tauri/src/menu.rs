// UNCOMPILED: written without a Rust toolchain (like main.rs). Expect, at worst, a small fix on the first `cargo check`.
//
// The application menu, in the language of the system (docs/adr/0046-desktop-localisation.md).
//
// Tauri's own default menu has English labels whatever the system language is. This one has the same items (the same predefined
// items, so Undo, Copy, Quit, Hide and the rest keep their native behaviour and shortcuts) with labels from the desktop catalog.
// There are no custom items and no menu events to handle.

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

use crate::i18n::{t, t_with};

#[allow(unused_imports)]
use tauri::Manager;

/// The whole menu bar. Called once from `Builder::menu`, after `i18n::init()`.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    let with_app = [("app", name.as_str())];
    let about_metadata = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };

    // The application menu (macOS only; its title is the application's name).
    #[cfg(target_os = "macos")]
    let app_menu = {
        let about = PredefinedMenuItem::about(app, Some(t_with("menu.about", &with_app).as_str()), Some(about_metadata.clone()))?;
        let services = PredefinedMenuItem::services(app, Some(t("menu.services").as_str()))?;
        let hide = PredefinedMenuItem::hide(app, Some(t_with("menu.hide", &with_app).as_str()))?;
        let hide_others = PredefinedMenuItem::hide_others(app, Some(t("menu.hideOthers").as_str()))?;
        let quit = PredefinedMenuItem::quit(app, Some(t_with("menu.quit", &with_app).as_str()))?;
        let line1 = PredefinedMenuItem::separator(app)?;
        let line2 = PredefinedMenuItem::separator(app)?;
        let line3 = PredefinedMenuItem::separator(app)?;
        Submenu::with_items(app, &name, true, &[&about, &line1, &services, &line2, &hide, &hide_others, &line3, &quit])?
    };

    // File: closes the window; where there is no application menu it also holds Quit.
    let file = {
        let close = PredefinedMenuItem::close_window(app, Some(t("window.close").as_str()))?;
        #[cfg(not(target_os = "macos"))]
        let line = PredefinedMenuItem::separator(app)?;
        #[cfg(all(not(target_os = "macos"), windows))]
        let quit = PredefinedMenuItem::quit(app, Some(t("menu.exit").as_str()))?;
        #[cfg(all(not(target_os = "macos"), not(windows)))]
        let quit = PredefinedMenuItem::quit(app, Some(t_with("menu.quit", &with_app).as_str()))?;
        let title = t("menu.file");
        #[cfg(target_os = "macos")]
        let items: Vec<&dyn IsMenuItem<Wry>> = vec![&close];
        #[cfg(not(target_os = "macos"))]
        let items: Vec<&dyn IsMenuItem<Wry>> = vec![&close, &line, &quit];
        Submenu::with_items(app, &title, true, &items)?
    };

    let edit = {
        let undo = PredefinedMenuItem::undo(app, Some(t("edit.undo").as_str()))?;
        let redo = PredefinedMenuItem::redo(app, Some(t("edit.redo").as_str()))?;
        let cut = PredefinedMenuItem::cut(app, Some(t("edit.cut").as_str()))?;
        let copy = PredefinedMenuItem::copy(app, Some(t("edit.copy").as_str()))?;
        let paste = PredefinedMenuItem::paste(app, Some(t("edit.paste").as_str()))?;
        let select_all = PredefinedMenuItem::select_all(app, Some(t("edit.selectAll").as_str()))?;
        let line1 = PredefinedMenuItem::separator(app)?;
        let line2 = PredefinedMenuItem::separator(app)?;
        Submenu::with_items(app, t("menu.edit"), true, &[&undo, &redo, &line1, &cut, &copy, &paste, &line2, &select_all])?
    };

    // View: full screen (macOS only).
    #[cfg(target_os = "macos")]
    let view = {
        let fullscreen = PredefinedMenuItem::fullscreen(app, Some(t("view.fullscreen").as_str()))?;
        Submenu::with_items(app, t("menu.view"), true, &[&fullscreen])?
    };

    let window = {
        let minimize = PredefinedMenuItem::minimize(app, Some(t("window.minimize").as_str()))?;
        #[cfg(target_os = "macos")]
        let maximize = PredefinedMenuItem::maximize(app, Some(t("window.zoom").as_str()))?;
        #[cfg(not(target_os = "macos"))]
        let maximize = PredefinedMenuItem::maximize(app, Some(t("window.maximize").as_str()))?;
        let line = PredefinedMenuItem::separator(app)?;
        let close = PredefinedMenuItem::close_window(app, Some(t("window.close").as_str()))?;
        Submenu::with_items(app, t("menu.window"), true, &[&minimize, &maximize, &line, &close])?
    };

    // Help: About, where there is no application menu to hold it (Windows and Linux).
    #[cfg(not(target_os = "macos"))]
    let help = {
        let about = PredefinedMenuItem::about(app, Some(t_with("menu.about", &with_app).as_str()), Some(about_metadata.clone()))?;
        Submenu::with_items(app, t("menu.help"), true, &[&about])?
    };

    let mut bar: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    #[cfg(target_os = "macos")]
    bar.push(&app_menu);
    bar.push(&file);
    bar.push(&edit);
    #[cfg(target_os = "macos")]
    bar.push(&view);
    bar.push(&window);
    #[cfg(not(target_os = "macos"))]
    bar.push(&help);
    Menu::with_items(app, &bar)
}
