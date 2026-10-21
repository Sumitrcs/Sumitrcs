use matchbook::Event::{Accepted, Cancelled, Modified, Rejected, Rested, Trade};
use matchbook::Side::{Buy, Sell};
use matchbook::{
    CancelReason, Command, DepthLevel, Order, OrderBook, RejectReason, TimeInForce, format_price,
    parse_command, parse_price,
};

fn book_with(orders: &[Order]) -> OrderBook {
    let mut book = OrderBook::new();
    for &o in orders {
        book.submit(o);
    }
    book.check().unwrap();
    book
}

#[test]
fn an_order_that_cannot_trade_rests() {
    let mut book = OrderBook::new();
    assert_eq!(
        book.submit(Order::limit(1, Buy, 10, 10000)),
        [
            Accepted { id: 1 },
            Rested {
                id: 1,
                side: Buy,
                price: 10000,
                qty: 10
            }
        ]
    );
    assert_eq!(book.best_bid(), Some(10000));
    assert_eq!(book.best_ask(), None);
    assert_eq!(book.spread(), None);
}

#[test]
fn trades_happen_at_the_resting_orders_price() {
    let mut book = book_with(&[Order::limit(1, Sell, 10, 10100)]);
    // The buyer would pay 102.00, but the seller asked only 101.00.
    let events = book.submit(Order::limit(2, Buy, 10, 10200));
    assert_eq!(
        events[1],
        Trade {
            taker: 2,
            maker: 1,
            side: Buy,
            price: 10100,
            qty: 10
        }
    );
    assert!(book.is_empty());
}

#[test]
fn price_priority_then_time_priority() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 10, 10200),
        Order::limit(2, Sell, 10, 10100), // best price
        Order::limit(3, Sell, 10, 10100), // same price, later
    ]);
    let events = book.submit(Order::limit(4, Buy, 25, 10200));
    assert_eq!(
        events,
        [
            Accepted { id: 4 },
            Trade {
                taker: 4,
                maker: 2,
                side: Buy,
                price: 10100,
                qty: 10
            },
            Trade {
                taker: 4,
                maker: 3,
                side: Buy,
                price: 10100,
                qty: 10
            },
            Trade {
                taker: 4,
                maker: 1,
                side: Buy,
                price: 10200,
                qty: 5
            },
        ]
    );
    assert_eq!(book.order(1), Some((Sell, 10200, 5)));
    book.check().unwrap();
}

#[test]
fn a_limit_order_stops_at_its_price_and_rests_the_rest() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 10, 10100),
        Order::limit(2, Sell, 10, 10300),
    ]);
    let events = book.submit(Order::limit(3, Buy, 30, 10200));
    assert_eq!(
        events,
        [
            Accepted { id: 3 },
            Trade {
                taker: 3,
                maker: 1,
                side: Buy,
                price: 10100,
                qty: 10
            },
            Rested {
                id: 3,
                side: Buy,
                price: 10200,
                qty: 20
            },
        ]
    );
    assert_eq!(
        (book.best_bid(), book.best_ask(), book.spread()),
        (Some(10200), Some(10300), Some(100))
    );
}

#[test]
fn partial_fill_of_the_resting_order_keeps_its_place() {
    let mut book = book_with(&[
        Order::limit(1, Buy, 100, 10000),
        Order::limit(2, Buy, 100, 10000),
    ]);
    book.submit(Order::limit(3, Sell, 30, 10000));
    assert_eq!(book.orders(Buy), [(1, 10000, 70), (2, 10000, 100)]);
}

