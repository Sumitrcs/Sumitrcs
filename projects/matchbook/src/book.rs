//! The order book and its matching rules.
//!
//! Buy orders (bids) and sell orders (asks) that can't trade yet wait in the
//! book, grouped into price levels. Each level is a queue, oldest order
//! first. A new order trades against the best opposite price first, and at
//! one price, against the oldest order first: this is *price-time priority*,
//! the rule used by NSE, BSE and almost every stock exchange.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;

pub type OrderId = u64;
/// A price in ticks (paise for an NSE stock: 10150 means ₹101.50). Integers,
/// so two prices are either exactly equal or not.
pub type Price = u64;
pub type Qty = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        })
    }
}

/// A limit order names the worst price it accepts; a market order takes
/// whatever the book offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Limit(Price),
    Market,
}

/// What happens to the part of an order that doesn't trade straight away.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TimeInForce {
    /// Good till cancelled: the rest waits in the book.
    #[default]
    Gtc,
    /// Immediate or cancel: trade what you can now, cancel the rest.
    Ioc,
    /// Fill or kill: trade the whole quantity now, or nothing at all.
    Fok,
    /// Only add to the book. Rejected if it would trade immediately.
    PostOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub side: Side,
    pub qty: Qty,
    pub kind: Kind,
    pub tif: TimeInForce,
}

impl Order {
    pub fn limit(id: OrderId, side: Side, qty: Qty, price: Price) -> Order {
        Order {
            id,
            side,
            qty,
            kind: Kind::Limit(price),
            tif: TimeInForce::Gtc,
        }
    }

    pub fn market(id: OrderId, side: Side, qty: Qty) -> Order {
        Order {
            id,
            side,
            qty,
            kind: Kind::Market,
            tif: TimeInForce::Ioc,
        }
    }

    pub fn with(self, tif: TimeInForce) -> Order {
        Order { tif, ..self }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    /// The trader asked for it.
    Requested,
    /// The unfilled rest of an IOC or market order.
    Unfilled,
    /// A fill-or-kill order that couldn't be filled completely.
    FillOrKill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    ZeroQuantity,
    ZeroPrice,
    DuplicateId,
    UnknownOrder,
    /// A post-only order whose price would trade immediately.
    WouldTrade,
    /// Post-only needs a price, so it can't be a market order.
    MarketPostOnly,
}

/// Everything the engine does is reported as events, in order. An exchange
/// sends these to traders (their own orders) and to the market data feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Accepted {
        id: OrderId,
    },
    Rejected {
        id: OrderId,
        reason: RejectReason,
    },
    /// The incoming (taker) order traded with a resting (maker) order, at
    /// the maker's price.
    Trade {
        taker: OrderId,
        maker: OrderId,
        side: Side,
        price: Price,
        qty: Qty,
    },
    /// The rest of the order now waits in the book.
    Rested {
        id: OrderId,
        side: Side,
        price: Price,
        qty: Qty,
    },
    Cancelled {
        id: OrderId,
        qty: Qty,
        reason: CancelReason,
    },
    /// `kept_priority` is true when only the quantity went down; any other
    /// change sends the order to the back of the queue.
    Modified {
        id: OrderId,
        qty: Qty,
        price: Price,
        kept_priority: bool,
    },
}

#[derive(Clone, Copy, Debug)]
struct Resting {
    id: OrderId,
    qty: Qty,
}

/// All the orders waiting at one price, oldest first.
#[derive(Debug, Default)]
struct Level {
    queue: VecDeque<Resting>,
    total: Qty,
}

/// One row of the book as seen in a market depth screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepthLevel {
    pub price: Price,
    pub qty: Qty,
    pub orders: usize,
}

#[derive(Debug, Default)]
pub struct OrderBook {
    bids: BTreeMap<Price, Level>, // best bid = highest key
    asks: BTreeMap<Price, Level>, // best ask = lowest key
    resting: HashMap<OrderId, (Side, Price)>,
    used_ids: HashSet<OrderId>,
}

impl OrderBook {
    pub fn new() -> OrderBook {
        OrderBook::default()
    }

