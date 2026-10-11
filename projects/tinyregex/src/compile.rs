//! Syntax tree → a small program for the matching VM (Thompson's construction).
//!
//! The program is a list of instructions. Most of them check one character;
//! `Split` and `Jmp` are how choice and looping are expressed:
//!
//! ```text
//! a|b      0 split 1, 3        a*      0 split 1, 3
//!          1 char 'a'                  1 char 'a'
//!          2 jmp 4                     2 jmp 0
//!          3 char 'b'                  3 ...
//!          4 ...
//! ```
//!
//! `split x, y` means "try x first, then y". That order is what makes `a*`
//! greedy and `a*?` lazy: the lazy version is the same code with the two
//! targets swapped.

use std::fmt;

use crate::Error;
use crate::class::Class;
use crate::parse::{Assertion, Flags, Node, Parsed};

/// Upper limit on program size, so `(a{1000}){1000}` is an error and not a
/// million-instruction program.
pub const MAX_INSTS: usize = 100_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Inst {
    Char(char),
    /// `.` — `newline` says whether it may match `\n` (the `s` flag).
    Any {
        newline: bool,
    },
    Class(Class),
    Assert(Assertion),
    /// Continue at both targets; the first has priority.
    Split(usize, usize),
    Jmp(usize),
    /// Record the current position in slot `n`. Group `g` uses slots `2g`
    /// for its start and `2g + 1` for its end; slots after the groups belong
    /// to loops (see `Progress`).
    Save(usize),
    /// End of one turn of a loop whose body can match nothing, like `(a|)*`.
    /// If the input moved since the turn began (recorded in slot `mark`), go
    /// round `again`; otherwise leave the loop at `done`. Without this check,
    /// an empty turn would just stop the thread; with it, we get the same
    /// answers as Perl, Python and JavaScript.
    Progress {
        mark: usize,
        again: usize,
        done: usize,
    },
    Match,
}

#[derive(Debug, Clone)]
pub struct Program {
    pub insts: Vec<Inst>,
    /// Slots each thread carries: capture slots first, then loop marks.
    pub slots: usize,
    /// How many of `slots` are capture slots (2 per group, group 0 included).
    pub capture_slots: usize,
    pub flags: Flags,
}

pub fn compile(parsed: &Parsed) -> Result<Program, Error> {
    let capture_slots = 2 * (parsed.groups + 1);
    let mut c = Compiler {
        insts: Vec::new(),
        flags: parsed.flags,
        slots: capture_slots,
    };
    c.push(Inst::Save(0))?;
    c.node(&parsed.node)?;
    c.push(Inst::Save(1))?;
    c.push(Inst::Match)?;
    Ok(Program {
        insts: c.insts,
        slots: c.slots,
        capture_slots,
        flags: parsed.flags,
    })
}

struct Compiler {
    insts: Vec<Inst>,
    flags: Flags,
    slots: usize,
}

impl Compiler {
    fn push(&mut self, inst: Inst) -> Result<usize, Error> {
        if self.insts.len() >= MAX_INSTS {
            return Err(Error {
                message: format!(
                    "pattern is too large (more than {MAX_INSTS} instructions after expanding repetitions)"
                ),
                position: 0,
            });
        }
        self.insts.push(inst);
        Ok(self.insts.len() - 1)
    }

    fn here(&self) -> usize {
        self.insts.len()
    }

    /// Fill in the targets of a `Split` we emitted before we knew them.
    fn patch_split(&mut self, at: usize, first: usize, second: usize) {
        self.insts[at] = Inst::Split(first, second);
    }

    fn node(&mut self, node: &Node) -> Result<(), Error> {
        match node {
            Node::Empty => {}
            Node::Literal(c) => {
                self.push(Inst::Char(*c))?;
            }
            Node::AnyChar => {
                self.push(Inst::Any {
                    newline: self.flags.dot_matches_newline,
                })?;
            }
            Node::Class(class) => {
                self.push(Inst::Class(class.clone()))?;
            }
            Node::Assert(a) => {
                self.push(Inst::Assert(*a))?;
            }
            Node::Concat(items) => {
                for item in items {
                    self.node(item)?;
                }
            }
            Node::Alternate(branches) => {
                // split L1, next; L1: branch; jmp end; next: split L2, ...; last branch; end:
                let mut jumps = Vec::new();
                for (i, branch) in branches.iter().enumerate() {
                    if i + 1 == branches.len() {
                        self.node(branch)?;
                        break;
                    }
                    let split = self.push(Inst::Split(0, 0))?;
                    self.node(branch)?;
                    jumps.push(self.push(Inst::Jmp(0))?);
                    let next = self.here();
                    self.patch_split(split, split + 1, next);
                }
                let end = self.here();
                for j in jumps {
                    self.insts[j] = Inst::Jmp(end);
                }
            }
            Node::Group { node, index } => match index {
                Some(i) => {
                    self.push(Inst::Save(2 * i))?;
                    self.node(node)?;
                    self.push(Inst::Save(2 * i + 1))?;
                }
                None => self.node(node)?,
            },
            Node::Repeat {
                node,
                min,
                max,
                greedy,
            } => self.repeat(node, *min, *max, *greedy)?,
        }
        Ok(())
    }

