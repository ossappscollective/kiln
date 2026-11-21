// UNCOMPILED: written without a Rust toolchain (like main.rs). Expect, at worst, a small fix on the first `cargo check`.
//
// The desktop shell's own strings (menus, startup errors). Design: docs/adr/0046-desktop-localisation.md; for translators and
// maintainers: docs/i18n-desktop.md.
//
// - Catalogs are `apps/desktop/locales/desktop/<language>.json`: flat `"key": "text with {{param}}"`, the same layout as the web
//   catalogs, so Weblate and `scripts/i18n.mjs` treat them alike. They are embedded at compile time with `include_str!`.
// - The language is the operating system's UI language (`KILN_LANG` overrides it, for testing): `defaults read -g AppleLanguages` on
//   macOS, the user's UI language on Windows, `LANGUAGE`/`LC_ALL`/`LC_MESSAGES`/`LANG` elsewhere. The first tag whose language has a
//   catalog wins; otherwise English.
// - No plurals: the shell has no counted messages. A key missing (or empty) in the language is read from English, then the key itself
//   is shown, so a missing string never breaks a menu.

use std::collections::HashMap;
use std::sync::OnceLock;

/// The language every key is written in, and the fallback.
pub const SOURCE_LANGUAGE: &str = "en";

/// Every shipped language and its catalog. To add a language: add its file to `locales/desktop/` and one line here.
static CATALOGS: [(&str, &str); 4] = [
    ("en", include_str!("../../locales/desktop/en.json")),
    ("fr", include_str!("../../locales/desktop/fr.json")),
    ("es", include_str!("../../locales/desktop/es.json")),
    ("de", include_str!("../../locales/desktop/de.json")),
];

type Catalog = HashMap<String, String>;

/// A broken catalog gives an empty one (every lookup then falls back), never a panic at start-up. A test keeps them valid.
fn parse(text: &str) -> Catalog {
    serde_json::from_str::<Catalog>(text).unwrap_or_default()
}

fn catalog_text(language: &str) -> &'static str {
    CATALOGS.iter().find(|entry| entry.0 == language).map(|entry| entry.1).unwrap_or("{}")
}

/// The strings of one language, with English behind them.
pub struct Translator {
    language: &'static str,
    active: Catalog,
    source: Catalog,
}

impl Translator {
    /// The translator for `language` (`fr`), or English when there is no catalog for it.
    pub fn for_language(language: &str) -> Self {
        let code = CATALOGS.iter().find(|entry| entry.0 == language).map(|entry| entry.0).unwrap_or(SOURCE_LANGUAGE);
        Translator { language: code, active: parse(catalog_text(code)), source: parse(catalog_text(SOURCE_LANGUAGE)) }
    }

    /// The language code that answers (`en` when the wanted one has no catalog).
    #[allow(dead_code)]
    pub fn language(&self) -> &str {
        self.language
    }

    /// The message for `key`, with no parameters.
    pub fn t(&self, key: &str) -> String {
        self.t_with(key, &[])
    }

    /// The message for `key`, each `{{name}}` replaced by the matching value of `params`.
    /// Order of lookup: this language, English, the key itself. An empty value counts as not translated.
    pub fn t_with(&self, key: &str, params: &[(&str, &str)]) -> String {
        let template = self
            .active
            .get(key)
            .filter(|value| !value.is_empty())
            .or_else(|| self.source.get(key))
            .map(String::as_str)
            .unwrap_or(key);
        interpolate(template, params)
    }
}

