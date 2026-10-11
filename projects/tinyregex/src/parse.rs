//! Pattern text → syntax tree.
//!
//! A hand-written recursive-descent parser. Each grammar rule is one method:
//!
//! ```text
//! alternation := concat ('|' concat)*
//! concat      := repeat*
//! repeat      := atom quantifier?
//! quantifier  := ('*' | '+' | '?' | '{m}' | '{m,}' | '{m,n}') '?'?
//! atom        := literal | '.' | '^' | '$' | class | escape | '(' alternation ')'
//! ```

use crate::Error;
use crate::class::{Class, ClassKind};

/// The most a counted repetition like `a{n}` may ask for. Every copy becomes
/// real instructions, so this keeps a typo like `a{99999}` from eating memory.
pub const MAX_REPEAT: u32 = 1000;

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    /// Matches the empty string (e.g. the right side of `a|`).
    Empty,
    Literal(char),
    /// `.`
    AnyChar,
    Class(Class),
    Assert(Assertion),
    Concat(Vec<Node>),
    Alternate(Vec<Node>),
    Repeat {
        node: Box<Node>,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    /// A parenthesised group. `index` is `None` for `(?:...)`.
    Group {
        node: Box<Node>,
        index: Option<usize>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Assertion {
    /// `^`
    StartLine,
    /// `$`
    EndLine,
    /// `\b`
    WordBoundary,
    /// `\B`
    NotWordBoundary,
}

/// Options that change how the pattern behaves, set with `(?ims)` at the very start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Flags {
    /// `i`: letters match either case.
    pub case_insensitive: bool,
    /// `m`: `^` and `$` also match next to `\n`.
    pub multi_line: bool,
    /// `s`: `.` also matches `\n`.
    pub dot_matches_newline: bool,
}

#[derive(Debug)]
pub struct Parsed {
    pub node: Node,
    pub flags: Flags,
    /// Number of capture groups, not counting the implicit group 0.
    pub groups: usize,
    /// `names[i]` is the name of group `i` (group 0 never has one).
    pub names: Vec<Option<String>>,
}

pub fn parse(pattern: &str) -> Result<Parsed, Error> {
    let mut p = Parser {
        chars: pattern.chars().collect(),
        pos: 0,
        groups: 0,
        names: vec![None],
    };
    let flags = p.leading_flags()?;
    let node = p.alternation()?;
    if p.pos < p.chars.len() {
        // The only way alternation() stops early is an unmatched ')'.
        return Err(p.error("unmatched ')'"));
    }
    Ok(Parsed {
        node,
        flags,
        groups: p.groups,
        names: p.names,
    })
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
    groups: usize,
    names: Vec<Option<String>>,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        Some(c)
    }

    fn error(&self, message: &str) -> Error {
        Error {
            message: message.to_string(),
            position: self.pos,
        }
    }

    fn error_at(&self, position: usize, message: &str) -> Error {
        Error {
            message: message.to_string(),
            position,
        }
    }

    /// `(?i)`, `(?ms)`, ... — only allowed as the first thing in the pattern.
    fn leading_flags(&mut self) -> Result<Flags, Error> {
        let mut flags = Flags::default();
        if !(self.peek() == Some('(') && self.peek_at(1) == Some('?')) {
            return Ok(flags);
        }
        // Look ahead: is this a flag group, or (?: / (?< / (?P< ?
        let mut i = self.pos + 2;
        while let Some(&c) = self.chars.get(i) {
            if !"ims".contains(c) {
                break;
            }
            i += 1;
        }
        if i == self.pos + 2 || self.chars.get(i) != Some(&')') {
            return Ok(flags);
        }
        for &c in &self.chars[self.pos + 2..i] {
            match c {
                'i' => flags.case_insensitive = true,
                'm' => flags.multi_line = true,
                _ => flags.dot_matches_newline = true,
            }
        }
        self.pos = i + 1;
        Ok(flags)
    }

    fn alternation(&mut self) -> Result<Node, Error> {
        let mut branches = vec![self.concat()?];
        while self.eat('|') {
            branches.push(self.concat()?);
        }
        Ok(if branches.len() == 1 {
            branches.pop().unwrap()
        } else {
            Node::Alternate(branches)
        })
    }

    fn concat(&mut self) -> Result<Node, Error> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            items.push(self.repeat()?);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Concat(items),
        })
    }

    fn repeat(&mut self) -> Result<Node, Error> {
        let start = self.pos;
        let atom = self.atom()?;
        let Some((min, max)) = self.quantifier()? else {
            return Ok(atom);
        };
        if matches!(atom, Node::Assert(_)) {
            return Err(self.error_at(start, "an anchor like ^, $ or \\b cannot be repeated"));
        }
        let greedy = !self.eat('?');
        if matches!(self.peek(), Some('*' | '+' | '?')) || self.counted_repeat_ahead() {
            return Err(
                self.error("two quantifiers in a row; wrap the first in (?:...) if you mean it")
            );
        }
        Ok(Node::Repeat {
            node: Box::new(atom),
            min,
            max,
            greedy,
        })
    }

    /// Reads `*`, `+`, `?` or `{m,n}` if one is next.
    fn quantifier(&mut self) -> Result<Option<(u32, Option<u32>)>, Error> {
        let q = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') if self.counted_repeat_ahead() => return self.counted_repeat().map(Some),
            _ => return Ok(None),
        };
        self.pos += 1;
        Ok(Some(q))
    }

    /// Like most engines, a `{` that does not start `{m}`, `{m,}` or `{m,n}`
    /// is just a literal brace, so `{}` and `a{x}` still work.
    fn counted_repeat_ahead(&self) -> bool {
        if self.peek() != Some('{') {
            return false;
        }
        let rest: String = self.chars[self.pos + 1..]
            .iter()
            .take_while(|&&c| c != '}')
            .collect();
        if self.pos + 1 + rest.len() >= self.chars.len() {
            return false; // no closing brace
        }
        let (lo, hi) = rest.split_once(',').unwrap_or((&rest, &rest));
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        digits(lo) && (hi.is_empty() || digits(hi))
    }

    fn counted_repeat(&mut self) -> Result<(u32, Option<u32>), Error> {
        let start = self.pos;
        self.pos += 1; // '{'
        let min = self.number().unwrap();
        let max = if self.eat(',') {
            self.number()
        } else {
            Some(min)
        };
        self.pos += 1; // '}'
        if min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT) {
            return Err(self.error_at(
                start,
                &format!("repetition count is larger than {MAX_REPEAT}"),
            ));
        }
        if max.is_some_and(|m| m < min) {
            return Err(self.error_at(start, "in {m,n}, n must not be smaller than m"));
        }
        Ok((min, max))
    }

    /// A run of ASCII digits. Numbers too big for u32 come back as u32::MAX,
    /// which the caller then rejects as too large.
    fn number(&mut self) -> Option<u32> {
        let begin = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        if begin == self.pos {
            return None;
        }
        let text: String = self.chars[begin..self.pos].iter().collect();
        Some(text.parse().unwrap_or(u32::MAX))
    }

    fn atom(&mut self) -> Result<Node, Error> {
        let start = self.pos;
        if self.counted_repeat_ahead() {
            return Err(self.error("nothing to repeat before this quantifier"));
        }
        let c = self
            .next()
            .expect("concat() only calls atom() when input remains");
        Ok(match c {
            '.' => Node::AnyChar,
            '^' => Node::Assert(Assertion::StartLine),
            '$' => Node::Assert(Assertion::EndLine),
            '[' => Node::Class(self.class()?),
            '(' => self.group()?,
            '\\' => self.escape(false)?,
            '*' | '+' | '?' => {
                return Err(self.error_at(start, "nothing to repeat before this quantifier"));
            }
            c => Node::Literal(c),
        })
    }

    fn group(&mut self) -> Result<Node, Error> {
        let open = self.pos - 1;
        let mut name = None;
        let capturing = if self.eat('?') {
            if self.eat(':') {
                false
            } else if self.eat('<') || (self.eat('P') && self.eat('<')) {
                name = Some(self.group_name()?);
                true
            } else if self.peek().is_some_and(|c| "ims".contains(c)) {
                return Err(self
                    .error("flags like (?i) are only supported at the very start of the pattern"));
            } else {
                return Err(
                    self.error("unknown group type; use (?:...), (?<name>...) or (?P<name>...)")
                );
            }
        } else {
            true
        };

        let index = if capturing {
            self.groups += 1;
            self.names.push(name);
            Some(self.groups)
        } else {
            None
        };
        let node = self.alternation()?;
        if !self.eat(')') {
            return Err(self.error_at(open, "unclosed '('"));
        }
        Ok(Node::Group {
            node: Box::new(node),
            index,
        })
    }

    fn group_name(&mut self) -> Result<String, Error> {
        let start = self.pos;
        let mut name = String::new();
        while let Some(c) = self.next() {
            if c == '>' {
                let valid_start = name
                    .chars()
                    .next()
                    .is_some_and(|c| c == '_' || c.is_ascii_alphabetic());
                if !valid_start || !name.chars().all(|c| c == '_' || c.is_ascii_alphanumeric()) {
                    return Err(self.error_at(
                        start,
                        "group names must be letters, digits or _, and not start with a digit",
                    ));
                }
                if self.names.iter().flatten().any(|n| *n == name) {
                    return Err(self.error_at(start, &format!("duplicate group name '{name}'")));
                }
                return Ok(name);
            }
            name.push(c);
        }
        Err(self.error_at(start, "group name is missing its closing '>'"))
    }

    /// Everything after a `\`. Inside `[...]` some escapes mean something else
    /// (`\b` is a backspace there), so the caller says where we are.
    fn escape(&mut self, in_class: bool) -> Result<Node, Error> {
        let start = self.pos - 1;
        let Some(c) = self.next() else {
            return Err(self.error_at(start, "pattern ends with a lone backslash"));
        };
        Ok(match c {
            'd' => Node::Class(Class::of(ClassKind::Digit, false)),
            'D' => Node::Class(Class::of(ClassKind::Digit, true)),
            'w' => Node::Class(Class::of(ClassKind::Word, false)),
            'W' => Node::Class(Class::of(ClassKind::Word, true)),
            's' => Node::Class(Class::of(ClassKind::Space, false)),
            'S' => Node::Class(Class::of(ClassKind::Space, true)),
            'b' if in_class => Node::Literal('\u{8}'),
            'b' => Node::Assert(Assertion::WordBoundary),
            'B' if !in_class => Node::Assert(Assertion::NotWordBoundary),
            'n' => Node::Literal('\n'),
            't' => Node::Literal('\t'),
            'r' => Node::Literal('\r'),
            'f' => Node::Literal('\u{c}'),
            'v' => Node::Literal('\u{b}'),
            '0' => Node::Literal('\0'),
            'x' => Node::Literal(self.hex_escape(start)?),
            c if c.is_ascii_alphanumeric() => {
                return Err(self.error_at(start, &format!("unknown escape \\{c}")));
            }
            // Any punctuation can be escaped to make it literal: \. \* \\ \( ...
            c => Node::Literal(c),
        })
    }

    /// `\x41` or `\x{1F600}`.
    fn hex_escape(&mut self, start: usize) -> Result<char, Error> {
        let digits: String = if self.eat('{') {
            let mut s = String::new();
            loop {
                match self.next() {
                    Some('}') => break,
                    Some(c) => s.push(c),
                    None => return Err(self.error_at(start, "\\x{ is missing its closing '}'")),
                }
            }
            s
        } else {
            (0..2).filter_map(|_| self.next()).collect()
        };
        u32::from_str_radix(&digits, 16)
            .ok()
            .filter(|_| !digits.is_empty() && digits.len() <= 6)
            .and_then(char::from_u32)
            .ok_or_else(|| self.error_at(start, "invalid \\x escape; use \\x41 or \\x{1F600}"))
    }

    /// The inside of `[...]`, after the `[`.
    fn class(&mut self) -> Result<Class, Error> {
        let open = self.pos - 1;
        let negated = self.eat('^');
        let mut class = Class::empty();
        let mut first = true;
        loop {
            let Some(c) = self.peek() else {
                return Err(self.error_at(open, "unclosed '['"));
            };
            // A ']' right after '[' or '[^' is a literal, so []] and [^]] work.
            if c == ']' && !first {
                self.pos += 1;
                break;
            }
            first = false;

            let lo = match self.class_item()? {
                Item::Char(ch) => ch,
                Item::Set(set) => {
                    class.add_class(&set);
                    continue;
                }
            };
            // A range like a-z, unless the '-' is the last thing before ']'.
            if self.peek() == Some('-') && self.peek_at(1).is_some_and(|c| c != ']') {
                let dash = self.pos;
                self.pos += 1;
                let hi = match self.class_item()? {
                    Item::Char(ch) => ch,
                    Item::Set(_) => {
                        return Err(self.error_at(dash, "a range cannot end in a class like \\d"));
                    }
                };
                if hi < lo {
                    return Err(self.error_at(dash, &format!("range {lo}-{hi} is backwards")));
                }
                class.add_range(lo, hi);
            } else {
                class.add_range(lo, lo);
            }
        }
        if negated {
            class.negate();
        }
        Ok(class)
    }

    fn class_item(&mut self) -> Result<Item, Error> {
        let c = self.next().ok_or_else(|| self.error("unclosed '['"))?;
        if c != '\\' {
            return Ok(Item::Char(c));
        }
        match self.escape(true)? {
            Node::Literal(ch) => Ok(Item::Char(ch)),
            Node::Class(set) => Ok(Item::Set(set)),
            _ => Err(self.error_at(self.pos - 2, "this escape is not allowed inside [...]")),
        }
    }
}