#[test]
fn a_market_order_walks_the_book_and_never_rests() {
    let mut book = book_with(&[
        Order::limit(1, Buy, 10, 10000),
        Order::limit(2, Buy, 10, 9900),
    ]);
    let events = book.submit(Order::market(3, Sell, 25));
    assert_eq!(
        events,
        [
            Accepted { id: 3 },
            Trade {
                taker: 3,
                maker: 1,
                side: Sell,
                price: 10000,
                qty: 10
            },
            Trade {
                taker: 3,
                maker: 2,
                side: Sell,
                price: 9900,
                qty: 10
            },
            Cancelled {
                id: 3,
                qty: 5,
                reason: CancelReason::Unfilled
            },
        ]
    );
    assert!(book.is_empty());
    // On an empty book a market order just gets cancelled.
    assert_eq!(
        book.submit(Order::market(4, Buy, 5))[1],
        Cancelled {
            id: 4,
            qty: 5,
            reason: CancelReason::Unfilled
        }
    );
}

#[test]
fn immediate_or_cancel() {
    let mut book = book_with(&[Order::limit(1, Sell, 10, 10100)]);
    let events = book.submit(Order::limit(2, Buy, 15, 10100).with(TimeInForce::Ioc));
    assert_eq!(
        &events[1..],
        [
            Trade {
                taker: 2,
                maker: 1,
                side: Buy,
                price: 10100,
                qty: 10
            },
            Cancelled {
                id: 2,
                qty: 5,
                reason: CancelReason::Unfilled
            },
        ]
    );
    assert!(book.is_empty());
}

#[test]
fn fill_or_kill_is_all_or_nothing() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 10, 10100),
        Order::limit(2, Sell, 10, 10200),
    ]);
    // 20 are for sale, but only 10 at an acceptable price.
    let killed = book.submit(Order::limit(3, Buy, 20, 10100).with(TimeInForce::Fok));
    assert_eq!(
        killed,
        [
            Accepted { id: 3 },
            Cancelled {
                id: 3,
                qty: 20,
                reason: CancelReason::FillOrKill
            }
        ]
    );
    assert_eq!(book.len(), 2, "a killed order must not touch the book");
    let filled = book.submit(Order::limit(4, Buy, 20, 10200).with(TimeInForce::Fok));
    assert_eq!(filled.len(), 3);
    assert!(book.is_empty());
    // Exactly enough is enough.
    let mut book = book_with(&[Order::limit(1, Buy, 7, 10000)]);
    assert_eq!(
        book.submit(Order::market(2, Sell, 7).with(TimeInForce::Fok))[1],
        Trade {
            taker: 2,
            maker: 1,
            side: Sell,
            price: 10000,
            qty: 7
        }
    );
}

#[test]
fn post_only_never_takes() {
    let mut book = book_with(&[Order::limit(1, Sell, 10, 10100)]);
    let post = |id, price| Order::limit(id, Buy, 5, price).with(TimeInForce::PostOnly);
    assert_eq!(
        book.submit(post(2, 10100)),
        [Rejected {
            id: 2,
            reason: RejectReason::WouldTrade
        }]
    );
    assert_eq!(
        book.submit(post(3, 10050))[1],
        Rested {
            id: 3,
            side: Buy,
            price: 10050,
            qty: 5
        }
    );
    assert_eq!(
        book.submit(Order::market(4, Buy, 5).with(TimeInForce::PostOnly)),
        [Rejected {
            id: 4,
            reason: RejectReason::MarketPostOnly
        }]
    );
}

#[test]
fn invalid_orders_are_rejected_without_changing_anything() {
    let mut book = book_with(&[Order::limit(1, Sell, 10, 10100)]);
    assert_eq!(
        book.submit(Order::limit(2, Buy, 0, 10100)),
        [Rejected {
            id: 2,
            reason: RejectReason::ZeroQuantity
        }]
    );
    assert_eq!(
        book.submit(Order::limit(3, Buy, 5, 0)),
        [Rejected {
            id: 3,
            reason: RejectReason::ZeroPrice
        }]
    );
    assert_eq!(
        book.submit(Order::limit(1, Buy, 5, 10100)),
        [Rejected {
            id: 1,
            reason: RejectReason::DuplicateId
        }]
    );
    assert_eq!(book.orders(Sell), [(1, 10100, 10)]);
    // An id stays used after its order is filled.
    book.submit(Order::limit(4, Buy, 10, 10100));
    assert_eq!(
        book.submit(Order::limit(4, Buy, 1, 9000))[0],
        Rejected {
            id: 4,
            reason: RejectReason::DuplicateId
        }
    );
}

