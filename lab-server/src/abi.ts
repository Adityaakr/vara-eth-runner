// Event ABI of the orderbook program as emitted on the Mirror contract. Signatures come from
// `cargo sails sol` output (abi/Orderbook.sol) and were checked against live Anvil logs.
import { parseAbi } from 'viem';

export const ORDERBOOK_EVENTS_ABI = parseAbi([
  'event Placed(uint64 indexed id, uint64 seq, address owner, uint32 side, uint64 price, uint64 qty)',
  'event Filled(uint64 indexed taker, uint64 indexed maker, uint64 seq, uint64 price, uint64 qty)',
  'event Cancelled(uint64 indexed id, uint64 seq)',
  // Mirror's own reply event (IMirror.sol:107); ties an L1 message id to the program's reply payload.
  'event Reply(bytes payload, uint128 value, bytes32 replyTo, bytes4 indexed replyCode)',
]);
