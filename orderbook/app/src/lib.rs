#![no_std]

//! A minimal price-time-priority order book for the Vara.eth pre-confirmation lab.
//!
//! Every state change emits exactly one Ethereum-style event per logical step, each stamped with a
//! monotonically increasing `seq`. Replaying the events yields the same book as querying it, which is
//! what lets the lab compare the validator's pre-confirmed view with the Ethereum-committed view.

use core::cell::RefCell;
use sails_rs::prelude::*;

/// Upper bound on resting orders per side. Programs pay for state, so growth must be capped.
pub const MAX_RESTING_PER_SIDE: usize = 256;
/// Number of most recent fills kept for the `book` query.
pub const MAX_RECENT_FILLS: usize = 64;
/// Fills one `place` may perform. Every fill emits an event and ethexe allows 4 outgoing messages per
/// execution (`MAX_OUTGOING_MESSAGES_PER_EXECUTION` in ethexe-runtime-common; the 5th fails with
/// `OutgoingMessagesAmountLimitExceeded`). 3 fills + 1 `Placed` = 4. An order needing more fills
/// executes these and rests the remainder, like a per-transaction match limit on a venue.
pub const MAX_FILLS_PER_ORDER: usize = 3;

pub const SIDE_BID: u32 = 0;
pub const SIDE_ASK: u32 = 1;

#[sails_rs::sails_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    fn from_u32(raw: u32) -> Self {
        match raw {
            SIDE_BID => Side::Bid,
            SIDE_ASK => Side::Ask,
            _ => panic!("side must be 0 (bid) or 1 (ask)"),
        }
    }

    fn as_u32(self) -> u32 {
        match self {
            Side::Bid => SIDE_BID,
            Side::Ask => SIDE_ASK,
        }
    }
}

#[sails_rs::sails_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u64,
    pub owner: Address,
    pub side: Side,
    pub price: u64,
    pub qty: u64,
}

#[sails_rs::sails_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub seq: u64,
    pub taker: u64,
    pub maker: u64,
    pub price: u64,
    pub qty: u64,
}

/// Snapshot returned by the `book` query. Bids are sorted best-first (price desc, id asc),
/// asks best-first (price asc, id asc).
#[sails_rs::sails_type]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct BookView {
    pub seq: u64,
    pub next_id: u64,
    pub bids: Vec<Order>,
    pub asks: Vec<Order>,
    pub recent_fills: Vec<Fill>,
}

#[derive(Clone)]
pub struct BookState {
    pub seq: u64,
    pub next_id: u64,
    pub bids: Vec<Order>,
    pub asks: Vec<Order>,
    pub recent_fills: Vec<Fill>,
}

impl Default for BookState {
    fn default() -> Self {
        Self {
            seq: 0,
            next_id: 1,
            bids: Vec::new(),
            asks: Vec::new(),
            recent_fills: Vec::new(),
        }
    }
}

/// Ethereum-style events. `qty` in `Placed` is the quantity left resting after matching.
#[sails_rs::event]
#[sails_rs::sails_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BookEvents {
    Placed {
        #[indexed]
        id: u64,
        seq: u64,
        owner: Address,
        side: u32,
        price: u64,
        qty: u64,
    },
    Filled {
        #[indexed]
        taker: u64,
        #[indexed]
        maker: u64,
        seq: u64,
        price: u64,
        qty: u64,
    },
    Cancelled {
        #[indexed]
        id: u64,
        seq: u64,
    },
}

struct Book<S: StateMut<Item = BookState, Error = Infallible> = RefCell<BookState>> {
    state: S,
}

impl<S: StateMut<Item = BookState, Error = Infallible>> Book<S> {
    pub fn new(state: S) -> Self {
        Self { state }
    }
}

#[sails_rs::service(events = BookEvents)]
impl<S: StateMut<Item = BookState, Error = Infallible>> Book<S> {
    /// Place an order. Matches against the opposite side, rests any remainder. Returns the order id.
    #[export]
    pub fn place(&mut self, side: u32, price: u64, qty: u64) -> u64 {
        let side = Side::from_u32(side);
        assert!(price > 0, "price must be positive");
        assert!(qty > 0, "qty must be positive");
        let owner = Address::from(Syscall::message_source());

        let (id, fills, remaining, placed_seq) = {
            let mut state = self.state.get_mut();
            // Capacity is checked before any mutation so a rejected order never half-executes.
            let resting_len = match side {
                Side::Bid => state.bids.len(),
                Side::Ask => state.asks.len(),
            };
            assert!(resting_len < MAX_RESTING_PER_SIDE, "book full");
            let id = state.next_id;
            state.next_id += 1;
            let (fills, remaining) = match_against_book(&mut state, side, price, qty, id);
            if remaining > 0 {
                let book = match side {
                    Side::Bid => &mut state.bids,
                    Side::Ask => &mut state.asks,
                };
                insert_sorted(
                    book,
                    Order {
                        id,
                        owner,
                        side,
                        price,
                        qty: remaining,
                    },
                );
            }
            state.seq += 1;
            (id, fills, remaining, state.seq)
        };
        for fill in fills {
            self.emit_eth_event(BookEvents::Filled {
                taker: fill.taker,
                maker: fill.maker,
                seq: fill.seq,
                price: fill.price,
                qty: fill.qty,
            })
            .unwrap();
        }
        self.emit_eth_event(BookEvents::Placed {
            id,
            seq: placed_seq,
            owner,
            side: side.as_u32(),
            price,
            qty: remaining,
        })
        .unwrap();
        id
    }