    fn repeat(
        &mut self,
        node: &Node,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    ) -> Result<(), Error> {
        // Order the two ways out of a Split: "do it again" first if greedy.
        let order = |again: usize, done: usize| if greedy { (again, done) } else { (done, again) };

        match max {
            // A loop whose body can match the empty string needs the progress
            // check: min copies, then
            //   L: split B, E; B: save mark; x; progress mark ? L : E; E:
            None if nullable(node) => {
                for _ in 0..min {
                    self.node(node)?;
                }
                let mark = self.slots;
                self.slots += 1;
                let split = self.push(Inst::Split(0, 0))?;
                self.push(Inst::Save(mark))?;
                self.node(node)?;
                let progress = self.push(Inst::Progress {
                    mark,
                    again: split,
                    done: 0,
                })?;
                let end = self.here();
                self.insts[progress] = Inst::Progress {
                    mark,
                    again: split,
                    done: end,
                };
                let (a, b) = order(split + 1, end);
                self.patch_split(split, a, b);
            }
            // x{min,}: min-1 plain copies, then one copy that loops back to itself.
            //   L: x; split L, next
            None if min > 0 => {
                for _ in 1..min {
                    self.node(node)?;
                }
                let start = self.here();
                self.node(node)?;
                let split = self.push(Inst::Split(0, 0))?;
                let (a, b) = order(start, split + 1);
                self.patch_split(split, a, b);
            }
            // x*:  L: split body, end; body: x; jmp L; end:
            None => {
                let split = self.push(Inst::Split(0, 0))?;
                self.node(node)?;
                self.push(Inst::Jmp(split))?;
                let end = self.here();
                let (a, b) = order(split + 1, end);
                self.patch_split(split, a, b);
            }
            // x{min,max}: min copies, then (max - min) optional copies that all
            // jump to the same end when skipped: x x (x (x)?)?
            Some(max) => {
                for _ in 0..min {
                    self.node(node)?;
                }
                let mut splits = Vec::new();
                for _ in min..max {
                    splits.push(self.push(Inst::Split(0, 0))?);
                    self.node(node)?;
                }
                let end = self.here();
                for split in splits {
                    let (a, b) = order(split + 1, end);
                    self.patch_split(split, a, b);
                }
            }
        }
        Ok(())
    }
}

/// Can `node` match the empty string?
fn nullable(node: &Node) -> bool {
    match node {
        Node::Empty | Node::Assert(_) => true,
        Node::Literal(_) | Node::AnyChar | Node::Class(_) => false,
        Node::Concat(items) => items.iter().all(nullable),
        Node::Alternate(branches) => branches.iter().any(nullable),
        Node::Repeat { node, min, .. } => *min == 0 || nullable(node),
        Node::Group { node, .. } => nullable(node),
    }
}

impl fmt::Display for Program {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (pc, inst) in self.insts.iter().enumerate() {
            write!(f, "{pc:>4}  ")?;
            match inst {
                Inst::Char(c) => writeln!(f, "char {c:?}")?,
                Inst::Any { newline: true } => writeln!(f, "any")?,
                Inst::Any { newline: false } => writeln!(f, "any except \\n")?,
                Inst::Class(c) => writeln!(f, "class {c}")?,
                Inst::Assert(a) => writeln!(f, "assert {a:?}")?,
                Inst::Split(a, b) => writeln!(f, "split {a}, {b}")?,
                Inst::Jmp(a) => writeln!(f, "jmp {a}")?,
                Inst::Save(n) => writeln!(f, "save {n}")?,
                Inst::Progress { mark, again, done } => {
                    writeln!(f, "progress since {mark}? {again} : {done}")?
                }
                Inst::Match => writeln!(f, "match")?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse;

    fn program(pattern: &str) -> String {
        compile(&parse(pattern).unwrap()).unwrap().to_string()
    }

    #[test]
    fn alternation_and_star() {
        assert_eq!(
            program("a|b*"),
            "   0  save 0\n   1  split 2, 4\n   2  char 'a'\n   3  jmp 7\n   4  split 5, 7\n   5  char 'b'\n   6  jmp 4\n   7  save 1\n   8  match\n"
        );
    }

    #[test]
    fn lazy_swaps_split_order() {
        assert!(program("a+").contains("split 1, 3"));
        assert!(program("a+?").contains("split 3, 1"));
    }

    #[test]
    fn counted_repeat_expands() {
        // a{2,3}: two copies, then one optional copy.
        assert_eq!(
            program("a{2,3}"),
            "   0  save 0\n   1  char 'a'\n   2  char 'a'\n   3  split 4, 5\n   4  char 'a'\n   5  save 1\n   6  match\n"
        );
    }

    #[test]
    fn loops_that_can_match_nothing_get_a_progress_check() {
        assert!(!program("a*").contains("progress"));
        assert!(program("(?:a|)*").contains("progress since 2? 1 : 7"));
    }

    #[test]
    fn huge_programs_are_rejected() {
        let err = compile(&parse("(?:a{1000}){1000}").unwrap()).unwrap_err();
        assert!(err.message.starts_with("pattern is too large"));
    }
}
