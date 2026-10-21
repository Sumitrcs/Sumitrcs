use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::process::ExitCode;
use std::time::Instant;

use matchbook::sim::OrderFlow;
use matchbook::{
    CancelReason, Command, Event, OrderBook, RejectReason, format_price, parse_command,
};

const USAGE: &str = "\
usage: matchbook [FILE]          run commands from FILE (or standard input)
       matchbook --bench [N]     match N random orders (default 1,000,000) and time it

commands, one per line:
  buy  <id> <qty> <price|market> [gtc|ioc|fok|post]
  sell <id> <qty> <price|market> [gtc|ioc|fok|post]
  cancel <id>
  modify <id> <qty> [<price>]
  book                           show the order book

options:
  -q, --quiet       print only trades and the final book
  -h, --help        show this help";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quiet = args.iter().any(|a| a == "-q" || a == "--quiet");
    let rest: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| *a != "-q" && *a != "--quiet")
        .collect();
    let result = match rest.as_slice() {
        ["-h" | "--help"] => {
            println!("{USAGE}");
            Ok(())
        }
        ["--bench"] => bench(1_000_000),
        ["--bench", n] => match n.replace(['_', ','], "").parse() {
            Ok(n) => bench(n),
            Err(_) => Err(format!("--bench needs a number, got {n:?}")),
        },
        [] | ["-"] => run(BufReader::new(io::stdin()), quiet),
        [path] if !path.starts_with('-') => match File::open(path) {
            Ok(f) => run(BufReader::new(f), quiet),
            Err(e) => Err(format!("{path}: {e}")),
        },
        _ => Err(format!("unexpected arguments\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("matchbook: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(input: impl BufRead, quiet: bool) -> Result<(), String> {
    let mut book = OrderBook::new();
    let mut out = BufWriter::new(io::stdout().lock());
    let (mut trades, mut volume) = (0u64, 0u64);
    for (n, line) in input.lines().enumerate() {
        let line = line.map_err(|e| e.to_string())?;
        let cmd = match parse_command(&line) {
            Ok(Some(cmd)) => cmd,
            Ok(None) => continue,
            Err(e) => return Err(format!("line {}: {e}\n  {}", n + 1, line.trim())),
        };
        if !quiet {
            writeln!(out, "> {}", line.split('#').next().unwrap_or("").trim())
                .map_err(|e| e.to_string())?;
        }
        if cmd == Command::Book {
            print_book(&mut out, &book).map_err(|e| e.to_string())?;
            continue;
        }
        for event in cmd.apply(&mut book) {
            if let Event::Trade { qty, .. } = event {
                trades += 1;
                volume += qty;
            } else if quiet {
                continue;
            }
            writeln!(out, "  {}", describe(&event)).map_err(|e| e.to_string())?;
        }
    }
    writeln!(
        out,
        "\n{trades} trades, {volume} shares traded, {} orders resting",
        book.len()
    )
    .map_err(|e| e.to_string())?;
    print_book(&mut out, &book).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}

fn describe(e: &Event) -> String {
    match *e {
        Event::Accepted { id } => format!("accepted #{id}"),
        Event::Rejected { id, reason } => format!(
            "rejected #{id}: {}",
            match reason {
                RejectReason::ZeroQuantity => "quantity must be at least 1",
                RejectReason::ZeroPrice => "price must be above zero",
                RejectReason::DuplicateId => "this order id was already used",
                RejectReason::UnknownOrder =>
                    "no such order in the book (already filled or cancelled?)",
                RejectReason::WouldTrade => "post-only order would trade immediately",
                RejectReason::MarketPostOnly => "a market order can't be post-only",
            }
        ),
        Event::Trade {
            taker,
            maker,
            side,
            price,
            qty,
        } => {
            let verb = if side == matchbook::Side::Buy {
                "bought"
            } else {
                "sold"
            };
            let prep = if side == matchbook::Side::Buy {
                "from"
            } else {
                "to"
            };
            format!(
                "TRADE  #{taker} {verb} {qty} @ {} {prep} #{maker}",
                format_price(price)
            )
        }
        Event::Rested {
            id,
            side,
            price,
            qty,
        } => format!("resting #{id}: {side} {qty} @ {}", format_price(price)),
        Event::Cancelled { id, qty, reason } => format!(
            "cancelled #{id}: {qty} not filled ({})",
            match reason {
                CancelReason::Requested => "requested",
                CancelReason::Unfilled => "nothing more to trade with now",
                CancelReason::FillOrKill => "fill-or-kill: not enough to fill it all",
            }
        ),
        Event::Modified {
            id,
            qty,
            price,
            kept_priority,
        } => format!(
            "modified #{id}: now {qty} @ {} ({})",
            format_price(price),
            if kept_priority {
                "keeps its place in the queue"
            } else {
                "moves to the back of the queue"
            }
        ),
    }
}

fn print_book(out: &mut impl Write, book: &OrderBook) -> io::Result<()> {
    let (bids, asks) = book.depth(10);
    writeln!(out, "         price      qty  orders")?;
    for a in asks.iter().rev() {
        writeln!(
            out,
            "  ask {:>9} {:>8} {:>7}",
            format_price(a.price),
            a.qty,
            a.orders
        )?;
    }
    match book.spread() {
        Some(s) => writeln!(out, "  ------ spread {} ------", format_price(s))?,
        None => writeln!(out, "  ------------------------")?,
    }
    for b in &bids {
        writeln!(
            out,
            "  bid {:>9} {:>8} {:>7}",
            format_price(b.price),
            b.qty,
            b.orders
        )?;
    }
    Ok(())
}

fn bench(n: u64) -> Result<(), String> {
    let mut flow = OrderFlow::new(42, 10_000);
    let commands: Vec<Command> = (0..n).map(|_| flow.next_command()).collect();
    let mut book = OrderBook::new();
    let (mut trades, mut events) = (0u64, 0u64);
    let start = Instant::now();
    for cmd in &commands {
        for e in cmd.apply(&mut book) {
            events += 1;
            if matches!(e, Event::Trade { .. }) {
                trades += 1;
            }
        }
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "{n} commands in {:.3} s: {:.2} million per second",
        secs,
        n as f64 / secs / 1e6
    );
    println!(
        "{trades} trades, {events} events, {} orders left resting, {:.0} ns per command",
        book.len(),
        secs * 1e9 / n as f64
    );
    book.check()
}