#[test]
fn cancel() {
    let mut book = book_with(&[
        Order::limit(1, Buy, 10, 10000),
        Order::limit(2, Buy, 20, 10000),
        Order::limit(3, Buy, 30, 9900),
    ]);
    assert_eq!(
        book.cancel(2),
        [Cancelled {
            id: 2,
            qty: 20,
            reason: CancelReason::Requested
        }]
    );
    assert_eq!(
        book.cancel(2),
        [Rejected {
            id: 2,
            reason: RejectReason::UnknownOrder
        }]
    );
    assert_eq!(
        book.cancel(3),
        [Cancelled {
            id: 3,
            qty: 30,
            reason: CancelReason::Requested
        }]
    );
    assert_eq!(
        book.depth(5).0,
        [DepthLevel {
            price: 10000,
            qty: 10,
            orders: 1
        }]
    );
    book.check().unwrap();
}

#[test]
fn reducing_quantity_keeps_priority() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 50, 10100),
        Order::limit(2, Sell, 50, 10100),
    ]);
    assert_eq!(
        book.modify(1, 20, None),
        [Modified {
            id: 1,
            qty: 20,
            price: 10100,
            kept_priority: true
        }]
    );
    assert_eq!(book.orders(Sell), [(1, 10100, 20), (2, 10100, 50)]);
    assert_eq!(book.depth(1).1[0].qty, 70);
    book.check().unwrap();
}

#[test]
fn increasing_quantity_or_changing_price_loses_priority() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 50, 10100),
        Order::limit(2, Sell, 50, 10100),
    ]);
    assert_eq!(
        book.modify(1, 60, None),
        [
            Modified {
                id: 1,
                qty: 60,
                price: 10100,
                kept_priority: false
            },
            Rested {
                id: 1,
                side: Sell,
                price: 10100,
                qty: 60
            },
        ]
    );
    assert_eq!(book.orders(Sell), [(2, 10100, 50), (1, 10100, 60)]);
    // Same quantity, different price and back again: still last.
    book.modify(2, 50, Some(10200));
    book.modify(2, 50, Some(10100));
    assert_eq!(book.orders(Sell), [(1, 10100, 60), (2, 10100, 50)]);
    book.check().unwrap();
}

#[test]
fn a_price_change_can_trade_immediately() {
    let mut book = book_with(&[
        Order::limit(1, Sell, 10, 10100),
        Order::limit(2, Buy, 15, 10000),
    ]);
    assert_eq!(
        book.modify(2, 15, Some(10100)),
        [
            Modified {
                id: 2,
                qty: 15,
                price: 10100,
                kept_priority: false
            },
            Trade {
                taker: 2,
                maker: 1,
                side: Buy,
                price: 10100,
                qty: 10
            },
            Rested {
                id: 2,
                side: Buy,
                price: 10100,
                qty: 5
            },
        ]
    );
    book.check().unwrap();
}

#[test]
fn modify_errors() {
    let mut book = book_with(&[Order::limit(1, Sell, 10, 10100)]);
    assert_eq!(
        book.modify(9, 5, None),
        [Rejected {
            id: 9,
            reason: RejectReason::UnknownOrder
        }]
    );
    assert_eq!(
        book.modify(1, 0, None),
        [Rejected {
            id: 1,
            reason: RejectReason::ZeroQuantity
        }]
    );
    assert_eq!(
        book.modify(1, 5, Some(0)),
        [Rejected {
            id: 1,
            reason: RejectReason::ZeroPrice
        }]
    );
    assert_eq!(book.order(1), Some((Sell, 10100, 10)));
}

