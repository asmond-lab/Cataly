use std::borrow::Cow;

pub const LIMIT: usize = 2_000;

/// Splits at UTF-16 boundaries, borrowing unchanged text and balancing a fence at each cut.
pub fn partition(mut text: &str) -> Vec<Cow<'_, str>> {
    let mut parts = Vec::new();
    let mut reopen: Option<&str> = None;
    let mut remaining = text.encode_utf16().count();
    while remaining + prefix_width(reopen) > LIMIT {
        let capacity = LIMIT - prefix_width(reopen);
        let mut budget = capacity;
        let (at, open, close) = loop {
            let at = cut_at(text, budget);
            let part = &text[..at];
            let open = fence(part, reopen);
            // Move an opening marker with no code yet to the next message.
            if let Some((_, Some(marker))) = open {
                let line = part[..marker].rfind('\n').map_or(0, |index| index + 1);
                if line > 0
                    && line < at
                    && part[marker..]
                        .split_once('\n')
                        .is_none_or(|(_, body)| body.trim().is_empty())
                {
                    budget = part[..line].encode_utf16().count();
                    continue;
                }
            }
            let close =
                if open.is_some() && part.bytes().all(|byte| byte == b'`') && reopen.is_none() {
                    // An indivisible marker longer than a message is sent as literal chunks.
                    ""
                } else if open.is_some() {
                    if part.ends_with('\n') { "```" } else { "\n```" }
                } else {
                    ""
                };
            if part.encode_utf16().count() + close.len() > capacity {
                budget = budget.saturating_sub(close.len());
                continue;
            }
            break (at, open, close);
        };
        let (part, rest) = text.split_at(at);
        if !part.trim().is_empty() || reopen.is_some() {
            parts.push(with_fences(part, reopen, close));
        }
        text = rest;
        remaining -= part.encode_utf16().count();
        reopen = None;
        if let Some((language, _)) = open.filter(|_| !close.is_empty()) {
            let ticks = text.bytes().take_while(|&byte| byte == b'`').count();
            if ticks >= 3 {
                text = &text[ticks..];
                remaining -= ticks;
            } else {
                reopen = Some(language);
            }
        }
    }
    if !text.trim().is_empty() || reopen.is_some() {
        parts.push(with_fences(text, reopen, ""));
    }
    parts
}

fn cut_at(text: &str, budget: usize) -> usize {
    let mut width = 0;
    let mut at = text.len();
    let mut earliest = text.len();
    for (offset, ch) in text.char_indices() {
        width += ch.len_utf16();
        if width > budget && offset > 0 {
            at = offset;
            break;
        }
        if earliest == text.len() && width > budget / 2 {
            earliest = offset;
        }
    }
    let mut at = ["\n\n", "\n", " "]
        .iter()
        .find_map(|mark| {
            text[..at]
                .rfind(mark)
                .filter(|&index| index >= earliest)
                .map(|index| index + mark.len())
        })
        .unwrap_or(at);
    let bytes = text.as_bytes();
    if bytes.get(at) == Some(&b'`') {
        let end = at;
        while at > 0 && bytes[at - 1] == b'`' {
            at -= 1;
        }
        if at == 0 {
            return end;
        }
    }
    at
}

fn fence<'a>(text: &'a str, saved: Option<&'a str>) -> Option<(&'a str, Option<usize>)> {
    let mut open = saved.map(|language| (language, None));
    let mut at = 0;
    while let Some(offset) = text[at..].find('`') {
        let marker = at + offset;
        let width = text[marker..]
            .bytes()
            .take_while(|&byte| byte == b'`')
            .count();
        at = marker + width;
        if width >= 3 {
            open = if open.is_some() {
                None
            } else {
                let language = text[at..]
                    .split_once('\n')
                    .map_or("", |(line, _)| line.trim_end_matches('\r'));
                let language = if language.len() <= 32
                    && language
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_+-.#".contains(&byte))
                {
                    language
                } else {
                    ""
                };
                Some((language, Some(marker)))
            };
        }
    }
    open
}

const fn prefix_width(reopen: Option<&str>) -> usize {
    match reopen {
        Some(language) => 4 + language.len(),
        None => 0,
    }
}

fn with_fences<'a>(part: &'a str, reopen: Option<&str>, close: &str) -> Cow<'a, str> {
    match reopen {
        Some(language) => Cow::Owned(format!("```{language}\n{part}{close}")),
        None if close.is_empty() => Cow::Borrowed(part),
        None => Cow::Owned(format!("{part}{close}")),
    }
}
