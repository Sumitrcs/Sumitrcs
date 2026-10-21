//! The engine is compared, event by event, with a deliberately simple
//! reference implementation: one flat list of orders, searched from scratch
//! for the best match every time. It is far too slow for real use, but it is
//! short enough to check by reading, which makes it a good oracle.

use matchbook::sim::OrderFlow;
use matchbook::{
    CancelReason, Command, Event, Kind, Order, OrderBook, OrderId, Price, Qty, RejectReason, Side,
    TimeInForce,
};
use std::collections::HashSet;

#[derive(Clone, Copy)]
struct Resting {
    id: OrderId,
    side: Side,
    price: Price,
    qty: Qty,
    seq: u64, // arrival time
}

#[derive(Default)]
struct Reference {
    orders: Vec<Resting>,
    used: HashSet<OrderId>,
    clock: u64,
}

impl Reference {
    fn can_trade(side: Side, kind: Kind, price: Price) -> bool {
        match (kind, side) {
            (Kind::Market, _) => true,
            (Kind::Limit(l), Side::Buy) => price <= l,
            (Kind::Limit(l), Side::Sell) => price >= l,
        }
    }

    /// Index of the best order the taker can trade with, if any.
    fn best(&self, side: Side, kind: Kind) -> Option<usize> {
        let candidates = self
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.side != side && Self::can_trade(side, kind, o.price));
        match side {
            // Buyers want the lowest price, then the oldest order.
            Side::Buy => candidates
                .min_by_key(|(_, o)| (o.price, o.seq))
                .map(|(i, _)| i),
            Side::Sell => candidates
                .min_by_key(|(_, o)| (std::cmp::Reverse(o.price), o.seq))
                .map(|(i, _)| i),
        }
    }

    fn submit(&mut self, o: Order) -> Vec<Event> {
        let reject = |reason| vec![Event::Rejected { id: o.id, reason }];
        if o.qty == 0 {
            return reject(RejectReason::ZeroQuantity);
        }
        if o.kind == Kind::Limit(0) {
            return reject(RejectReason::ZeroPrice);
        }
        if self.used.contains(&o.id) {
            return reject(RejectReason::DuplicateId);
        }
        if o.tif == TimeInForce::PostOnly {
            if o.kind == Kind::Market {
                return reject(RejectReason::MarketPostOnly);
            }
            if self.best(o.side, o.kind).is_some() {
                return reject(RejectReason::WouldTrade);
            }
        }
        self.used.insert(o.id);
        let mut events = vec![Event::Accepted { id: o.id }];
        if o.tif == TimeInForce::Fok {
            let available: Qty = self
                .orders
                .iter()
                .filter(|r| r.side != o.side && Self::can_trade(o.side, o.kind, r.price))
                .map(|r| r.qty)
                .sum();
            if available < o.qty {
                events.push(Event::Cancelled {
                    id: o.id,
                    qty: o.qty,
                    reason: CancelReason::FillOrKill,
                });
                return events;
            }
        }
        self.execute(o, &mut events);
        events
    }

    fn execute(&mut self, o: Order, events: &mut Vec<Event>) {
        let mut left = o.qty;
        while left > 0 {
            let Some(i) = self.best(o.side, o.kind) else {
                break;
            };
            let maker = &mut self.orders[i];
            let fill = left.min(maker.qty);
            events.push(Event::Trade {
                taker: o.id,
                maker: maker.id,
                side: o.side,
                price: maker.price,
                qty: fill,
            });
            maker.qty -= fill;
            left -= fill;
            if maker.qty == 0 {
                self.orders.remove(i);
            }
        }
        if left == 0 {
            return;
        }
        match (o.kind, o.tif) {
            (Kind::Limit(price), TimeInForce::Gtc | TimeInForce::PostOnly) => {
                self.clock += 1;
                self.orders.push(Resting {
                    id: o.id,
                    side: o.side,
                    price,
                    qty: left,
                    seq: self.clock,
                });
                events.push(Event::Rested {
                    id: o.id,
                    side: o.side,
                    price,
                    qty: left,
                });
            }
            _ => events.push(Event::Cancelled {
                id: o.id,
                qty: left,
                reason: CancelReason::Unfilled,
            }),
        }
    }

    fn cancel(&mut self, id: OrderId) -> Vec<Event> {
        match self.orders.iter().position(|o| o.id == id) {
            Some(i) => {
                let o = self.orders.remove(i);
                vec![Event::Cancelled {
                    id,
                    qty: o.qty,
                    reason: CancelReason::Requested,
                }]
            }
            None => vec![Event::Rejected {
                id,
                reason: RejectReason::UnknownOrder,
            }],
        }
    }

    fn modify(&mut self, id: OrderId, qty: Qty, price: Option<Price>) -> Vec<Event> {
        let Some(i) = self.orders.iter().position(|o| o.id == id) else {
            return vec![Event::Rejected {
                id,
                reason: RejectReason::UnknownOrder,
            }];
        };
        if qty == 0 {
            return vec![Event::Rejected {
                id,
                reason: RejectReason::ZeroQuantity,
            }];
        }
        let price = price.unwrap_or(self.orders[i].price);
        if price == 0 {
            return vec![Event::Rejected {
                id,
                reason: RejectReason::ZeroPrice,
            }];
        }
        if price == self.orders[i].price && qty <= self.orders[i].qty {
            self.orders[i].qty = qty;
            return vec![Event::Modified {
                id,
                qty,
                price,
                kept_priority: true,
            }];
        }
        let side = self.orders.remove(i).side;
        let mut events = vec![Event::Modified {
            id,
            qty,
            price,
            kept_priority: false,
        }];
        self.execute(Order::limit(id, side, qty, price), &mut events);
        events
    }

    fn apply(&mut self, cmd: &Command) -> Vec<Event> {
        match *cmd {
            Command::Submit(o) => self.submit(o),
            Command::Cancel(id) => self.cancel(id),
            Command::Modify { id, qty, price } => self.modify(id, qty, price),
            Command::Book => Vec::new(),
        }
    }

    /// Resting orders of one side in priority order: (id, price, qty).
    fn orders(&self, side: Side) -> Vec<(OrderId, Price, Qty)> {
        let mut v: Vec<_> = self.orders.iter().filter(|o| o.side == side).collect();
        match side {
            Side::Buy => v.sort_by_key(|o| (std::cmp::Reverse(o.price), o.seq)),
            Side::Sell => v.sort_by_key(|o| (o.price, o.seq)),
        }
        v.into_iter().map(|o| (o.id, o.price, o.qty)).collect()
    }
}

