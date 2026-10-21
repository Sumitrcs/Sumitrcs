//! Prices are stored as whole ticks of 0.01 (paise), and only converted to
//! and from text like "101.50" at the edges of the program.

use crate::book::Price;

/// "101.5" → 10150. At most two decimals; no sign, no exponent.
pub fn parse_price(s: &str) -> Result<Price, String> {
    let bad = || format!("not a price: {s:?} (write it like 101.50)");
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty()
        || s.ends_with('.')
        || frac.len() > 2
        || !(whole.bytes().chain(frac.bytes())).all(|b| b.is_ascii_digit())
    {
        return Err(bad());
    }
    let rupees: Price = whole.parse().map_err(|_| bad())?;
    let paise: Price = format!("{frac:0<2}").parse().map_err(|_| bad())?;
    rupees
        .checked_mul(100)
        .and_then(|r| r.checked_add(paise))
        .ok_or_else(bad)
}

/// 10150 → "101.50"
pub fn format_price(p: Price) -> String {
    format!("{}.{:02}", p / 100, p % 100)
}
