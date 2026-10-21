//! Random but realistic order flow, for the benchmark and the tests.
//!
//! Prices cluster around a mid price so that orders often cross and trade;
//! some orders are cancelled or modified later, like real traders do.

use crate::book::{Kind, Order, OrderId, Price, Side, TimeInForce};
use crate::command::Command;

/// SplitMix64: a tiny, fast, good-enough random number generator. Seeded,
/// so every run with the same seed produces the same orders.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in 0..n.
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }
}

pub struct OrderFlow {
    rng: Rng,
    next_id: OrderId,
    mid: Price,
    /// How far from the mid prices may be, in ticks.
    pub spread_ticks: u64,
}

impl OrderFlow {
    pub fn new(seed: u64, mid: Price) -> OrderFlow {
        OrderFlow {
            rng: Rng::new(seed),
            next_id: 1,
            mid,
            spread_ticks: 20,
        }
    }

    pub fn next_command(&mut self) -> Command {
        let roll = self.rng.below(100);
        if roll < 15 && self.next_id > 1 {
            // Cancel a recent order (it may already be filled: that's fine).
            return Command::Cancel(self.recent_id());
        }
        if roll < 22 && self.next_id > 1 {
            let id = self.recent_id();
            let qty = 1 + self.rng.below(100);
            let price = if self.rng.below(2) == 0 {
                None
            } else {
                Some(self.price())
            };
            return Command::Modify { id, qty, price };
        }
        let id = self.next_id;
        self.next_id += 1;
        let side = if self.rng.below(2) == 0 {
            Side::Buy
        } else {
            Side::Sell
        };
        let qty = 1 + self.rng.below(100);
        let kind = if roll < 27 {
            Kind::Market
        } else {
            Kind::Limit(self.price())
        };
        let tif = match (kind, self.rng.below(10)) {
            (Kind::Market, 0) => TimeInForce::Fok,
            (Kind::Market, _) => TimeInForce::Ioc,
            (_, 0) => TimeInForce::Ioc,
            (_, 1) => TimeInForce::Fok,
            (_, 2) => TimeInForce::PostOnly,
            _ => TimeInForce::Gtc,
        };
        Command::Submit(Order {
            id,
            side,
            qty,
            kind,
            tif,
        })
    }

    /// One of the last 50 order ids.
    fn recent_id(&mut self) -> OrderId {
        let back = self.rng.below(self.next_id.min(50));
        (self.next_id - 1 - back).max(1)
    }

    fn price(&mut self) -> Price {
        let offset = self.rng.below(2 * self.spread_ticks + 1);
        (self.mid + offset).saturating_sub(self.spread_ticks).max(1)
    }
}