fn compare(seed: u64, steps: usize, spread_ticks: u64) {
    let mut flow = OrderFlow::new(seed, 10_000);
    flow.spread_ticks = spread_ticks;
    let mut book = OrderBook::new();
    let mut reference = Reference::default();
    let mut trades = 0;
    for step in 0..steps {
        let cmd = flow.next_command();
        let got = cmd.apply(&mut book);
        let want = reference.apply(&cmd);
        assert_eq!(got, want, "seed {seed}, step {step}: {cmd:?}");
        trades += got
            .iter()
            .filter(|e| matches!(e, Event::Trade { .. }))
            .count();
        if let Err(e) = book.check() {
            panic!("seed {seed}, step {step} ({cmd:?}): {e}");
        }
        if step % 97 == 0 {
            for side in [Side::Buy, Side::Sell] {
                assert_eq!(
                    book.orders(side),
                    reference.orders(side),
                    "seed {seed}, step {step}"
                );
            }
        }
    }
    assert!(
        trades > steps / 10,
        "seed {seed}: only {trades} trades, the flow is too quiet to test much"
    );
}

#[test]
fn matches_the_reference_on_random_order_flow() {
    for seed in 1..=20 {
        compare(seed, 5_000, 20);
    }
}

#[test]
fn matches_the_reference_with_a_tight_market() {
    // Few price levels: long queues, lots of time-priority decisions.
    for seed in 100..110 {
        compare(seed, 5_000, 2);
    }
}

#[test]
fn matches_the_reference_with_a_wide_market() {
    for seed in 200..205 {
        compare(seed, 5_000, 200);
    }
}

#[test]
fn quantity_is_conserved() {
    // Every share of every accepted order ends up traded, resting or cancelled.
    let mut flow = OrderFlow::new(7, 10_000);
    let mut book = OrderBook::new();
    let (mut submitted, mut traded, mut cancelled) = (0u64, 0u64, 0u64);
    let mut only_new_orders = 0;
    while only_new_orders < 20_000 {
        let Command::Submit(order) = flow.next_command() else {
            continue;
        };
        only_new_orders += 1;
        for e in book.submit(order) {
            match e {
                Event::Accepted { .. } => submitted += order.qty,
                Event::Trade { qty, .. } => traded += qty,
                Event::Cancelled { qty, .. } => cancelled += qty,
                _ => {}
            }
        }
    }
    let resting: u64 = [Side::Buy, Side::Sell]
        .iter()
        .flat_map(|&s| book.orders(s))
        .map(|(_, _, q)| q)
        .sum();
    // A trade uses up the same quantity on both sides: the taker's (counted
    // in `submitted` now) and the maker's (counted when it was submitted).
    assert_eq!(submitted, 2 * traded + resting + cancelled);
}
