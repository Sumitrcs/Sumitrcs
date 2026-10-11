//! tinyregex — a regular-expression engine built from scratch, in three stages:
//!
//! ```text
//! "a(b|c)*"  --parse-->  syntax tree  --compile-->  VM program  --run on text-->  match
//!            parse.rs                  compile.rs                pikevm.rs
//! ```
//!
//! The matcher is a Pike VM, so search time grows linearly with the input, even
//! for patterns that make backtracking engines hang.
//!
//! ```
//! use tinyregex::Regex;
//!
//! let re = Regex::new(r"(?<user>[\w.]+)@(?<host>[\w.]+)").unwrap();
//! let caps = re.captures("mail sumit@example.com today").unwrap();
//! assert_eq!(&caps["user"], "sumit");
//! assert_eq!(caps.get(2).unwrap().as_str(), "example.com");
//! ```

mod class;
mod compile;
mod parse;
mod pikevm;

use std::fmt;
use std::ops::{Index, Range};
use std::sync::{Arc, Mutex};

use compile::Program;
use pikevm::{Slots, Vm};

/// A pattern that failed to parse, with the character position of the problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub message: String,
    /// Position in the pattern, counted in characters (not bytes).
    pub position: usize,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at position {}", self.message, self.position)
    }
}

impl std::error::Error for Error {}

/// A compiled regular expression.
#[derive(Debug)]
pub struct Regex {
    pattern: String,
    program: Program,
    names: Arc<[Option<String>]>,
    /// The VM's thread lists, kept between searches so a loop over many lines
    /// does not allocate each time.
    vm_cache: Mutex<Option<Vm>>,
}

impl Clone for Regex {
    fn clone(&self) -> Self {
        Regex {
            pattern: self.pattern.clone(),
            program: self.program.clone(),
            names: self.names.clone(),
            vm_cache: Mutex::new(None),
        }
    }
}

impl Regex {
    /// Parses and compiles `pattern`.
    ///
    /// Supported syntax: literals, `.`, `[a-z]`, `[^...]`, `\d \w \s \D \W \S`,
    /// `\b \B`, `^ $`, `| ( ) (?: ) (?<name> )`, `* + ? {m} {m,} {m,n}` and
    /// their lazy forms (`*?` ...), escapes like `\n \t \x41 \x{1F600}`, and the
    /// flags `(?i)` case-insensitive, `(?m)` multi-line, `(?s)` dot-matches-newline
    /// at the very start of the pattern.
    pub fn new(pattern: &str) -> Result<Regex, Error> {
        let parsed = parse::parse(pattern)?;
        let program = compile::compile(&parsed)?;
        Ok(Regex {
            pattern: pattern.to_string(),
            program,
            names: parsed.names.into(),
            vm_cache: Mutex::new(None),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.pattern
    }

    /// The compiled VM program, one instruction per line — handy for learning
    /// what a pattern turns into.
    pub fn program(&self) -> String {
        self.program.to_string()
    }

    /// Number of capture groups, including group 0 (the whole match).
    pub fn captures_len(&self) -> usize {
        self.names.len()
    }

    /// Group names in order; `None` for unnamed groups (and group 0).
    pub fn capture_names(&self) -> impl Iterator<Item = Option<&str>> {
        self.names.iter().map(|n| n.as_deref())
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.search(text, 0).is_some()
    }

    /// The leftmost match in `text`.
    pub fn find<'t>(&self, text: &'t str) -> Option<Match<'t>> {
        self.find_at(text, 0)
    }

    /// The leftmost match that starts at or after byte offset `start`.
    /// Anchors and `\b` still see the text before `start`.
    pub fn find_at<'t>(&self, text: &'t str, start: usize) -> Option<Match<'t>> {
        let slots = self.search(text, start)?;
        Some(Match {
            text,
            start: slots[0]?,
            end: slots[1]?,
        })
    }

    /// Every non-overlapping match, left to right.
    pub fn find_iter<'r, 't>(&'r self, text: &'t str) -> Matches<'r, 't> {
        Matches {
            re: self,
            text,
            next: Some(0),
        }
    }

    /// The leftmost match and the text of each capture group.
    pub fn captures<'t>(&self, text: &'t str) -> Option<Captures<'t>> {
        let slots = self.search(text, 0)?;
        Some(Captures {
            text,
            slots,
            names: self.names.clone(),
        })
    }

    /// Captures for every non-overlapping match.
    pub fn captures_iter<'r, 't>(&'r self, text: &'t str) -> impl Iterator<Item = Captures<'t>> + 'r
    where
        't: 'r,
    {
        let mut next = Some(0);
        std::iter::from_fn(move || {
            let slots = self.search(text, next?)?;
            next = next_start(text, slots[0]?, slots[1]?);
            Some(Captures {
                text,
                slots,
                names: self.names.clone(),
            })
        })
    }

    /// Replaces every match. In `replacement`, `$1` / `${1}` is a group by
    /// number, `$name` / `${name}` a group by name, and `$$` a literal dollar sign.
    pub fn replace_all(&self, text: &str, replacement: &str) -> String {
        self.replace_n(text, replacement, usize::MAX)
    }

    /// Like `replace_all`, but only the first match.
    pub fn replace(&self, text: &str, replacement: &str) -> String {
        self.replace_n(text, replacement, 1)
    }

    fn replace_n(&self, text: &str, replacement: &str, limit: usize) -> String {
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for caps in self.captures_iter(text).take(limit) {
            let m = caps.get(0).unwrap();
            out.push_str(&text[last..m.start()]);
            caps.expand(replacement, &mut out);
            last = m.end();
        }
        out.push_str(&text[last..]);
        out
    }

    /// The pieces of `text` between matches.
    pub fn split<'t>(&self, text: &'t str) -> Vec<&'t str> {
        let mut pieces = Vec::new();
        let mut last = 0;
        for m in self.find_iter(text) {
            // An empty match at the very start or end would only add an empty piece.
            if m.is_empty() && (m.start() == 0 || m.start() == text.len()) {
                continue;
            }
            pieces.push(&text[last..m.start()]);
            last = m.end();
        }
        pieces.push(&text[last..]);
        pieces
    }

    fn search(&self, text: &str, start: usize) -> Option<Slots> {
        if start > text.len() {
            return None;
        }
        // If another thread is using the cached VM, just make a fresh one.
        let mut cache = self.vm_cache.try_lock().ok();
        let mut vm = cache
            .as_mut()
            .and_then(|c| c.take())
            .unwrap_or_else(|| Vm::new(&self.program));
        let result = vm.search(&self.program, text, start);
        if let Some(cache) = cache.as_mut() {
            **cache = Some(vm);
        }
        result
    }
}

