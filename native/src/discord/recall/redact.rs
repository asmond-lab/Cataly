//! Credential masking, a hand-compiled port of `SECRETS` in recall-text.ts. Each matcher is the leftmost
//! JavaScript match of one pattern at position `i`; the patterns are applied in order, each replacing globally.
//! Where a pattern's greedy quantifier is followed by a character outside its class, backtracking can never
//! succeed, so "the maximal run" is the exact regex result; each matcher notes that reasoning where it applies.

/// JavaScript `\s` (and the set `String.prototype.trim` removes): `char::is_whitespace` differs at U+0085/U+FEFF.
pub(super) const fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Non-unicode-mode `\w`, which decides `\b`.
const fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` at `i`: exactly one side is a word character; outside the text counts as non-word.
pub(super) fn boundary(text: &[char], i: usize) -> bool {
    let before = i
        .checked_sub(1)
        .and_then(|at| text.get(at))
        .is_some_and(|&c| word(c));
    let after = text.get(i).is_some_and(|&c| word(c));
    before != after
}

pub(super) fn run(text: &[char], i: usize, class: impl Fn(char) -> bool) -> usize {
    text.get(i..)
        .map_or(0, |rest| rest.iter().take_while(|&&c| class(c)).count())
}

pub(super) fn starts(text: &[char], i: usize, literal: &str) -> bool {
    let mut at = i..;
    literal
        .chars()
        .all(|expected| at.next().and_then(|at| text.get(at)) == Some(&expected))
}

/// Non-unicode `/i` folds only ASCII letters onto the ASCII pattern (non-ASCII never canonicalizes to ASCII).
pub(super) fn starts_ci(text: &[char], i: usize, literal: &str) -> bool {
    let mut at = i..;
    literal.chars().all(|expected| {
        at.next()
            .and_then(|at| text.get(at))
            .is_some_and(|c| c.eq_ignore_ascii_case(&expected))
    })
}

fn collect(text: &[char], from: usize, to: usize) -> String {
    text[from..to].iter().collect()
}

type Matcher = fn(&[char], usize) -> Option<(usize, String)>;

const MASK: &str = "[redacted]";

const SECRETS: [Matcher; 10] = [
    private_key,
    telegram,
    slack,
    openai,
    github,
    cloud,
    jwt,
    discord_token,
    authorization,
    assignment,
];

/// `redactText`: every pattern in order, each a global `String.prototype.replace`.
pub(super) fn redact(text: &str) -> String {
    let mut out = text.to_owned();
    for matcher in SECRETS {
        out = replace_all(&out, matcher);
    }
    out
}

fn replace_all(text: &str, matcher: Matcher) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if let Some((end, replacement)) = matcher(&chars, i) {
            out.push_str(&replacement);
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// `[A-Z ]*PRIVATE KEY-----` right after `start`: the class excludes `-`, so the class run must end in
/// `PRIVATE KEY` and be followed by `-----`. Returns the end of the dashes.
fn key_label(text: &[char], start: usize) -> Option<usize> {
    let end = start + run(text, start, |c| c.is_ascii_uppercase() || c == ' ');
    (end - start >= 11 && starts(text, end - 11, "PRIVATE KEY") && starts(text, end, "-----"))
        .then_some(end + 5)
}

/// `/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g`
fn private_key(text: &[char], i: usize) -> Option<(usize, String)> {
    if !starts(text, i, "-----BEGIN ") {
        return None;
    }
    let mut at = key_label(text, i + 11)?;
    // The lazy body stops at the first END marker; without one, `$` takes the rest of the text.
    while at < text.len() {
        if starts(text, at, "-----END ")
            && let Some(end) = key_label(text, at + 9)
        {
            return Some((end, MASK.into()));
        }
        at += 1;
    }
    Some((text.len(), MASK.into()))
}

const fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `/\b\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g`: the digits must be the whole digit run (`:` follows),
/// and the lookahead makes the token run exactly 35.
fn telegram(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    let digits = run(text, i, |c| c.is_ascii_digit());
    if !(8..=10).contains(&digits) || text.get(i + digits) != Some(&':') {
        return None;
    }
    let start = i + digits + 1;
    (run(text, start, token_char) == 35).then(|| (start + 35, MASK.into()))
}

/// `/\b(?:xox[abeposr]|xapp)-[A-Za-z0-9-]{8,}/g`
fn slack(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    let prefixed = (starts(text, i, "xox")
        && text.get(i + 3).is_some_and(|c| "abeposr".contains(*c)))
        || starts(text, i, "xapp");
    if !prefixed || text.get(i + 4) != Some(&'-') {
        return None;
    }
    let length = run(text, i + 5, |c| c.is_ascii_alphanumeric() || c == '-');
    (length >= 8).then(|| (i + 5 + length, MASK.into()))
}

/// `/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g`
fn openai(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) || !(starts(text, i, "sk-") || starts(text, i, "rk-")) {
        return None;
    }
    let length = run(text, i + 3, token_char);
    (length >= 16).then(|| (i + 3 + length, MASK.into()))
}

/// `/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g`
fn github(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    if starts(text, i, "gh")
        && text.get(i + 2).is_some_and(|c| "pousr".contains(*c))
        && text.get(i + 3) == Some(&'_')
    {
        let length = run(text, i + 4, |c| c.is_ascii_alphanumeric());
        return (length >= 20).then(|| (i + 4 + length, MASK.into()));
    }
    if starts(text, i, "github_pat_") {
        let length = run(text, i + 11, word);
        return (length >= 20).then(|| (i + 11 + length, MASK.into()));
    }
    None
}

/// `/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g`
fn cloud(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    if starts(text, i, "AKIA") {
        let length = run(text, i + 4, |c| {
            c.is_ascii_digit() || c.is_ascii_uppercase()
        });
        return (length >= 16).then(|| (i + 20, MASK.into()));
    }
    if starts(text, i, "AIza") {
        let length = run(text, i + 4, token_char);
        return (length >= 30).then(|| (i + 4 + length, MASK.into()));
    }
    None
}

/// `/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g`: `.` is outside the class, so each
/// segment is a whole class run.
fn jwt(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) || !starts(text, i, "eyJ") {
        return None;
    }
    let mut at = i + 3;
    for index in 0..3 {
        let length = run(text, at, token_char);
        if length < 8 {
            return None;
        }
        at += length;
        if index < 2 {
            if text.get(at) != Some(&'.') {
                return None;
            }
            at += 1;
        }
    }
    Some((at, MASK.into()))
}

/// `/\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g`: `.` follows each bounded segment and
/// is outside the class, so the first run must be 24..=28 long and the second exactly 6.
fn discord_token(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    let first = run(text, i, token_char);
    if !(24..=28).contains(&first) || text.get(i + first) != Some(&'.') {
        return None;
    }
    let second = i + first + 1;
    if run(text, second, token_char) != 6 || text.get(second + 6) != Some(&'.') {
        return None;
    }
    let third = second + 7;
    let length = run(text, third, token_char);
    (length >= 27).then(|| (third + length, MASK.into()))
}

/// `/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi` → `$1 [redacted]`
fn authorization(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    let scheme = if starts_ci(text, i, "bearer") {
        6
    } else if starts_ci(text, i, "basic") {
        5
    } else {
        return None;
    };
    let spaces = run(text, i + scheme, js_space);
    if spaces == 0 {
        return None;
    }
    let start = i + scheme + spaces;
    let length = run(text, start, |c| {
        c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
    });
    (length >= 12).then(|| {
        (
            start + length,
            format!("{} {MASK}", collect(text, i, i + scheme)),
        )
    })
}

/// `api[_-]?key`: the optional separator is tried first, as the greedy `?` does.
fn api_key(text: &[char], i: usize) -> Option<usize> {
    if !starts_ci(text, i, "api") {
        return None;
    }
    if text.get(i + 3).is_some_and(|c| *c == '_' || *c == '-') && starts_ci(text, i + 4, "key") {
        return Some(7);
    }
    starts_ci(text, i + 3, "key").then_some(6)
}

/// `/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi` → `$1$2[redacted]`. The alternatives
/// are mutually exclusive at one position, and `\s*` before `[:=]`/`\S+` can only be the whole space run.
fn assignment(text: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(text, i) {
        return None;
    }
    let name = ["password", "passwd", "secret", "token"]
        .into_iter()
        .find(|name| starts_ci(text, i, name))
        .map(str::len)
        .or_else(|| api_key(text, i))?;
    let operator = i + name + run(text, i + name, js_space);
    if !text.get(operator).is_some_and(|c| *c == ':' || *c == '=') {
        return None;
    }
    let value = operator + 1 + run(text, operator + 1, js_space);
    let length = run(text, value, |c| !js_space(c));
    (length > 0).then(|| {
        (
            value + length,
            format!(
                "{}{}{MASK}",
                collect(text, i, i + name),
                collect(text, i + name, value)
            ),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::redact;

    // Vectors from skills/cataly-mode/scripts/test/recall-text.test.ts, "stored text masks credential shapes" and
    // "Telegram bot tokens ending in %s", plus one hand-evaluated case per remaining pattern.
    #[test]
    fn masks_credential_shapes_like_recall_text() {
        let secrets = [
            concat!("xo", "xb-", "1234567890", "-abcdefghijkl"),
            "sk-proj-abcdefghijklmnopqrstuvwx",
            "ghp_abcdefghijklmnopqrstuvwxyz0123",
            "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqqr",
        ];
        let stored = redact(&format!(
            "keys {} password=hunter2 Authorization: Bearer abcdefghijklmnop",
            secrets.join(" ")
        ));
        for secret in secrets.iter().chain(&["hunter2", "abcdefghijklmnop"]) {
            assert!(!stored.contains(secret), "{stored}");
        }
        assert!(stored.contains("password=[redacted]"));
        assert!(stored.contains("Bearer [redacted]"));
        for ending in ['A', '9', '_', '-'] {
            let token = format!("123456789:{}{ending}", "x".repeat(34));
            assert_eq!(
                redact(&format!("before ({token}) after {token}")),
                "before ([redacted]) after [redacted]"
            );
        }
        // A 36-character tail fails the lookahead; a preceding word character fails `\b`.
        let long = format!("123456789:{}", "x".repeat(36));
        assert_eq!(redact(&long), long);
        assert_eq!(redact("TOKEN : abc def"), "TOKEN : [redacted] def");
        assert_eq!(redact("tokens=abc"), "tokens=abc");
        assert_eq!(redact("api-KEY=1"), "api-KEY=[redacted]");
        assert_eq!(
            redact(concat!(
                "x -----BEGIN RSA PRIVATE ",
                "KEY-----\nabc\n-----END RSA PRIVATE ",
                "KEY----- y"
            )),
            "x [redacted] y"
        );
        assert_eq!(redact("-----BEGIN PRIVATE KEY-----abc"), "[redacted]");
        assert_eq!(redact("AKIAABCDEFGHIJKLMNOPQR"), "[redacted]QR");
        assert_eq!(redact("eyJabcdefgh.abcdefgh.abcdefgh!"), "[redacted]!");
        assert_eq!(
            redact(&format!("{}.abcdef.{}", "a".repeat(24), "b".repeat(27))),
            "[redacted]"
        );
        assert_eq!(redact("basic\tQWxhZGRpbjpvcGVu"), "basic [redacted]");
    }
}