enum Item {
    Char(char),
    Set(Class),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(pattern: &str) -> String {
        parse(pattern).unwrap_err().to_string()
    }

    #[test]
    fn precedence() {
        // ab|c means (ab)|c, and a* binds tighter than concatenation.
        let p = parse("ab*|c").unwrap();
        let Node::Alternate(branches) = p.node else {
            panic!()
        };
        assert_eq!(branches[1], Node::Literal('c'));
        let Node::Concat(items) = &branches[0] else {
            panic!()
        };
        assert_eq!(items[0], Node::Literal('a'));
        assert!(matches!(
            items[1],
            Node::Repeat {
                min: 0,
                max: None,
                greedy: true,
                ..
            }
        ));
    }

    #[test]
    fn groups_are_numbered_by_opening_paren() {
        let p = parse("((a)(?:b)(?<last>c))").unwrap();
        assert_eq!(p.groups, 3);
        assert_eq!(p.names, vec![None, None, None, Some("last".to_string())]);
    }

    #[test]
    fn counted_repeats() {
        assert!(matches!(
            parse("a{2,5}?").unwrap().node,
            Node::Repeat {
                min: 2,
                max: Some(5),
                greedy: false,
                ..
            }
        ));
        assert!(matches!(
            parse("a{3,}").unwrap().node,
            Node::Repeat {
                min: 3,
                max: None,
                ..
            }
        ));
        // Not a valid repetition, so these are literal braces.
        assert!(matches!(parse("a{x}").unwrap().node, Node::Concat(_)));
        assert!(matches!(parse("{}").unwrap().node, Node::Concat(_)));
    }

