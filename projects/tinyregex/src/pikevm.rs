//! The matcher: a Pike VM.
//!
//! A backtracking matcher (what Perl, Python and JavaScript use) tries one
//! path through the program and backs up when it fails. On patterns like
//! `(a|a)*b` that can take exponential time. The Pike VM instead runs *every*
//! possible path at once, in lock-step, one input character at a time:
//!
//! 1. `clist` holds the threads (program counters) alive at the current position.
//! 2. Each thread that can consume the current character moves to `nlist`.
//! 3. Swap the lists and move to the next character.
//!
//! Two threads at the same program counter will behave identically from now on,
//! so we keep only the first (highest-priority) one. A list can therefore never
//! hold more threads than the program has instructions, and the whole search is
//! O(text length × program length) — linear in the text, always.
//!
//! Each thread carries its own copy of the capture slots, and threads are kept
//! in priority order, which gives the same leftmost-first answers as a
//! backtracking engine (`a|ab` on "ab" matches "a").

use crate::class::case_variants;
use crate::compile::{Inst, Program};
use crate::parse::Assertion;

/// Capture slot positions (byte offsets); `None` = group did not take part.
pub type Slots = Vec<Option<usize>>;

/// A set of program counters that remembers insertion order and can be
/// cleared in O(1): the "sparse set" trick from Briggs & Torczon.
#[derive(Debug)]
struct Threads {
    dense: Vec<usize>,
    sparse: Vec<usize>,
    /// Capture slots for each pc, `slots` entries per instruction.
    caps: Vec<Option<usize>>,
    slots: usize,
}

impl Threads {
    fn new(insts: usize, slots: usize) -> Self {
        Threads {
            dense: Vec::with_capacity(insts),
            sparse: vec![0; insts],
            caps: vec![None; insts * slots],
            slots,
        }
    }

    fn contains(&self, pc: usize) -> bool {
        let i = self.sparse[pc];
        i < self.dense.len() && self.dense[i] == pc
    }

    fn insert(&mut self, pc: usize) {
        self.sparse[pc] = self.dense.len();
        self.dense.push(pc);
    }

    fn caps(&self, pc: usize) -> &[Option<usize>] {
        &self.caps[pc * self.slots..(pc + 1) * self.slots]
    }

    fn caps_mut(&mut self, pc: usize) -> &mut [Option<usize>] {
        &mut self.caps[pc * self.slots..(pc + 1) * self.slots]
    }

    fn clear(&mut self) {
        self.dense.clear();
    }
}

/// Work items for `add_thread`. Using our own stack instead of recursion means
/// a pattern like `(((a)))...` nested a thousand deep can't overflow the call stack.
#[derive(Debug)]
enum Job {
    Visit(usize),
    /// Undo a `Save` once everything reachable after it has been visited.
    Restore {
        slot: usize,
        old: Option<usize>,
    },
}

#[derive(Debug)]
pub struct Vm {
    clist: Threads,
    nlist: Threads,
    stack: Vec<Job>,
    caps: Slots,
}

impl Vm {
    pub fn new(prog: &Program) -> Self {
        let n = prog.insts.len();
        Vm {
            clist: Threads::new(n, prog.slots),
            nlist: Threads::new(n, prog.slots),
            stack: Vec::new(),
            caps: vec![None; prog.slots],
        }
    }