    /// Cancel a resting order. Only the owner may cancel. Returns false if not found or not owned.
    #[export]
    pub fn cancel(&mut self, id: u64) -> bool {
        let caller = Address::from(Syscall::message_source());
        let seq = {
            let mut state = self.state.get_mut();
            let removed = remove_order(&mut state.bids, id, &caller)
                || remove_order(&mut state.asks, id, &caller);
            if !removed {
                return false;
            }
            state.seq += 1;
            state.seq
        };
        self.emit_eth_event(BookEvents::Cancelled { id, seq }).unwrap();
        true
    }

    /// Full book snapshot. SCALE only: custom DTOs are not ABI-encoded.
    #[export(scale)]
    pub fn book(&self) -> BookView {
        let state = self.state.get();
        BookView {
            seq: state.seq,
            next_id: state.next_id,
            bids: state.bids.clone(),
            asks: state.asks.clone(),
            recent_fills: state.recent_fills.clone(),
        }
    }

    /// Event sequence number reached by the program state.
    #[export]
    pub fn seq(&self) -> u64 {
        self.state.get().seq
    }
}

/// Best-first ordering: bids by price desc, asks by price asc; ties by id asc (time priority).
fn ranks_before(a: &Order, b: &Order) -> bool {
    if a.price != b.price {
        match a.side {
            Side::Bid => a.price > b.price,
            Side::Ask => a.price < b.price,
        }
    } else {
        a.id < b.id
    }
}

fn insert_sorted(book: &mut Vec<Order>, order: Order) {
    let pos = book.partition_point(|resting| ranks_before(resting, &order));
    book.insert(pos, order);
}

fn crosses(taker_side: Side, taker_price: u64, maker_price: u64) -> bool {
    match taker_side {
        Side::Bid => maker_price <= taker_price,
        Side::Ask => maker_price >= taker_price,
    }
}

/// Walk the opposite side best-first, filling at the maker's price. Each fill bumps `seq` and is
/// recorded in `recent_fills`. Returns the fills produced and the taker's unfilled remainder.
fn match_against_book(
    state: &mut BookState,
    taker_side: Side,
    taker_price: u64,
    taker_qty: u64,
    taker_id: u64,
) -> (Vec<Fill>, u64) {
    let mut remaining = taker_qty;
    let mut fills = Vec::new();
    let opposite = match taker_side {
        Side::Bid => &mut state.asks,
        Side::Ask => &mut state.bids,
    };
    while remaining > 0 && fills.len() < MAX_FILLS_PER_ORDER {
        let Some(maker) = opposite.first_mut() else { break };
        if !crosses(taker_side, taker_price, maker.price) {
            break;
        }
        let qty = remaining.min(maker.qty);
        state.seq += 1;
        fills.push(Fill {
            seq: state.seq,
            taker: taker_id,
            maker: maker.id,
            price: maker.price,
            qty,
        });
        remaining -= qty;
        maker.qty -= qty;
        if maker.qty == 0 {
            opposite.remove(0);
        }
    }
    for fill in &fills {
        if state.recent_fills.len() == MAX_RECENT_FILLS {
            state.recent_fills.remove(0);
        }
        state.recent_fills.push(fill.clone());
    }
    (fills, remaining)
}

fn remove_order(book: &mut Vec<Order>, id: u64, caller: &Address) -> bool {
    match book.iter().position(|o| o.id == id) {
        Some(pos) if &book[pos].owner == caller => {
            book.remove(pos);
            true
        }
        _ => false,
    }
}