impl fmt::Display for Regex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.pattern)
    }
}

impl std::str::FromStr for Regex {
    type Err = Error;
    fn from_str(s: &str) -> Result<Regex, Error> {
        Regex::new(s)
    }
}

/// Where the next search should begin after a match at `start..end`.
/// After an empty match we step over one character, or we would find the same
/// empty match forever.
fn next_start(text: &str, start: usize, end: usize) -> Option<usize> {
    if end > start {
        return Some(end);
    }
    let c = text[end..].chars().next()?;
    Some(end + c.len_utf8())
}

/// One match: a byte range of the searched text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match<'t> {
    text: &'t str,
    start: usize,
    end: usize,
}

impl<'t> Match<'t> {
    pub fn start(&self) -> usize {
        self.start
    }
    pub fn end(&self) -> usize {
        self.end
    }
    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }
    pub fn len(&self) -> usize {
        self.end - self.start
    }
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
    pub fn as_str(&self) -> &'t str {
        &self.text[self.start..self.end]
    }
}

pub struct Matches<'r, 't> {
    re: &'r Regex,
    text: &'t str,
    next: Option<usize>,
}

impl<'t> Iterator for Matches<'_, 't> {
    type Item = Match<'t>;

    fn next(&mut self) -> Option<Match<'t>> {
        let m = self.re.find_at(self.text, self.next?);
        self.next = m.and_then(|m| next_start(self.text, m.start, m.end));
        m
    }
}

/// The capture groups of one match. Index with a number or a name:
/// `&caps[1]`, `&caps["year"]` (panics if the group did not match).
#[derive(Debug, Clone)]
pub struct Captures<'t> {
    text: &'t str,
    slots: Slots,
    names: Arc<[Option<String>]>,
}

impl<'t> Captures<'t> {
    /// Group `i`, or `None` if it did not take part in the match
    /// (like the second group of `(a)|(b)` matching "a").
    pub fn get(&self, i: usize) -> Option<Match<'t>> {
        let start = (*self.slots.get(2 * i)?)?;
        let end = (*self.slots.get(2 * i + 1)?)?;
        Some(Match {
            text: self.text,
            start,
            end,
        })
    }

    pub fn name(&self, name: &str) -> Option<Match<'t>> {
        let i = self.names.iter().position(|n| n.as_deref() == Some(name))?;
        self.get(i)
    }

    /// Number of groups, including group 0.
    pub fn len(&self) -> usize {
        self.slots.len() / 2
    }

    pub fn is_empty(&self) -> bool {
        false // group 0 is always there
    }

    /// Appends `template` to `out`, replacing `$1`, `${1}`, `$name`, `${name}` and `$$`.
    /// Unknown groups become empty text.
    pub fn expand(&self, template: &str, out: &mut String) {
        let mut rest = template;
        while let Some(dollar) = rest.find('$') {
            out.push_str(&rest[..dollar]);
            rest = &rest[dollar + 1..];
            if let Some(after) = rest.strip_prefix('$') {
                out.push('$');
                rest = after;
            } else if let Some(braced) = rest.strip_prefix('{').and_then(|r| r.split_once('}')) {
                let (key, after) = braced;
                out.push_str(self.lookup(key));
                rest = after;
            } else {
                // The longest run of letters, digits and _ is the group, so
                // "$1st" means a group named "1st"; write "${1}st" for group 1.
                let len = rest
                    .bytes()
                    .take_while(|&b| b == b'_' || b.is_ascii_alphanumeric())
                    .count();
                if len == 0 {
                    out.push('$');
                } else {
                    out.push_str(self.lookup(&rest[..len]));
                    rest = &rest[len..];
                }
            }
        }
        out.push_str(rest);
    }

    fn lookup(&self, key: &str) -> &'t str {
        let m = match key.parse::<usize>() {
            Ok(i) => self.get(i),
            Err(_) => self.name(key),
        };
        m.map_or("", |m| m.as_str())
    }
}

impl Index<usize> for Captures<'_> {
    type Output = str;
    fn index(&self, i: usize) -> &str {
        self.get(i)
            .unwrap_or_else(|| panic!("group {i} did not match"))
            .as_str()
    }
}

impl Index<&str> for Captures<'_> {
    type Output = str;
    fn index(&self, name: &str) -> &str {
        self.name(name)
            .unwrap_or_else(|| panic!("no group named '{name}' matched"))
            .as_str()
    }
}
