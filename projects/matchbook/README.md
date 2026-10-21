# matchbook

[![CI](https://github.com/Sumitrcs/matchbook/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/matchbook/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**A limit order book and matching engine in Rust: the piece of software at the heart of every stock exchange.**
When you place an order on NSE or BSE through Zerodha or Groww, a program like this decides who trades with whom, at what price, and in what order.

It supports limit and market orders, immediate-or-cancel, fill-or-kill and post-only orders, as well as cancel and modify with the exchange rules for queue priority.
The engine is one commented 550-line file with no dependencies, it matches several million orders per second, and it is tested event by event against a simple reference implementation.

```text
$ matchbook examples/session.txt
> sell 1 100 101.50
  accepted #1
  resting #1: sell 100 @ 101.50
  ...
> book
         price      qty  orders
  ask    102.00      200       1
  ask    101.50      150       2
  ------ spread 0.50 ------
  bid    101.00       80       1
  bid    100.50       40       1
> buy 6 120 101.75
  accepted #6
  TRADE  #6 bought 100 @ 101.50 from #1
  TRADE  #6 bought 20 @ 101.50 from #2
> sell 7 100 market
  accepted #7
  TRADE  #7 sold 80 @ 101.00 to #4
  TRADE  #7 sold 20 @ 100.50 to #5
> modify 3 150
  modified #3: now 150 @ 102.00 (keeps its place in the queue)
> modify 5 20 100.75
  modified #5: now 20 @ 100.75 (moves to the back of the queue)
  resting #5: buy 20 @ 100.75
> buy 8 500 102.00 fok
  accepted #8
  cancelled #8: 500 not filled (fill-or-kill: not enough to fill it all)
> buy 9 10 101.50 post
  rejected #9: post-only order would trade immediately
...
4 trades, 220 shares traded, 2 orders resting
         price      qty  orders
  ask    101.50       30       1
  ------ spread 0.75 ------
  bid    100.75       20       1
```

That's real output from [`examples/session.txt`](examples/session.txt), which has a comment above each step explaining what's happening.

## Run it

```bash
cargo run --release -- examples/session.txt   # run a script of orders
cargo run --release                           # type orders yourself (Ctrl-D to finish)
cargo run --release -- --bench                # match 1,000,000 random orders
cargo test --release                          # 23 tests
```

The commands are:

```text
buy  <id> <qty> <price|market> [gtc|ioc|fok|post]
sell <id> <qty> <price|market> [gtc|ioc|fok|post]
cancel <id>
modify <id> <qty> [<price>]
book
```

It also works as a library:

```rust
use matchbook::{Order, OrderBook, Side, TimeInForce};

let mut book = OrderBook::new();
book.submit(Order::limit(1, Side::Sell, 100, 10150)); // prices are in paise: 101.50
let events = book.submit(Order::limit(2, Side::Buy, 30, 10200).with(TimeInForce::Ioc));
```

## The order types

| Type | What it does | When traders use it |
|---|---|---|
| **Limit** (`gtc`) | Buy at this price or lower (sell: or higher). Whatever doesn't trade waits in the book. | Most orders |
| **Market** | Take the best prices available right now, whatever they are. Never waits. | Getting out fast |
| **IOC** (immediate or cancel) | Trade what you can now at your price, cancel the rest. | Not showing your hand |
| **FOK** (fill or kill) | Trade the *whole* quantity now, or nothing at all. | When a partial fill is useless |
| **Post-only** | Only add to the book; rejected if it would trade immediately. | Market makers, who earn the spread |

## How it works

### 1. The book

Orders that can't trade yet wait in the book, on two sides:

```text
          price    qty   orders (oldest first)
  ask    102.00    200   #3
  ask    101.50    150   #1 (100)  #2 (50)       ← best ask: lowest price someone will sell at
  ------ spread 0.50 ------
  bid    101.00     80   #4                      ← best bid: highest price someone will pay
  bid    100.50     40   #5
```

The best bid is always below the best ask. If they met, those two orders would trade, so a resting book is never "crossed".
The gap between them is the **spread**.

In code, each side is a `BTreeMap<Price, Level>`, a sorted map, so the best price is the first key (asks) or the last key (bids).
Each `Level` is a `VecDeque` of orders: a queue where new orders join at the back and trades take from the front.

```rust
pub struct OrderBook {
    bids: BTreeMap<Price, Level>, // best bid = highest key
    asks: BTreeMap<Price, Level>, // best ask = lowest key
    resting: HashMap<OrderId, (Side, Price)>, // where each order is, for cancel
    ...
}
```

### 2. Price-time priority

When a buy order for 120 at up to 101.75 arrives:

1. Look at the **best ask**: 101.50. That's ≤ 101.75, so a trade is possible.
2. Take the **oldest** order at that price, #1, and trade 100 (all of #1).
3. #1 is used up, so the next one in the queue, #2, sells the remaining 20. #2 has 30 left and keeps its place.
4. The buyer is filled, so it's done. Had there been some left, the engine would try the next price level (102.00 is too expensive), and then **rest** the remainder at 101.75.

The trade price is the **resting order's** price (101.50), not the incoming one's (101.75). The order that was waiting set the price; the newcomer accepted it.
Arriving earlier at the same price gets you served first, and that's why traders care about their place in the queue.

### 3. Prices are integers

`101.50` is stored as `10150` paise. With floating point, `0.1 + 0.2 != 0.3`, so two orders at "the same price" might never match.
Integers are exact, and they also make good `BTreeMap` keys (`f64` doesn't even implement `Ord`).

### 4. Modify: when do you lose your place?

Real exchanges follow one rule, and so does this engine:

- **Lowering the quantity** keeps your place. It only makes you less of an obstacle to the people behind you.
- **Raising the quantity or changing the price** sends you to the back of the queue, as if you'd cancelled and sent a new order. Otherwise anyone could join early with 1 share and later raise it to 10,000, jumping the queue.

A price change can even trade straight away, if the new price crosses the spread.

### 5. Everything is an event

The engine never prints anything. It returns a list of events (`Accepted`, `Trade`, `Rested`, `Cancelled`, `Rejected`, `Modified`), and the caller decides what to do with them.
That keeps the engine easy to test, since a test just compares event lists. It's also how real exchanges work: the same events become order confirmations for traders and the public market data feed.

## How it's tested

- **18 scenario tests**, one for each rule: price priority, time priority, trade price, partial fills, every order type, cancel, both kinds of modify, rejections, and the command parser.
- **A reference implementation** (`tests/reference.rs`) that keeps all orders in one flat `Vec` and, for every match, searches the whole list for the best order. It's hopelessly slow, but short enough to check by reading. **175,000 random commands** (orders of every type, cancels and modifies, on tight and wide markets) are fed to both, and the events must be *identical*. The book's internal consistency is also checked after every single command.
- **Quantity conservation:** every share of every order ends up traded, resting or cancelled, never lost or created.

To check that these tests really catch mistakes, small bugs were planted on purpose, for example joining the queue at the front instead of the back, or `<` instead of `<=` in fill-or-kill. The reference comparison failed every time.

## Performance

```text
$ matchbook --bench
1000000 commands in 0.205 s: 4.88 million per second
559534 trades, 2049608 events, 51861 orders left resting, 205 ns per command
```

That's a single thread, measured on the machine the tests ran on (your numbers will differ). Finding the best price is O(log n) in the number of price levels, and matching at a level is O(1) per fill.
**Cancel is the weak spot:** it searches its price level's queue, which is O(orders at that price). With a million orders resting at a few prices, that adds up. See exercise 1.

## What you'll learn

- How a stock exchange matches orders: bids, asks, spread, price-time priority, and who sets the trade price
- What limit, market, IOC, FOK and post-only orders really do
- Choosing data structures for a job: `BTreeMap` for sorted prices, `VecDeque` for FIFO queues, `HashMap` for lookups by id
- Why money and prices should be integers
- Rust: enums with data, `match`, `BTreeMap` entries, and the borrow checker's split borrows of struct fields
- Differential testing against a simple oracle, plus mutation testing your own tests

## Try it yourself

1. **O(1) cancel.** Store orders in a slab (`Vec` with free slots) and link each level's orders into a doubly linked list by index. Cancel then unlinks in constant time. Compare with `--bench 5000000`.
2. **Self-trade prevention.** Give orders an owner and stop a trader's buy from matching their own sell (exchanges require this).
3. **Stop orders.** A stop-loss sells at market once the last trade price falls to a trigger price.
4. **Iceberg orders.** Show only part of a large order; when the visible part fills, the next slice joins the *back* of the queue.
5. **An NSE-style tick size.** Most NSE stocks move in steps of ₹0.05. Reject prices that aren't a multiple of the tick.

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
