#![no_std]

//! A minimal balance ledger for the Vara.eth pre-confirmation lab's wallet: a `transfer` that emits
//! exactly one Ethereum-style event, a one-time `faucet` so a fresh passkey account has something to
//! send, and a `balance_of` query.

use core::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::prelude::*;

/// Credited to an account the first time it calls `faucet`.
pub const FAUCET_AMOUNT: u64 = 1_000;

#[derive(Default)]
pub struct LedgerState {
    pub seq: u64,
    pub balances: BTreeMap<Address, u64>,
    pub faucet_used: BTreeMap<Address, ()>,
}

#[sails_rs::event]
#[sails_rs::sails_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LedgerEvents {
    Transfer {
        #[indexed]
        from: Address,
        #[indexed]
        to: Address,
        amount: u64,
        seq: u64,
    },
    Minted {
        #[indexed]
        to: Address,
        amount: u64,
        seq: u64,
    },
}

struct Ledger<S: StateMut<Item = LedgerState, Error = Infallible> = RefCell<LedgerState>> {
    state: S,
}

impl<S: StateMut<Item = LedgerState, Error = Infallible>> Ledger<S> {
    pub fn new(state: S) -> Self {
        Self { state }
    }
}

#[sails_rs::service(events = LedgerEvents)]
impl<S: StateMut<Item = LedgerState, Error = Infallible>> Ledger<S> {
    /// Move `amount` from the caller to `to`. Returns the caller's new balance.
    #[export]
    pub fn transfer(&mut self, to: Address, amount: u64) -> u64 {
        assert!(amount > 0, "amount must be positive");
        let from = Address::from(Syscall::message_source());
        let (new_balance, seq) = {
            let mut state = self.state.get_mut();
            let have = state.balances.get(&from).copied().unwrap_or(0);
            assert!(have >= amount, "insufficient balance");
            state.balances.insert(from, have - amount);
            let dest = state.balances.get(&to).copied().unwrap_or(0);
            state.balances.insert(to, dest.checked_add(amount).expect("balance overflow"));
            state.seq += 1;
            (have - amount, state.seq)
        };
        self.emit_eth_event(LedgerEvents::Transfer { from, to, amount, seq }).unwrap();
        new_balance
    }

    /// Credit the caller once. Returns the caller's balance afterwards; a second call panics.
    #[export]
    pub fn faucet(&mut self) -> u64 {
        let who = Address::from(Syscall::message_source());
        let (balance, seq) = {
            let mut state = self.state.get_mut();
            assert!(state.faucet_used.insert(who, ()).is_none(), "faucet already used");
            let have = state.balances.get(&who).copied().unwrap_or(0);
            let balance = have + FAUCET_AMOUNT;
            state.balances.insert(who, balance);
            state.seq += 1;
            (balance, state.seq)
        };
        self.emit_eth_event(LedgerEvents::Minted { to: who, amount: FAUCET_AMOUNT, seq }).unwrap();
        balance
    }

    #[export]
    pub fn balance_of(&self, who: Address) -> u64 {
        self.state.get().balances.get(&who).copied().unwrap_or(0)
    }

    #[export]
    pub fn seq(&self) -> u64 {
        self.state.get().seq
    }
}

#[derive(Default)]
pub struct Program {
    ledger_state: RefCell<LedgerState>,
}

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        Self::default()
    }

    pub fn ledger(&self) -> Ledger<&RefCell<LedgerState>> {
        Ledger::new(&self.ledger_state)
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
    fn faucet_then_transfer_moves_balance_and_emits_one_event_each() {
        use sails_rs::gstd::services::ExposureWithEvents as _;
        let state = RefCell::new(LedgerState::default());
        let mut svc = Ledger::new(&state).expose(0);
        Syscall::with_message_source(actor(1));
        assert_eq!(svc.faucet(), FAUCET_AMOUNT);
        let bob = Address::from(actor(2));
        assert_eq!(svc.transfer(bob, 10), FAUCET_AMOUNT - 10);
        assert_eq!(svc.balance_of(bob), 10);
        assert_eq!(svc.balance_of(Address::from(actor(1))), FAUCET_AMOUNT - 10);
        assert_eq!(svc.seq(), 2);
        let events = svc.emitter().take_events();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[1], LedgerEvents::Transfer { amount: 10, seq: 2, .. }));
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn cannot_overspend() {
        let state = RefCell::new(LedgerState::default());
        let mut svc = Ledger::new(&state).expose(0);
        Syscall::with_message_source(actor(1));
        svc.transfer(Address::from(actor(2)), 1);
    }

    #[test]
    #[should_panic(expected = "faucet already used")]
    fn faucet_is_once_per_account() {
        let state = RefCell::new(LedgerState::default());
        let mut svc = Ledger::new(&state).expose(0);
        Syscall::with_message_source(actor(1));
        svc.faucet();
        svc.faucet();
    }
}
