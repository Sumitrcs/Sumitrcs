//! A small text language for driving the engine, one command per line:
//!
//! ```text
//! buy  <id> <qty> <price|market> [gtc|ioc|fok|post]
//! sell <id> <qty> <price|market> [gtc|ioc|fok|post]
//! cancel <id>
//! modify <id> <qty> [<price>]
//! book
//! # comments and blank lines are ignored
//! ```

use crate::book::{Kind, Order, OrderBook, OrderId, Price, Qty, Side, TimeInForce};
use crate::price::parse_price;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Submit(Order),
    Cancel(OrderId),
    Modify {
        id: OrderId,
        qty: Qty,
        price: Option<Price>,
    },
    /// Show the book.
    Book,
}

impl Command {
    pub fn apply(&self, book: &mut OrderBook) -> Vec<crate::book::Event> {
        match *self {
            Command::Submit(order) => book.submit(order),
            Command::Cancel(id) => book.cancel(id),
            Command::Modify { id, qty, price } => book.modify(id, qty, price),
            Command::Book => Vec::new(),
        }
    }
}

/// Parses one line. Returns Ok(None) for blank lines and comments.
pub fn parse_command(line: &str) -> Result<Option<Command>, String> {
    let line = line.split('#').next().unwrap_or("");
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some(&first) = words.first() else {
        return Ok(None);
    };
    let number = |i: usize, what: &str| -> Result<u64, String> {
        let w = words.get(i).ok_or_else(|| format!("missing {what}"))?;
        w.parse()
            .map_err(|_| format!("{what} must be a whole number, got {w:?}"))
    };
    let expect_len = |max: usize| {
        if words.len() > max {
            Err(format!("unexpected {:?} at the end", words[max]))
        } else {
            Ok(())
        }
    };
    let cmd = match first.to_ascii_lowercase().as_str() {
        word @ ("buy" | "sell") => {
            let side = if word == "buy" { Side::Buy } else { Side::Sell };
            let id = number(1, "order id")?;
            let qty = number(2, "quantity")?;
            let price = words
                .get(3)
                .ok_or("missing price (a number, or the word market)")?;
            let kind = if price.eq_ignore_ascii_case("market") {
                Kind::Market
            } else {
                Kind::Limit(parse_price(price)?)
            };
            let tif = match words.get(4).map(|w| w.to_ascii_lowercase()) {
                None if kind == Kind::Market => TimeInForce::Ioc,
                None => TimeInForce::Gtc,
                Some(w) => match w.as_str() {
                    "gtc" => TimeInForce::Gtc,
                    "ioc" => TimeInForce::Ioc,
                    "fok" => TimeInForce::Fok,
                    "post" => TimeInForce::PostOnly,
                    _ => {
                        return Err(format!(
                            "unknown order type {w:?} (use gtc, ioc, fok or post)"
                        ));
                    }
                },
            };
            if kind == Kind::Market && tif == TimeInForce::Gtc {
                return Err("a market order can't wait in the book (gtc); use ioc or fok".into());
            }
            expect_len(5)?;
            Command::Submit(Order {
                id,
                side,
                qty,
                kind,
                tif,
            })
        }
        "cancel" => {
            expect_len(2)?;
            Command::Cancel(number(1, "order id")?)
        }
        "modify" => {
            expect_len(4)?;
            let price = words.get(3).map(|p| parse_price(p)).transpose()?;
            Command::Modify {
                id: number(1, "order id")?,
                qty: number(2, "quantity")?,
                price,
            }
        }
        "book" => {
            expect_len(1)?;
            Command::Book
        }
        other => {
            return Err(format!(
                "unknown command {other:?} (buy, sell, cancel, modify or book)"
            ));
        }
    };
    Ok(Some(cmd))
}