/// Replaces `{{name}}` in one pass. A name with no parameter is left as written; a value is never scanned again, so a value
/// that contains `{{x}}` stays as it is.
fn interpolate(template: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = &after[..end];
                match params.iter().find(|pair| pair.0 == name) {
                    Some(pair) => out.push_str(pair.1),
                    None => {
                        out.push_str("{{");
                        out.push_str(name);
                        out.push_str("}}");
                    }
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The primary language of a locale tag, lower case: `fr-CA` and `fr_CA.UTF-8@euro` give `fr`. `C` and `POSIX` (and an empty
/// tag) say nothing about a language and give None.
fn primary_language(tag: &str) -> Option<String> {
    let tag = tag.trim();
    let end = tag.find(|c: char| c == '.' || c == '@').unwrap_or(tag.len());
    let primary = tag[..end].split(|c: char| c == '-' || c == '_').next().unwrap_or("");
    if primary.is_empty() || primary.eq_ignore_ascii_case("c") || primary.eq_ignore_ascii_case("posix") {
        None
    } else {
        Some(primary.to_ascii_lowercase())
    }
}

/// The first of `tags` (in order of preference) whose language has a catalog; English when none does.
pub fn match_language<S: AsRef<str>>(tags: &[S]) -> &'static str {
    for tag in tags {
        if let Some(code) = primary_language(tag.as_ref()) {
            if let Some(entry) = CATALOGS.iter().find(|entry| entry.0 == code) {
                return entry.0;
            }
        }
    }
    SOURCE_LANGUAGE
}

/// The tags in the output of `defaults read -g AppleLanguages`: `(\n    "fr-FR",\n    "en-US"\n)`, quoted or not.
#[allow(dead_code)]
fn parse_apple_languages(output: &str) -> Vec<String> {
    output
        .split(|c: char| c == '(' || c == ')' || c == ',' || c == '\n')
        .map(|part| part.trim().trim_matches('"').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// `LANGUAGE` (a colon-separated list), then `LC_ALL`, `LC_MESSAGES`, `LANG`.
fn env_languages() -> Vec<String> {
    let mut out = Vec::new();
    for name in ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(name) {
            out.extend(value.split(':').filter(|part| !part.is_empty()).map(str::to_string));
        }
    }
    out
}

/// macOS: the user's language list. A macOS app started from Finder has no `LANG`, so ask the preferences system.
#[cfg(target_os = "macos")]
fn macos_languages() -> Vec<String> {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_apple_languages(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

/// Windows: the user's UI language (`fr-FR`), from kernel32 directly so no crate is needed.
#[cfg(windows)]
fn windows_languages() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
        fn LCIDToLocaleName(locale: u32, name: *mut u16, len: i32, flags: u32) -> i32;
    }
    let mut buffer = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    // SAFETY: the buffer is valid for `len` UTF-16 units; the call writes a NUL-terminated name and returns its length with the NUL.
    let written = unsafe { LCIDToLocaleName(u32::from(GetUserDefaultUILanguage()), buffer.as_mut_ptr(), buffer.len() as i32, 0) };
    if written > 1 {
        vec![String::from_utf16_lossy(&buffer[..(written as usize - 1)])]
    } else {
        Vec::new()
    }
}

/// The user's languages in order of preference: `KILN_LANG`, the platform's own list, then the environment.
fn system_languages() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(value) = std::env::var("KILN_LANG") {
        out.push(value);
    }
    #[cfg(target_os = "macos")]
    out.extend(macos_languages());
    #[cfg(windows)]
    out.extend(windows_languages());
    out.extend(env_languages());
    out
}

static ACTIVE: OnceLock<Translator> = OnceLock::new();

/// Resolves the language once (the first call) and returns the translator. Call it first thing in `main`.
pub fn init() -> &'static Translator {
    ACTIVE.get_or_init(|| Translator::for_language(match_language(&system_languages())))
}

/// The message for `key` in the language of the system.
pub fn t(key: &str) -> String {
    init().t(key)
}

/// The message for `key` with `{{name}}` filled from `params`.
pub fn t_with(key: &str, params: &[(&str, &str)]) -> String {
    init().t_with(key, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator(active: &[(&str, &str)], source: &[(&str, &str)]) -> Translator {
        let build = |pairs: &[(&str, &str)]| -> Catalog { pairs.iter().map(|p| (p.0.to_string(), p.1.to_string())).collect() };
        Translator { language: "fr", active: build(active), source: build(source) }
    }

    #[test]
    fn looks_up_in_the_language() {
        let tr = translator(&[("a.b", "Bonjour")], &[("a.b", "Hello")]);
        assert_eq!(tr.t("a.b"), "Bonjour");
    }

    #[test]
    fn falls_back_to_english_then_to_the_key() {
        let tr = translator(&[("empty", "")], &[("only.en", "Only English"), ("empty", "Was empty")]);
        assert_eq!(tr.t("only.en"), "Only English");
        assert_eq!(tr.t("empty"), "Was empty", "an empty value is not translated");
        assert_eq!(tr.t("nope.nothing"), "nope.nothing");
    }

    #[test]
    fn substitutes_params() {
        let tr = translator(&[], &[("quit", "Quit {{app}}"), ("two", "{{a}} then {{b}} then {{a}}")]);
        assert_eq!(tr.t_with("quit", &[("app", "Kiln")]), "Quit Kiln");
        assert_eq!(tr.t_with("two", &[("a", "1"), ("b", "2")]), "1 then 2 then 1");
    }

    #[test]
    fn leaves_unknown_and_unclosed_placeholders_and_does_not_rescan_values() {
        assert_eq!(interpolate("Hi {{who}}", &[]), "Hi {{who}}");
        assert_eq!(interpolate("Hi {{who", &[("who", "x")]), "Hi {{who");
        assert_eq!(interpolate("{{a}}", &[("a", "{{b}}"), ("b", "no")]), "{{b}}");
        assert_eq!(interpolate("Bonjour à tous — {{a}}", &[("a", "é")]), "Bonjour à tous — é");
    }

    #[test]
    fn matches_the_system_language() {
        assert_eq!(match_language(&["fr-FR", "en-US"]), "fr");
        assert_eq!(match_language(&["fr_CA.UTF-8"]), "fr");
        assert_eq!(match_language(&["es-419"]), "es");
        assert_eq!(match_language(&["DE_de@euro"]), "de");
        assert_eq!(match_language(&["ja-JP", "de-DE"]), "de", "the first language that has a catalog wins");
        assert_eq!(match_language(&["en-GB", "fr-FR"]), "en", "the first preference decides, even when it is English");
        assert_eq!(match_language(&["C", "POSIX", ""]), "en");
        assert_eq!(match_language(&["ja-JP"]), "en");
        assert_eq!(match_language::<&str>(&[]), "en");
    }

    #[test]
    fn reads_apple_languages_output() {
        assert_eq!(parse_apple_languages("(\n    \"fr-FR\",\n    \"en-US\"\n)\n"), vec!["fr-FR", "en-US"]);
        assert_eq!(parse_apple_languages("(\n    en,\n    de\n)\n"), vec!["en", "de"]);
        assert!(parse_apple_languages("").is_empty());
    }

    #[test]
    fn unknown_language_gets_english() {
        let tr = Translator::for_language("xx");
        assert_eq!(tr.language(), "en");
        assert_eq!(tr.t_with("menu.quit", &[("app", "Kiln")]), "Quit Kiln");
    }

    fn placeholders(text: &str) -> Vec<String> {
        let mut names: Vec<String> = text.split("{{").skip(1).filter_map(|part| part.find("}}").map(|end| part[..end].to_string())).collect();
        names.sort();
        names
    }

    #[test]
    fn every_catalog_is_valid_and_matches_english() {
        let english: Catalog = serde_json::from_str(catalog_text("en")).expect("en.json is valid JSON");
        assert!(!english.is_empty());
        for entry in CATALOGS.iter() {
            let catalog: Catalog = serde_json::from_str(entry.1).unwrap_or_else(|e| panic!("{}.json is not valid: {e}", entry.0));
            for (key, value) in &catalog {
                let source = english.get(key).unwrap_or_else(|| panic!("{}.json has {key}, which en.json lacks", entry.0));
                assert_eq!(placeholders(value), placeholders(source), "{}.json: placeholders of {key} differ from English", entry.0);
            }
        }
    }

    /// The literal keys passed to `t("…")` and `t_with("…", …)` in a source file.
    fn used_keys(source: &str) -> Vec<String> {
        let mut keys = Vec::new();
        for needle in ["t(\"", "t_with(\""] {
            for (at, _) in source.match_indices(needle) {
                let before = source[..at].chars().last();
                if before.map_or(false, |c| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let start = at + needle.len();
                if let Some(end) = source[start..].find('"') {
                    keys.push(source[start..start + end].to_string());
                }
            }
        }
        keys
    }

    #[test]
    fn every_key_the_shell_uses_is_in_english() {
        let english: Catalog = serde_json::from_str(catalog_text("en")).expect("en.json is valid JSON");
        for (file, source) in [("main.rs", include_str!("main.rs")), ("menu.rs", include_str!("menu.rs"))] {
            for key in used_keys(source) {
                assert!(english.contains_key(&key), "{file} uses {key}, which en.json lacks");
            }
        }
    }
}
