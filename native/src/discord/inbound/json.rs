//! `JSON.stringify` byte parity for the values intake serializes by hand.

use serde_json::Value;

/// Appends `JSON.stringify(text)` for a well-formed string.
pub(super) fn string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if u32::from(ch) < 0x20 => {
                use std::fmt::Write as _;
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{:04x}", u32::from(ch));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

/// `JSON.stringify(text)` as an owned string.
pub(super) fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    string(&mut out, text);
    out
}

/// ECMAScript `Number::toString` for a finite double (JSON never carries NaN or infinities).
pub(super) fn number(value: f64) -> String {
    if !value.is_finite() {
        // Non-finite numbers serialize as null and never arrive from parsed JSON.
        return "null".to_owned();
    }
    if value.classify() == std::num::FpCategory::Zero {
        // JSON.stringify(-0) is "0".
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        // Rust's Display is the shortest round-trip decimal without an exponent, like ECMAScript in this range.
        return format!("{value}");
    }
    let text = format!("{value:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `JSON.stringify` of one parsed JSON value. Scalars are exact; object key order follows `serde_json`'s map,
/// which only differs from ECMAScript insertion order for nested objects.
pub(super) fn value(out: &mut String, raw: Option<&Value>) {
    match raw {
        None | Some(Value::Null) => out.push_str("null"),
        Some(Value::Bool(flag)) => out.push_str(if *flag { "true" } else { "false" }),
        Some(Value::Number(n)) => match (n.as_u64(), n.as_i64(), n.as_f64()) {
            (Some(unsigned), _, _) => out.push_str(&unsigned.to_string()),
            (None, Some(signed), _) => out.push_str(&signed.to_string()),
            (None, None, Some(float)) => out.push_str(&number(float)),
            (None, None, None) => out.push_str("null"),
        },
        Some(Value::String(text)) => string(out, text),
        Some(Value::Array(items)) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                value(out, Some(item));
            }
            out.push(']');
        }
        Some(Value::Object(map)) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                string(out, key);
                out.push(':');
                value(out, Some(item));
            }
            out.push('}');
        }
    }
}

/// ECMAScript truthiness of an optional (undefined = `None`) JSON value.
pub(super) fn truthy(raw: Option<&Value>) -> bool {
    match raw {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n
            .as_f64()
            .is_some_and(|float| float.classify() != std::num::FpCategory::Zero),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// ECMAScript `===` between two optional JSON values from distinct parse paths (objects never alias).
pub(super) fn strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => match (a.as_u64(), b.as_u64()) {
            (Some(a), Some(b)) => a == b,
            _ => a
                .as_f64()
                .zip(b.as_f64())
                .is_some_and(|(a, b)| a.partial_cmp(&b) == Some(std::cmp::Ordering::Equal)),
        },
        _ => false,
    }
}

/// `typeof value === "number" && value === 0`.
pub(super) fn is_zero(raw: Option<&Value>) -> bool {
    is_number(raw, 0)
}

/// `typeof value === "number" && value === expected`.
pub(super) fn is_number(raw: Option<&Value>, expected: u32) -> bool {
    matches!(raw, Some(Value::Number(n)) if n
        .as_f64()
        .is_some_and(|float| float.partial_cmp(&f64::from(expected)) == Some(std::cmp::Ordering::Equal)))
}

/// `(ToInt32(flags) & bit) !== 0` for a bit below 2^31, without lossy casts.
pub(super) fn has_bit(raw: Option<&Value>, bit: u32) -> bool {
    let Some(Value::Number(n)) = raw else {
        return false;
    };
    let period = 2_u64 << bit;
    let half = 1_u64 << bit;
    if let Some(unsigned) = n.as_u64() {
        return unsigned % period >= half;
    }
    if let Some(signed) = n.as_i64() {
        let period = i64::try_from(period).unwrap_or(i64::MAX);
        let half = i64::try_from(half).unwrap_or(i64::MAX);
        return signed.rem_euclid(period) >= half;
    }
    let Some(float) = n.as_f64().filter(|float| float.is_finite()) else {
        return false;
    };
    let period = f64::from(2_u32 << bit.min(30));
    float.trunc().rem_euclid(period) >= period / 2.0
}

/// `Number.isSafeInteger(value)` and its exact integer.
pub(super) fn safe_integer(raw: Option<&Value>) -> Option<i64> {
    const MAX: i64 = (1 << 53) - 1;
    let Some(Value::Number(n)) = raw else {
        return None;
    };
    if let Some(signed) = n.as_i64() {
        return (-MAX..=MAX).contains(&signed).then_some(signed);
    }
    let float = n.as_f64()?;
    if !float.is_finite() || float.fract().abs() > 0.0 || float.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    format!("{float:.0}").parse().ok()
}
