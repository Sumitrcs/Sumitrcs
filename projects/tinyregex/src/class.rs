//! Character classes like `[a-z0-9_]`, `[^"]` and `\d`.
//!
//! A class is stored as a sorted list of non-overlapping code-point ranges,
//! so checking a character is a binary search, no matter how many ranges.
//! `\d`, `\w` and `\s` use their ASCII meanings, as in most grep tools.

use std::fmt;

const MAX_CHAR: u32 = char::MAX as u32;

#[derive(Debug, Clone, Copy)]
pub enum ClassKind {
    Digit,
    Word,
    Space,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Class {
    /// Sorted, merged, inclusive ranges.
    ranges: Vec<(u32, u32)>,
    negated: bool,
}

impl Class {
    pub fn empty() -> Self {
        Class {
            ranges: Vec::new(),
            negated: false,
        }
    }

    pub fn of(kind: ClassKind, negated: bool) -> Self {
        let mut class = Class::empty();
        let ranges: &[(char, char)] = match kind {
            ClassKind::Digit => &[('0', '9')],
            ClassKind::Word => &[('0', '9'), ('A', 'Z'), ('_', '_'), ('a', 'z')],
            ClassKind::Space => &[('\t', '\r'), (' ', ' ')], // \t \n \v \f \r and space
        };
        for &(lo, hi) in ranges {
            class.add_range(lo, hi);
        }
        class.negated = negated;
        class
    }

    pub fn add_range(&mut self, lo: char, hi: char) {
        self.insert(lo as u32, hi as u32);
    }

    /// Adds every character `other` matches (used for `[\d_]`, `[^\s,]`, ...).
    pub fn add_class(&mut self, other: &Class) {
        for (lo, hi) in other.positive_ranges() {
            self.insert(lo, hi);
        }
    }

    pub fn negate(&mut self) {
        self.negated = !self.negated;
    }

    /// Does the class match `c`? With `fold`, a letter also matches its
    /// other case: `[a-c]` matches `B`, and `[^a]` does not match `A`.
    pub fn matches(&self, c: char, fold: bool) -> bool {
        let hit = self.contains(c) || (fold && case_variants(c).any(|v| self.contains(v)));
        hit != self.negated
    }

    fn contains(&self, c: char) -> bool {
        let c = c as u32;
        // Find the last range starting at or before c, then check its end.
        let i = self.ranges.partition_point(|&(lo, _)| lo <= c);
        i > 0 && self.ranges[i - 1].1 >= c
    }

    /// Insert a range, keeping the list sorted and merging neighbours, so
    /// `[a-cb-ex]` is stored as a-e, x.
    fn insert(&mut self, lo: u32, hi: u32) {
        let i = self
            .ranges
            .partition_point(|&(_, h)| h.saturating_add(1) < lo);
        let mut lo = lo;
        let mut hi = hi;
        let mut j = i;
        while j < self.ranges.len() && self.ranges[j].0 <= hi.saturating_add(1) {
            lo = lo.min(self.ranges[j].0);
            hi = hi.max(self.ranges[j].1);
            j += 1;
        }
        self.ranges.splice(i..j, [(lo, hi)]);
    }

    /// The ranges this class matches, with any negation applied.
    fn positive_ranges(&self) -> Vec<(u32, u32)> {
        if !self.negated {
            return self.ranges.clone();
        }
        let mut out = Vec::new();
        let mut next = 0;
        for &(lo, hi) in &self.ranges {
            if lo > next {
                out.push((next, lo - 1));
            }
            next = hi + 1;
        }
        if next <= MAX_CHAR {
            out.push((next, MAX_CHAR));
        }
        out
    }
}

/// The simple upper- and lower-case forms of `c` (only one-character mappings,
/// so `ß` does not turn into `SS`).
pub fn case_variants(c: char) -> impl Iterator<Item = char> {
    fn single(mut it: impl Iterator<Item = char>) -> Option<char> {
        let first = it.next()?;
        it.next().is_none().then_some(first)
    }
    [single(c.to_lowercase()), single(c.to_uppercase())]
        .into_iter()
        .flatten()
        .filter(move |&v| v != c)
}

impl fmt::Display for Class {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let show = |f: &mut fmt::Formatter<'_>, c: u32| match char::from_u32(c) {
            Some(c) if c.is_ascii_graphic() && !"\\]-^".contains(c) => write!(f, "{c}"),
            Some(c) if c.is_ascii_graphic() => write!(f, "\\{c}"),
            _ => write!(f, "\\x{{{c:X}}}"),
        };
        write!(f, "[{}", if self.negated { "^" } else { "" })?;
        for &(lo, hi) in &self.ranges {
            show(f, lo)?;
            if hi > lo {
                write!(f, "-")?;
                show(f, hi)?;
            }
        }
        write!(f, "]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn class(ranges: &[(char, char)]) -> Class {
        let mut c = Class::empty();
        for &(lo, hi) in ranges {
            c.add_range(lo, hi);
        }
        c
    }

    #[test]
    fn ranges_are_merged() {
        let c = class(&[('x', 'x'), ('a', 'c'), ('b', 'e'), ('f', 'f')]);
        assert_eq!(
            c.ranges,
            vec![('a' as u32, 'f' as u32), ('x' as u32, 'x' as u32)]
        );
        assert_eq!(c.to_string(), "[a-fx]");
    }

    #[test]
    fn membership() {
        let c = class(&[('a', 'f'), ('0', '9')]);
        for ch in ['a', 'f', '0', '5', '9'] {
            assert!(c.matches(ch, false), "{ch}");
        }
        for ch in ['g', 'A', '/', ':', ' '] {
            assert!(!c.matches(ch, false), "{ch}");
        }
    }

    #[test]
    fn negation_and_case_folding() {
        let mut c = class(&[('a', 'a')]);
        c.negate();
        assert!(c.matches('A', false));
        assert!(!c.matches('A', true));
        assert!(class(&[('a', 'c')]).matches('B', true));
        assert!(class(&[('é', 'é')]).matches('É', true));
    }

    #[test]
    fn negated_shortcut_inside_brackets() {
        // [\D] must hold everything except digits, including far-away code points.
        let mut c = Class::empty();
        c.add_class(&Class::of(ClassKind::Digit, true));
        assert!(c.matches('x', false) && c.matches('😀', false));
        assert!(!c.matches('7', false));
    }
}
