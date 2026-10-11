# tinyregex

[![CI](https://github.com/Sumitrcs/tinyregex/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/tinyregex/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A regular-expression engine written from scratch in Rust, in about 1,400 lines of readable code with **no dependencies**.
It parses the pattern, compiles it to a tiny virtual machine, and runs that machine as a **Pike VM**.
That means matching time is always **linear in the input**: the patterns that make other engines hang are not a problem here.

It comes with a small `grep` so you can use it right away.

```text
$ python3 -c "import re; re.match('(a|a)*b', 'a' * 26)"     # 6.08 s  (backtracking)
$ echo aaaaaaaaaaaaaaaaaaaaaaaaaa | tinyregex '(a|a)*b'     # 0.003 s
$ # 1,000,000 a's:                                          # 0.11 s
```

## Features

- Literals, `.`, classes `[a-z]` `[^"]` `[\d.]`, and shortcuts `\d \w \s \D \W \S`
- Anchors `^ $`, word boundaries `\b \B`
- Alternation `|`, groups `( )`, non-capturing groups `(?: )`, named groups `(?<name> )`
- Repetition `* + ? {m} {m,} {m,n}`, plus lazy versions `*? +? ?? {m,n}?`
- Escapes `\n \t \r \x41 \x{1F600}`, and `\.` `\(` … for any punctuation
- Flags at the start of a pattern: `(?i)` ignore case, `(?m)` multi-line, `(?s)` `.` matches `\n`
- Full Unicode text: `.` matches a whole character, and offsets are byte offsets into your `&str`
- Error messages that point at the problem: `unclosed '(' at position 0`
- A `Regex` can be shared between threads

## Use it as a library

```rust
use tinyregex::Regex;

let re = Regex::new(r"(?<d>\d{2})/(?<m>\d{2})/(?<y>\d{4})").unwrap();

assert!(re.is_match("due 11/10/2026"));
assert_eq!(re.find("due 11/10/2026").unwrap().range(), 4..14);

let caps = re.captures("due 11/10/2026").unwrap();
assert_eq!(&caps["y"], "2026");

assert_eq!(re.replace_all("11/10/2026, 31/12/2026", "$y-$m-$d"), "2026-10-11, 2026-12-31");

let words: Vec<&str> = Regex::new(r"\w+").unwrap().find_iter("one, two").map(|m| m.as_str()).collect();
assert_eq!(words, ["one", "two"]);
assert_eq!(Regex::new(r"\s*,\s*").unwrap().split("a , b,c"), ["a", "b", "c"]);
```

## Use it as grep

```text
$ cargo install --path .
$ tinyregex -in '^error' app.log
2:ERROR disk /dev/sda1 is 97% full
4:error: retrying in 5s

$ tinyregex -o '[0-9]+(ms|s|%)' app.log
97%
2300ms
5s

$ tinyregex -c -v 'ERROR|WARN' app.log
2
```

Options: `-i` ignore case, `-v` invert, `-n` line numbers, `-c` count, `-o` only the matched part.
Exit status works like grep: `0` if something matched, `1` if nothing did, `2` on error.

## How it works

The engine works in three stages. Each stage is one file you can read on its own.

```text
"a(b|c)*d" ──parse.rs──▶ syntax tree ──compile.rs──▶ VM program ──pikevm.rs──▶ match
```

### 1. Parsing (`src/parse.rs`)

A **recursive-descent parser** turns the pattern into a tree. Each grammar rule is one function, and operator precedence comes from which function calls which:

```text
alternation := concat ('|' concat)*      ← lowest precedence: a|bc is a|(bc)
concat      := repeat*
repeat      := atom quantifier?          ← highest: ab* is a(b*)
atom        := literal | . | class | ( alternation ) | ...
```

Character classes (`src/class.rs`) are stored as sorted, merged ranges of code points, so `[a-cb-ex]` becomes `a-e, x`.
Checking a character is then a binary search.

### 2. Compiling (`src/compile.rs`)

The tree becomes a list of instructions for a very small machine.
You can see the program for any pattern with `--program`:

```text
$ tinyregex --program 'a(b|c)*d'
   0  save 0          ← match starts here
   1  char 'a'
   2  split 3, 10     ← loop: try another (b|c) first, else leave
   3  save 2          ← group 1 starts
   4  split 5, 7      ← b or c
   5  char 'b'
   6  jmp 8
   7  char 'c'
   8  save 3          ← group 1 ends
   9  jmp 2
  10  char 'd'
  11  save 1          ← match ends here
  12  match
```

`split x, y` means "continue at both x and y, but x has priority".
That priority is the only difference between greedy `*` and lazy `*?`: the lazy version swaps the two targets.

### 3. Matching (`src/pikevm.rs`)

A **backtracking** engine (Python, Perl, JavaScript, Java) follows one path through the program.
When that path fails, it goes back and tries the next one. For `(a|a)*b` there are 2ⁿ paths, and it tries them all.

The **Pike VM** follows *all* paths at the same time instead:

1. Keep a list of threads (program counters) that are alive at the current character.
2. Move every thread that accepts this character on to the next list.
3. Go to the next character and repeat.

The key trick: two threads at the same instruction behave identically from then on, so we keep only the first one.
A list can therefore never hold more threads than the program has instructions, and the work is at most *(text length × program length)*.

Threads are kept in priority order, so the answer is the same leftmost-first match a backtracking engine gives: `a|ab` on "ab" matches "a".
Each thread carries its own copy of the capture positions, and these are written by the `save` instructions.

## Compared with Python's `re`

During development I compared tinyregex with Python's `re` on 9,000 random patterns and texts.
Whole-match positions agreed in all but 2 of them. The known differences are:

- **`$`** matches only at the very end of the text, as in Rust and Go. In Python, `$` also matches just before a final `\n`.
- **Loops whose body can match nothing**, like `(a|)*`, use the same "stop after an empty turn" rule as backtracking engines.
  For some deeply nested patterns of this kind, though, a capture group may report a different (equally valid) position.
  The cause is that the VM keeps only one thread per instruction. RE2, Go and Rust's `regex` make the same trade-off for the same reason.
- No backreferences (`\1`) or lookaround (`(?=…)`). These need backtracking, and dropping them is what makes linear time possible.

## What you'll learn

- How a recursive-descent parser turns text into a tree, and how precedence falls out of the grammar
- Thompson's construction: turning `|`, `*` and groups into `split` and `jmp`
- Why backtracking can explode, and how simulating all paths at once avoids it
- The sparse-set trick for O(1) "clear" and "contains" (Briggs & Torczon)
- Using an explicit stack instead of recursion so deeply nested patterns can't overflow
- Rust practice: lifetimes on `Match<'t>`, `Index` for `caps["name"]`, iterators, and a reusable `Mutex` cache that keeps `Regex` `Sync`

## Try it yourself

1. **Counting threads.** Add a counter for how many threads were added during a search, and print it with `--stats`. Compare `a*b` with `(a|a)*b` as the input grows.
2. **Literal prefix skip.** If a pattern starts with a literal like `ERROR`, jump straight to its next occurrence with `str::find` instead of stepping one character at a time. Measure the speed-up on a large log.
3. **`\A` and `\z`.** Add anchors for the absolute start and end of the text that ignore `(?m)`.
4. **Colors.** Make the grep highlight matches in red when stdout is a terminal (`std::io::IsTerminal`).
5. **A DFA.** For patterns without capture groups, build a DFA lazily from the NFA states (the "subset construction"). Then compare its speed with the Pike VM.

## Run the tests

```bash
cargo test                       # 32 tests, including timing tests for evil patterns
cargo clippy --all-targets -- -D warnings
```

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