    #[test]
    fn flags() {
        let p = parse("(?is)x").unwrap();
        assert!(p.flags.case_insensitive && p.flags.dot_matches_newline && !p.flags.multi_line);
        assert_eq!(p.node, Node::Literal('x'));
    }

    #[test]
    fn helpful_errors() {
        assert_eq!(err("a)"), "unmatched ')' at position 1");
        assert_eq!(err("(ab"), "unclosed '(' at position 0");
        assert_eq!(err("[a-"), "unclosed '[' at position 0");
        assert_eq!(
            err("*a"),
            "nothing to repeat before this quantifier at position 0"
        );
        assert_eq!(
            err("a**"),
            "two quantifiers in a row; wrap the first in (?:...) if you mean it at position 2"
        );
        assert_eq!(err("[z-a]"), "range z-a is backwards at position 2");
        assert_eq!(
            err("a{5,2}"),
            "in {m,n}, n must not be smaller than m at position 1"
        );
        assert_eq!(
            err("a{1001}"),
            "repetition count is larger than 1000 at position 1"
        );
        assert_eq!(err("\\q"), "unknown escape \\q at position 0");
        assert_eq!(
            err("abc\\"),
            "pattern ends with a lone backslash at position 3"
        );
        assert_eq!(
            err("(?<1x>a)"),
            "group names must be letters, digits or _, and not start with a digit at position 3"
        );
        assert_eq!(
            err("^*"),
            "an anchor like ^, $ or \\b cannot be repeated at position 0"
        );
    }
}