#[test]
fn depth_is_best_first_on_both_sides() {
    let book = book_with(&[
        Order::limit(1, Buy, 5, 9900),
        Order::limit(2, Buy, 5, 10000),
        Order::limit(3, Buy, 7, 10000),
        Order::limit(4, Sell, 3, 10200),
        Order::limit(5, Sell, 4, 10100),
    ]);
    let (bids, asks) = book.depth(10);
    assert_eq!(
        bids,
        [
            DepthLevel {
                price: 10000,
                qty: 12,
                orders: 2
            },
            DepthLevel {
                price: 9900,
                qty: 5,
                orders: 1
            }
        ]
    );
    assert_eq!(
        asks,
        [
            DepthLevel {
                price: 10100,
                qty: 4,
                orders: 1
            },
            DepthLevel {
                price: 10200,
                qty: 3,
                orders: 1
            }
        ]
    );
    assert_eq!(book.depth(1).0.len(), 1);
}

#[test]
fn prices() {
    assert_eq!(parse_price("101.50"), Ok(10150));
    assert_eq!(parse_price("101.5"), Ok(10150));
    assert_eq!(parse_price("101"), Ok(10100));
    assert_eq!(parse_price("0.05"), Ok(5));
    for bad in [
        "",
        ".5",
        "1.",
        "1.234",
        "-1",
        "+1",
        "1e3",
        "abc",
        "1.2.3",
        "99999999999999999999",
    ] {
        assert!(parse_price(bad).is_err(), "{bad:?} should be rejected");
    }
    assert_eq!(format_price(10150), "101.50");
    assert_eq!(format_price(5), "0.05");
    assert_eq!(format_price(0), "0.00");
}

#[test]
fn commands() {
    let order = |line: &str| match parse_command(line) {
        Ok(Some(Command::Submit(o))) => o,
        other => panic!("{line:?} gave {other:?}"),
    };
    assert_eq!(order("buy 1 100 101.50"), Order::limit(1, Buy, 100, 10150));
    assert_eq!(
        order("SELL 2 5 99 ioc"),
        Order::limit(2, Sell, 5, 9900).with(TimeInForce::Ioc)
    );
    assert_eq!(order("sell 3 5 market"), Order::market(3, Sell, 5));
    assert_eq!(
        order("buy 4 5 market fok  # comment"),
        Order::market(4, Buy, 5).with(TimeInForce::Fok)
    );
    assert_eq!(
        order("buy 5 5 10 post"),
        Order::limit(5, Buy, 5, 1000).with(TimeInForce::PostOnly)
    );
    assert_eq!(parse_command("cancel 7"), Ok(Some(Command::Cancel(7))));
    assert_eq!(
        parse_command("modify 7 10"),
        Ok(Some(Command::Modify {
            id: 7,
            qty: 10,
            price: None
        }))
    );
    assert_eq!(
        parse_command("modify 7 10 99.5"),
        Ok(Some(Command::Modify {
            id: 7,
            qty: 10,
            price: Some(9950)
        }))
    );
    assert_eq!(parse_command("book"), Ok(Some(Command::Book)));
    assert_eq!(parse_command("   # just a comment"), Ok(None));
    assert_eq!(parse_command(""), Ok(None));
    for (bad, msg) in [
        ("buy", "missing order id"),
        ("buy x 1 1", "order id must be a whole number"),
        ("buy 1 -5 1", "quantity must be a whole number"),
        ("buy 1 5", "missing price"),
        ("buy 1 5 1.234", "not a price"),
        ("buy 1 5 market gtc", "can't wait in the book"),
        ("buy 1 5 10 day", "unknown order type"),
        ("buy 1 5 10 ioc extra", "unexpected \"extra\""),
        ("cancel", "missing order id"),
        ("hold 1", "unknown command"),
    ] {
        let err = parse_command(bad).unwrap_err();
        assert!(err.contains(msg), "{bad:?}: {err}");
    }
}
