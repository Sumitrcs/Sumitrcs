//! matchbook: a limit order book and matching engine.
//!
//! ```
//! use matchbook::{Event, Order, OrderBook, Side};
//!
//! let mut book = OrderBook::new();
//! book.submit(Order::limit(1, Side::Sell, 100, 10150)); // sell 100 @ 101.50
//! let events = book.submit(Order::limit(2, Side::Buy, 30, 10200)); // buy 30 @ up to 102.00
//! assert!(events.contains(&Event::Trade { taker: 2, maker: 1, side: Side::Buy, price: 10150, qty: 30 }));
//! assert_eq!(book.order(1), Some((Side::Sell, 10150, 70)));
//! ```

pub mod book;
pub mod command;
pub mod price;
pub mod sim;

pub use book::{
    CancelReason, DepthLevel, Event, Kind, Order, OrderBook, OrderId, Price, Qty, RejectReason,
    Side, TimeInForce,
};
pub use command::{Command, parse_command};
pub use price::{format_price, parse_price};
