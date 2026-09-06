//! Chinese word segmentation for word navigation.
//!
//! The frontend walks an editor line and stops at word boundaries produced
//! by the configured engine (see src/word-nav.ts). This module exposes
//! jieba-rs over IPC as an alternative to the WebView's built-in
//! Intl.Segmenter:
//!   - "standard" -> TokenizeMode::Default (dictionary words; HMM covers
//!     out-of-vocabulary runs like person names and new words);
//!   - "fine"     -> TokenizeMode::Search (additionally stops inside long
//!     words, e.g. 中华人民共和国 -> 中华 | 人民 | 共和 | ...).
//!
//! Ranges are reported in UTF-16 code units, the unit JS/CodeMirror uses.
//! The dictionary is embedded in the binary (jieba-rs `default-dict`
//! feature, on by default), so the app stays a single portable exe.
//! It is loaded once on a background thread at startup; until it is ready
//! `segment_text` returns `None` and the frontend falls back to
//! Intl.Segmenter for that keystroke.

use jieba_rs::{Jieba, TokenizeMode};
use serde::Serialize;

/// A word-like span of a line, as UTF-16 code-unit offsets into the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SegRange {
    pub start: u32,
    pub end: u32,
}

/// Engine instance. The dictionary load takes a few hundred milliseconds,
/// so it happens exactly once, on a background thread (see `warm_up`).
static JIEBA: std::sync::OnceLock<Jieba> = std::sync::OnceLock::new();

/// Start loading the embedded dictionary on a background thread so the
/// first word-navigation keystroke never blocks on initialization.
/// Returns immediately; `segment_text` reports `None` until ready.
pub fn warm_up() {
    let _ = std::thread::spawn(|| {
        let _ = JIEBA.get_or_init(Jieba::new);
    });
}

/// UTF-16 code-unit length of `s`.
fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

/// Whether a token should act as a navigation stop. Mirrors the frontend's
/// notion of a "word-like" segment: keep tokens containing letters, digits,
/// CJK ideographs, kana or Hangul; drop pure punctuation/symbol tokens
/// (，、😀…) so they never create stops on their own.
fn is_wordish(word: &str) -> bool {
    word.chars().any(|c| {
        c.is_alphanumeric()
            || matches!(
                c,
                '\u{2E80}'..='\u{2EFF}'     // CJK radicals
                | '\u{3040}'..='\u{30FF}'   // kana
                | '\u{31C0}'..='\u{31EF}'   // CJK strokes
                | '\u{3400}'..='\u{4DBF}'   // CJK extension A
                | '\u{4E00}'..='\u{9FFF}'   // CJK unified ideographs
                | '\u{F900}'..='\u{FAFF}'   // CJK compatibility
                | '\u{FF66}'..='\u{FF9F}'   // halfwidth katakana
                | '\u{AC00}'..='\u{D7AF}'   // Hangul syllables
                | '\u{20000}'..='\u{2FA1F}' // CJK extension B and beyond
            )
    })
}

/// Split `text` into word-like spans using `jieba`. With `fine` = true,
/// Search mode additionally yields shorter sub-word spans (overlapping
/// tokens are fine: the frontend only reads segment starts as stop points).
fn ranges_with(jieba: &Jieba, text: &str, fine: bool) -> Vec<SegRange> {
    let mode = if fine { TokenizeMode::Search } else { TokenizeMode::Default };
    let mut out = Vec::new();
    for tok in jieba.tokenize(text, mode, true) {
        if !is_wordish(tok.word) {
            continue;
        }
        // byte offsets from jieba -> UTF-16 code-unit offsets for the frontend.
        let start = utf16_len(&text[..tok.byte_start]);
        let end = start + utf16_len(tok.word);
        out.push(SegRange { start, end });
    }
    out
}

/// Segment a line with the global engine. `None` while the dictionary is
/// still warming up (caller falls back to Intl.Segmenter for that keystroke).
pub fn segment_text(text: &str, mode: &str) -> Option<Vec<SegRange>> {
    let jieba = JIEBA.get()?;
    Some(ranges_with(jieba, text, mode == "fine"))
}

/// Tauri IPC entry: called by the frontend for the current editor line.
#[tauri::command]
pub fn segment_line(text: String, mode: String) -> Option<Vec<SegRange>> {
    segment_text(&text, &mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    /// Tests share one engine instance: each Jieba::new() reloads the
    /// embedded dictionary (~hundreds of ms), so build it once.
    static TEST_JIEBA: OnceLock<Jieba> = OnceLock::new();
    fn test_jieba() -> &'static Jieba {
        TEST_JIEBA.get_or_init(Jieba::new)
    }

    fn segs(text: &str, fine: bool) -> Vec<(u32, u32)> {
        ranges_with(test_jieba(), text, fine)
            .into_iter()
            .map(|r| (r.start, r.end))
            .collect()
    }

    #[test]
    fn standard_cuts_dictionary_words() {
        // Golden on the jieba-rs 0.10.3 embedded dictionary. Note the older
        // jieba README example (我们/中/出/了/一个/叛徒) predates 中出 being
        // in the word list; the actual dictionary merges it.
        assert_eq!(
            segs("我们中出了一个叛徒", false),
            vec![(0, 2), (2, 4), (4, 5), (5, 7), (7, 9)]
        );
    }

    #[test]
    fn ambiguous_phrase_splits_on_real_words() {
        // 研究生命科学 -> 研究/生命科学: 生命科学 is one dictionary word, so
        // navigation stops at its edges, never mid-character.
        assert_eq!(segs("研究生命科学", false), vec![(0, 2), (2, 6)]);
    }

    #[test]
    fn punctuation_is_not_a_stop() {
        // 标点 token (，) is filtered out; 世界 starts right after it.
        assert_eq!(segs("你好，世界", false), vec![(0, 2), (3, 5)]);
        assert_eq!(segs("你好，世界", true), vec![(0, 2), (3, 5)]);
    }

    #[test]
    fn fine_mode_adds_stops_inside_long_words() {
        let standard = segs("中华人民共和国", false);
        let fine = segs("中华人民共和国", true);
        assert!(fine.len() > standard.len(), "fine={fine:?} standard={standard:?}");
        // Search mode yields dictionary sub-words 中华 and 人民 inside the run.
        assert!(fine.contains(&(0, 2)), "fine={fine:?}");
        assert!(fine.contains(&(2, 4)), "fine={fine:?}");
        // Standard mode keeps the whole run as one segment.
        assert_eq!(standard, vec![(0, 7)]);
    }

    #[test]
    fn mixed_chinese_latin_text() {
        // 很好 has no dictionary entry, so it stays two single-char words;
        // weather is one Latin run and one navigation stop.
        assert_eq!(
            segs("今天weather很好", false),
            vec![(0, 2), (2, 9), (9, 10), (10, 11)]
        );
    }

    #[test]
    fn ranges_are_utf16_code_units() {
        // 😀 (U+1F600) is two UTF-16 units: 世界 starts at 4, ends at 6.
        assert_eq!(segs("你好😀世界", false), vec![(0, 2), (4, 6)]);
    }
}
