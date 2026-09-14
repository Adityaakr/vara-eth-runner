#![no_std]

//! The cheapest possible program for throughput measurement: one counter, no events, no allocation.

use core::cell::RefCell;
use sails_rs::prelude::*;

#[derive(Default)]
pub struct CounterState {
    pub count: u64,
}

struct Counter<S: StateMut<Item = CounterState, Error = Infallible> = RefCell<CounterState>> {
    state: S,
}

impl<S: StateMut<Item = CounterState, Error = Infallible>> Counter<S> {
    pub fn new(state: S) -> Self {
        Self { state }
    }
}

#[sails_rs::service]
impl<S: StateMut<Item = CounterState, Error = Infallible>> Counter<S> {
    /// Increment and return the new count.
    #[export]
    pub fn ping(&mut self) -> u64 {
        let mut state = self.state.get_mut();
        state.count += 1;
        state.count
    }

    #[export]
    pub fn count(&self) -> u64 {
        self.state.get().count
    }
}

#[derive(Default)]
pub struct Program {
    counter_state: RefCell<CounterState>,
}

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        Self::default()
    }

    pub fn counter(&self) -> Counter<&RefCell<CounterState>> {
        Counter::new(&self.counter_state)
    }
}
