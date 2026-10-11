//! `tinyregex` — a small grep built on the library.
//!
//!     tinyregex [-i] [-v] [-n] [-c] [-o] PATTERN [FILE...]
//!     tinyregex --program PATTERN
//!
//! Exit status follows grep: 0 if a line matched, 1 if none did, 2 on error.

use std::io::{self, BufWriter, Read, Write};
use std::process::ExitCode;

use tinyregex::Regex;

const USAGE: &str = "\
usage: tinyregex [OPTIONS] PATTERN [FILE...]
       tinyregex --program PATTERN

Print lines that match PATTERN. With no FILE, or FILE '-', read standard input.

options:
  -i            ignore case
  -v            print lines that do NOT match
  -n            prefix each line with its line number
  -c            print only a count of matching lines
  -o            print only the matched parts, one per line
  -h, --help    show this help
  --program     print the compiled VM program for PATTERN and exit";

#[derive(Default)]
struct Options {
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count: bool,
    only_matching: bool,
    show_program: bool,
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(message) => {
            eprintln!("tinyregex: {message}");
            ExitCode::from(2)
        }
    }
}

/// Returns whether any line matched.
fn run(args: Vec<String>) -> Result<bool, String> {
    let mut opts = Options::default();
    let mut positional = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(true);
            }
            "--program" => opts.show_program = true,
            "--" => {
                positional.extend(args.by_ref());
                break;
            }
            // Short flags can be combined: -in is -i -n.
            flags if flags.starts_with('-') && flags.len() > 1 => {
                for f in flags[1..].chars() {
                    match f {
                        'i' => opts.ignore_case = true,
                        'v' => opts.invert = true,
                        'n' => opts.line_numbers = true,
                        'c' => opts.count = true,
                        'o' => opts.only_matching = true,
                        _ => return Err(format!("unknown option -{f}\n\n{USAGE}")),
                    }
                }
            }
            _ => positional.push(arg),
        }
    }

    let mut positional = positional.into_iter();
    let pattern = positional.next().ok_or_else(|| USAGE.to_string())?;
    let files: Vec<String> = positional.collect();

    // Flags must come first in a pattern, and the user may already have some.
    let full_pattern = match (opts.ignore_case, pattern.strip_prefix("(?")) {
        (false, _) => pattern.clone(),
        (true, Some(rest)) if rest.starts_with(|c| "ims".contains(c)) => format!("(?i{rest}"),
        (true, _) => format!("(?i){pattern}"),
    };
    let re = Regex::new(&full_pattern).map_err(|e| format!("bad pattern '{pattern}': {e}"))?;

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    if opts.show_program {
        write!(out, "{}", re.program()).map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let inputs = if files.is_empty() {
        vec!["-".to_string()]
    } else {
        files
    };
    let show_names = inputs.len() > 1;
    let mut any = false;
    let mut failed = false;
    for name in &inputs {
        let text = match read_input(name) {
            Ok(text) => text,
            Err(e) => {
                eprintln!("tinyregex: {name}: {e}");
                failed = true;
                continue;
            }
        };
        let prefix = if show_names {
            format!("{name}:")
        } else {
            String::new()
        };
        match grep(&re, &text, &opts, &prefix, &mut out) {
            Ok(found) => any |= found,
            // The reader went away (e.g. `| head`): stop quietly, like grep.
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return Ok(any),
            Err(e) => return Err(e.to_string()),
        }
    }
    out.flush().ok();
    if failed && !any {
        return Err("no input could be read".to_string());
    }
    Ok(any)
}

fn read_input(name: &str) -> io::Result<String> {
    let mut bytes = Vec::new();
    if name == "-" {
        io::stdin().read_to_end(&mut bytes)?;
    } else {
        bytes = std::fs::read(name)?;
    }
    // Invalid UTF-8 (a stray Latin-1 byte, say) becomes U+FFFD instead of failing.
    Ok(String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

fn grep(
    re: &Regex,
    text: &str,
    opts: &Options,
    prefix: &str,
    out: &mut impl Write,
) -> io::Result<bool> {
    let mut count = 0;
    // `lines()` would also strip "\r" — keep the text exactly as it was.
    let body = text.strip_suffix('\n').unwrap_or(text);
    if text.is_empty() {
        return finish(count, opts, prefix, out);
    }
    for (i, line) in body.split('\n').enumerate() {
        let number = if opts.line_numbers {
            format!("{}:", i + 1)
        } else {
            String::new()
        };
        if opts.only_matching && !opts.invert {
            let mut found = false;
            for m in re.find_iter(line).filter(|m| !m.is_empty()) {
                found = true;
                if !opts.count {
                    writeln!(out, "{prefix}{number}{}", m.as_str())?;
                }
            }
            count += usize::from(found);
            continue;
        }
        if re.is_match(line) != opts.invert {
            count += 1;
            if !opts.count {
                writeln!(out, "{prefix}{number}{line}")?;
            }
        }
    }
    finish(count, opts, prefix, out)
}

fn finish(count: usize, opts: &Options, prefix: &str, out: &mut impl Write) -> io::Result<bool> {
    if opts.count {
        writeln!(out, "{prefix}{count}")?;
    }
    Ok(count > 0)
}
