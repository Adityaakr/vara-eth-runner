use ::orderbook_client::{OrderbookClient as _, OrderbookClientCtors as _, book::*};
#[allow(unused_imports)]
use sails_rs::{client::*, gtest::*, prelude::*};

const BID: u32 = 0;
const ASK: u32 = 1;

#[tokio::test]
async fn place_match_cancel_round_trip() {
    let env = GtestEnv::system_default();
    let code_id = env.system().submit_code(::orderbook::WASM_BINARY);

    let program = env
        .deploy::<::orderbook_client::OrderbookClientProgram>(code_id, b"salt".to_vec())
        .create()
        .await
        .unwrap();

    let mut book = program.book();

    assert_eq!(book.seq().await.unwrap(), 0);

    let ask = book.place(ASK, 100, 5).await.unwrap();
    let bid = book.place(BID, 101, 8).await.unwrap(); // fills 5 at 100, rests 3 at 101
    assert_eq!((ask, bid), (1, 2));

    let view = book.book().await.unwrap();
    assert!(view.asks.is_empty());
    assert_eq!(view.bids.len(), 1);
    assert_eq!(view.bids[0].qty, 3);
    assert_eq!(view.recent_fills.len(), 1);
    assert_eq!(view.recent_fills[0].price, 100);
    assert_eq!(view.seq, 3, "ask placed=1, fill=2, bid placed=3");

    assert!(book.cancel(bid).await.unwrap());
    assert!(book.book().await.unwrap().bids.is_empty());

    // Eth-format events (topics + ABI data) are not decodable by the Sails client listener in gtest
    // (`sails-rs/src/client/mod.rs` decode_event_v1/v2 expect a Sails header), so event content is
    // asserted in the app's unit tests and on Ethereum logs by the lab-server tests.
}