    /// Finds the leftmost-first match in `text` that starts at or after byte
    /// offset `start`, returning its capture slots.
    pub fn search(&mut self, prog: &Program, text: &str, start: usize) -> Option<Slots> {
        self.clist.clear();
        self.nlist.clear();
        let mut matched: Option<Slots> = None;
        let mut pos = start;

        loop {
            // Start a new thread here, unless a match was already found:
            // any match starting later would not be leftmost.
            if matched.is_none() {
                self.caps.fill(None);
                add_thread(
                    prog,
                    &mut self.clist,
                    &mut self.stack,
                    &mut self.caps,
                    0,
                    text,
                    pos,
                );
            } else if self.clist.dense.is_empty() {
                break;
            }

            let c = text[pos..].chars().next();
            let next = pos + c.map_or(0, char::len_utf8);

            for i in 0..self.clist.dense.len() {
                let pc = self.clist.dense[i];
                let step = match (&prog.insts[pc], c) {
                    (Inst::Match, _) => {
                        // Highest-priority match so far. Threads after this one
                        // in clist have lower priority, so drop them.
                        matched = Some(self.clist.caps(pc)[..prog.capture_slots].to_vec());
                        break;
                    }
                    (Inst::Char(want), Some(c)) => {
                        c == *want
                            || (prog.flags.case_insensitive && case_variants(c).any(|v| v == *want))
                    }
                    (Inst::Any { newline }, Some(c)) => *newline || c != '\n',
                    (Inst::Class(class), Some(c)) => class.matches(c, prog.flags.case_insensitive),
                    _ => false,
                };
                if step {
                    self.caps.copy_from_slice(self.clist.caps(pc));
                    add_thread(
                        prog,
                        &mut self.nlist,
                        &mut self.stack,
                        &mut self.caps,
                        pc + 1,
                        text,
                        next,
                    );
                }
            }

            std::mem::swap(&mut self.clist, &mut self.nlist);
            self.nlist.clear();
            if c.is_none() {
                break;
            }
            pos = next;
        }
        matched
    }
}

/// Follows every `Jmp`, `Split`, `Save` and `Assert` reachable from `pc`
/// (none of them consume input) and adds the instructions they lead to.
fn add_thread(
    prog: &Program,
    list: &mut Threads,
    stack: &mut Vec<Job>,
    caps: &mut [Option<usize>],
    pc: usize,
    text: &str,
    pos: usize,
) {
    stack.push(Job::Visit(pc));
    while let Some(job) = stack.pop() {
        let pc = match job {
            Job::Restore { slot, old } => {
                caps[slot] = old;
                continue;
            }
            Job::Visit(pc) => pc,
        };
        if list.contains(pc) {
            continue;
        }
        list.insert(pc);
        match &prog.insts[pc] {
            Inst::Jmp(target) => stack.push(Job::Visit(*target)),
            Inst::Split(first, second) => {
                // A stack is last-in-first-out, so push the low-priority side first.
                stack.push(Job::Visit(*second));
                stack.push(Job::Visit(*first));
            }
            Inst::Save(slot) => {
                stack.push(Job::Restore {
                    slot: *slot,
                    old: caps[*slot],
                });
                caps[*slot] = Some(pos);
                stack.push(Job::Visit(pc + 1));
            }
            Inst::Progress { mark, again, done } => {
                let moved = caps[*mark] != Some(pos);
                stack.push(Job::Visit(if moved { *again } else { *done }));
            }
            Inst::Assert(a) => {
                if assertion_holds(*a, text, pos, prog.flags.multi_line) {
                    stack.push(Job::Visit(pc + 1));
                }
            }
            // Char, Any, Class and Match wait in the list for the next step.
            _ => list.caps_mut(pc).copy_from_slice(caps),
        }
    }
}

fn assertion_holds(a: Assertion, text: &str, pos: usize, multi_line: bool) -> bool {
    let before = text[..pos].chars().next_back();
    let after = text[pos..].chars().next();
    let is_word = |c: Option<char>| c.is_some_and(|c| c == '_' || c.is_ascii_alphanumeric());
    match a {
        Assertion::StartLine => before.is_none() || (multi_line && before == Some('\n')),
        Assertion::EndLine => after.is_none() || (multi_line && after == Some('\n')),
        Assertion::WordBoundary => is_word(before) != is_word(after),
        Assertion::NotWordBoundary => is_word(before) == is_word(after),
    }
}