    /// Sends a new order to the book. Returns what happened.
    pub fn submit(&mut self, order: Order) -> Vec<Event> {
        let mut events = Vec::new();
        let reject = |reason| {
            vec![Event::Rejected {
                id: order.id,
                reason,
            }]
        };
        if order.qty == 0 {
            return reject(RejectReason::ZeroQuantity);
        }
        if order.kind == Kind::Limit(0) {
            return reject(RejectReason::ZeroPrice);
        }
        if self.used_ids.contains(&order.id) {
            return reject(RejectReason::DuplicateId);
        }
        if order.tif == TimeInForce::PostOnly {
            match order.kind {
                Kind::Market => return reject(RejectReason::MarketPostOnly),
                Kind::Limit(p) if self.crosses(order.side, p) => {
                    return reject(RejectReason::WouldTrade);
                }
                Kind::Limit(_) => {}
            }
        }
        self.used_ids.insert(order.id);
        events.push(Event::Accepted { id: order.id });

        if order.tif == TimeInForce::Fok
            && self.available(order.side, order.kind, order.qty) < order.qty
        {
            events.push(Event::Cancelled {
                id: order.id,
                qty: order.qty,
                reason: CancelReason::FillOrKill,
            });
            return events;
        }
        self.execute(order, &mut events);
        events
    }

    /// Cancels a resting order.
    pub fn cancel(&mut self, id: OrderId) -> Vec<Event> {
        match self.remove(id) {
            Some((_, _, qty)) => vec![Event::Cancelled {
                id,
                qty,
                reason: CancelReason::Requested,
            }],
            None => vec![Event::Rejected {
                id,
                reason: RejectReason::UnknownOrder,
            }],
        }
    }