#[derive(Default)]
pub struct Program {
    book_state: RefCell<BookState>,
}

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        Self::default()
    }

    pub fn book(&self) -> Book<&RefCell<BookState>> {
        Book::new(&self.book_state)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use sails_rs::gstd::services::Service as _;

    fn actor(n: u8) -> ActorId {
        ActorId::from([n; 32])
    }

    #[test]
    fn resting_orders_are_sorted_best_first() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        let a = svc.place(SIDE_ASK, 105, 10);
        let b = svc.place(SIDE_ASK, 101, 10);
        let c = svc.place(SIDE_ASK, 101, 5);
        let d = svc.place(SIDE_BID, 90, 7);
        let e = svc.place(SIDE_BID, 95, 7);
        let view = svc.book();
        assert_eq!(view.asks.iter().map(|o| o.id).collect::<Vec<_>>(), vec![b, c, a]);
        assert_eq!(view.bids.iter().map(|o| o.id).collect::<Vec<_>>(), vec![e, d]);
        assert_eq!(view.seq, 5);
        assert_eq!(view.next_id, 6);
    }

    #[test]
    fn crossing_bid_fills_at_maker_price_with_price_time_priority() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        let ask_late_cheap = svc.place(SIDE_ASK, 100, 5); // id 1
        let ask_early_dear = svc.place(SIDE_ASK, 102, 5); // id 2
        let ask_same_price_later = svc.place(SIDE_ASK, 100, 5); // id 3

        Syscall::with_message_source(actor(2));
        let taker = svc.place(SIDE_BID, 102, 12); // crosses 1 (5), 3 (5), then 2 (2)

        let view = svc.book();
        assert!(view.bids.is_empty(), "taker fully filled, nothing rests");
        assert_eq!(view.asks.len(), 1);
        assert_eq!(view.asks[0].id, ask_early_dear);
        assert_eq!(view.asks[0].qty, 3);
        let fills: Vec<(u64, u64, u64, u64)> = view
            .recent_fills
            .iter()
            .map(|f| (f.taker, f.maker, f.price, f.qty))
            .collect();
        assert_eq!(
            fills,
            vec![
                (taker, ask_late_cheap, 100, 5),
                (taker, ask_same_price_later, 100, 5),
                (taker, ask_early_dear, 102, 2),
            ]
        );
        // 3 placements + 3 fills + 1 placed-event for the taker
        assert_eq!(view.seq, 7);
        use sails_rs::gstd::services::ExposureWithEvents as _;
        let events = svc.emitter().take_events();
        let seqs: Vec<u64> = events
            .iter()
            .map(|e| match e {
                BookEvents::Placed { seq, .. } | BookEvents::Filled { seq, .. } | BookEvents::Cancelled { seq, .. } => *seq,
            })
            .collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6, 7], "one event per seq, in order");
        assert!(matches!(events[6], BookEvents::Placed { id, qty: 0, .. } if id == taker));
    }

    #[test]
    fn partial_fill_rests_remainder() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        svc.place(SIDE_BID, 50, 4);
        Syscall::with_message_source(actor(2));
        let ask = svc.place(SIDE_ASK, 49, 10);
        let view = svc.book();
        assert!(view.bids.is_empty());
        assert_eq!(view.asks[0].id, ask);
        assert_eq!(view.asks[0].qty, 6);
        assert_eq!(view.recent_fills[0].price, 50, "fills at the resting maker's price");
    }

    #[test]
    fn cancel_is_owner_only() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        let id = svc.place(SIDE_BID, 10, 1);
        Syscall::with_message_source(actor(2));
        assert!(!svc.cancel(id));
        Syscall::with_message_source(actor(1));
        assert!(svc.cancel(id));
        assert!(!svc.cancel(id), "already gone");
        assert!(svc.book().bids.is_empty());
        assert_eq!(svc.seq(), 2);
    }

    #[test]
    fn full_side_rejects_before_matching_anything() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        for _ in 0..MAX_RESTING_PER_SIDE {
            svc.place(SIDE_BID, 1, 1);
        }
        let ask = svc.place(SIDE_ASK, 99, 4);
        let seq_before = svc.seq();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut svc = Book::new(&state).expose(0);
            svc.place(SIDE_BID, 100, 10)
        }));
        assert!(outcome.is_err(), "bid side is full: must be rejected");
        let view = Book::new(&state).expose(0).book();
        assert_eq!(view.seq, seq_before, "nothing executed before the rejection");
        assert_eq!(view.asks[0].id, ask);
        assert_eq!(view.asks[0].qty, 4);
        assert!(view.recent_fills.is_empty());
    }

    #[test]
    fn a_sweep_is_capped_per_order_and_the_remainder_rests() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        for i in 0..30u64 {
            svc.place(SIDE_BID, 500 + i, 1);
        }
        let ask = svc.place(SIDE_ASK, 1, 200);
        let view = svc.book();
        assert_eq!(view.recent_fills.len(), MAX_FILLS_PER_ORDER);
        assert_eq!(view.bids.len(), 30 - MAX_FILLS_PER_ORDER, "only the capped number of makers were consumed");
        assert_eq!(view.asks.len(), 1);
        assert_eq!(view.asks[0].id, ask);
        assert_eq!(view.asks[0].qty, 200 - MAX_FILLS_PER_ORDER as u64, "remainder rests even though bids remain");
    }

    #[test]
    #[should_panic(expected = "qty must be positive")]
    fn rejects_zero_qty() {
        Syscall::with_message_source(actor(1));
        let state = RefCell::new(BookState::default());
        let mut svc = Book::new(&state).expose(0);
        svc.place(SIDE_BID, 1, 0);
    }
}