    /// Changes a resting order's quantity and/or price.
    ///
    /// Lowering the quantity keeps the order's place in the queue, because
    /// it doesn't hurt anyone behind it. Raising the quantity or changing
    /// the price is treated as cancel + new order: it goes to the back of
    /// the queue, and at a new price it may trade straight away.
    pub fn modify(&mut self, id: OrderId, qty: Qty, price: Option<Price>) -> Vec<Event> {
        let Some(&(side, old_price)) = self.resting.get(&id) else {
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
        let price = price.unwrap_or(old_price);
        if price == 0 {
            return vec![Event::Rejected {
                id,
                reason: RejectReason::ZeroPrice,
            }];
        }
        let level = self
            .side_mut(side)
            .get_mut(&old_price)
            .expect("resting order has a level");
        let pos = level
            .queue
            .iter()
            .position(|r| r.id == id)
            .expect("resting order is in its level");
        let current = level.queue[pos].qty;

        if price == old_price && qty <= current {
            level.queue[pos].qty = qty;
            level.total -= current - qty;
            return vec![Event::Modified {
                id,
                qty,
                price,
                kept_priority: true,
            }];
        }
        self.remove(id);
        let mut events = vec![Event::Modified {
            id,
            qty,
            price,
            kept_priority: false,
        }];
        self.execute(Order::limit(id, side, qty, price), &mut events);
        events
    }

    /// Matches an accepted order against the book, then rests or cancels
    /// whatever is left.
    fn execute(&mut self, order: Order, events: &mut Vec<Event>) {
        let mut left = order.qty;
        let opposite = match order.side {
            Side::Buy => &mut self.asks,
            Side::Sell => &mut self.bids,
        };
        while left > 0 {
            // The best opposite level: lowest ask for a buyer, highest bid for a seller.
            let entry = match order.side {
                Side::Buy => opposite.first_entry(),
                Side::Sell => opposite.last_entry(),
            };
            let Some(mut entry) = entry else { break };
            let price = *entry.key();
            if let Kind::Limit(limit) = order.kind {
                let acceptable = match order.side {
                    Side::Buy => price <= limit,
                    Side::Sell => price >= limit,
                };
                if !acceptable {
                    break;
                }
            }
            let level = entry.get_mut();
            while left > 0 {
                let Some(maker) = level.queue.front_mut() else {
                    break;
                };
                let fill = left.min(maker.qty);
                events.push(Event::Trade {
                    taker: order.id,
                    maker: maker.id,
                    side: order.side,
                    price,
                    qty: fill,
                });
                maker.qty -= fill;
                level.total -= fill;
                left -= fill;
                if maker.qty == 0 {
                    let done = maker.id;
                    level.queue.pop_front();
                    self.resting.remove(&done);
                }
            }
            if level.queue.is_empty() {
                entry.remove();
            }
        }
        if left == 0 {
            return;
        }
        match (order.kind, order.tif) {
            (Kind::Limit(price), TimeInForce::Gtc | TimeInForce::PostOnly) => {
                let level = self.side_mut(order.side).entry(price).or_default();
                level.queue.push_back(Resting {
                    id: order.id,
                    qty: left,
                });
                level.total += left;
                self.resting.insert(order.id, (order.side, price));
                events.push(Event::Rested {
                    id: order.id,
                    side: order.side,
                    price,
                    qty: left,
                });
            }
            _ => events.push(Event::Cancelled {
                id: order.id,
                qty: left,
                reason: CancelReason::Unfilled,
            }),
        }
    }

    /// Takes a resting order out of the book: (side, price, remaining qty).
    fn remove(&mut self, id: OrderId) -> Option<(Side, Price, Qty)> {
        let (side, price) = self.resting.remove(&id)?;
        let book = self.side_mut(side);
        let level = book.get_mut(&price).expect("resting order has a level");
        // A linear search of one price level. Levels are usually short; see
        // the README for how real engines make this O(1).
        let pos = level
            .queue
            .iter()
            .position(|r| r.id == id)
            .expect("resting order is in its level");
        let qty = level.queue.remove(pos).expect("position is valid").qty;
        level.total -= qty;
        if level.queue.is_empty() {
            book.remove(&price);
        }
        Some((side, price, qty))
    }

    fn side_mut(&mut self, side: Side) -> &mut BTreeMap<Price, Level> {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    /// Would a limit order at this price trade immediately?
    fn crosses(&self, side: Side, price: Price) -> bool {
        match side {
            Side::Buy => self.best_ask().is_some_and(|ask| price >= ask),
            Side::Sell => self.best_bid().is_some_and(|bid| price <= bid),
        }
    }

    /// How much an order could trade right now, counting up to `want`.
    fn available(&self, side: Side, kind: Kind, want: Qty) -> Qty {
        let ok = |p: Price| match (kind, side) {
            (Kind::Market, _) => true,
            (Kind::Limit(limit), Side::Buy) => p <= limit,
            (Kind::Limit(limit), Side::Sell) => p >= limit,
        };
        let levels: Box<dyn Iterator<Item = (&Price, &Level)>> = match side {
            Side::Buy => Box::new(self.asks.iter()),
            Side::Sell => Box::new(self.bids.iter().rev()),
        };
        let mut total = 0;
        for (&p, level) in levels {
            if !ok(p) || total >= want {
                break;
            }
            total += level.total;
        }
        total
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.keys().next().copied()
    }

    pub fn spread(&self) -> Option<Price> {
        Some(self.best_ask()? - self.best_bid()?)
    }

    /// The best `n` levels on each side, best first: (bids, asks).
    pub fn depth(&self, n: usize) -> (Vec<DepthLevel>, Vec<DepthLevel>) {
        let row = |(&price, level): (&Price, &Level)| DepthLevel {
            price,
            qty: level.total,
            orders: level.queue.len(),
        };
        (
            self.bids.iter().rev().take(n).map(row).collect(),
            self.asks.iter().take(n).map(row).collect(),
        )
    }

    /// A resting order's side, price and remaining quantity.
    pub fn order(&self, id: OrderId) -> Option<(Side, Price, Qty)> {
        let &(side, price) = self.resting.get(&id)?;
        let book = match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        };
        let qty = book[&price].queue.iter().find(|r| r.id == id)?.qty;
        Some((side, price, qty))
    }

    /// Number of resting orders.
    pub fn len(&self) -> usize {
        self.resting.len()
    }

    pub fn is_empty(&self) -> bool {
        self.resting.is_empty()
    }

    /// Resting orders in priority order for one side: (id, price, qty).
    pub fn orders(&self, side: Side) -> Vec<(OrderId, Price, Qty)> {
        let levels: Box<dyn Iterator<Item = (&Price, &Level)>> = match side {
            Side::Buy => Box::new(self.bids.iter().rev()),
            Side::Sell => Box::new(self.asks.iter()),
        };
        levels
            .flat_map(|(&p, l)| l.queue.iter().map(move |r| (r.id, p, r.qty)))
            .collect()
    }

    /// Checks the book's internal consistency. Used by the tests after
    /// every operation; returns a description of the first problem found.
    pub fn check(&self) -> Result<(), String> {
        if let (Some(bid), Some(ask)) = (self.best_bid(), self.best_ask())
            && bid >= ask
        {
            return Err(format!("book is crossed: bid {bid} >= ask {ask}"));
        }
        let mut count = 0;
        for (side, book) in [(Side::Buy, &self.bids), (Side::Sell, &self.asks)] {
            for (&price, level) in book {
                if level.queue.is_empty() {
                    return Err(format!("empty {side} level at {price}"));
                }
                let sum: Qty = level.queue.iter().map(|r| r.qty).sum();
                if sum != level.total {
                    return Err(format!(
                        "{side} level {price}: total {} but orders add up to {sum}",
                        level.total
                    ));
                }
                for r in &level.queue {
                    count += 1;
                    if r.qty == 0 {
                        return Err(format!("order {} rests with quantity 0", r.id));
                    }
                    if self.resting.get(&r.id) != Some(&(side, price)) {
                        return Err(format!("order {} is not indexed at {side} {price}", r.id));
                    }
                }
            }
        }
        if count != self.resting.len() {
            return Err(format!(
                "index has {} orders, levels have {count}",
                self.resting.len()
            ));
        }
        Ok(())
    }
}
