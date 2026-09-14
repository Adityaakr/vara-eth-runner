# vendor/

`vara-eth-api-0.6.0-rc.0.tgz` is `@vara-eth/api` exactly as shipped inside `vara-wallet` 0.20.6 (`npm pack` of its
`node_modules/@vara-eth/api`). npm only carries 0.5.x. License: GPL-3.0 (upstream gear-tech).

Against a gear v2.0.0 node it needs one adjustment, applied in `lab-server/src/engine.ts` (`createInjectedTx`): the node
has no `version` RPC, so the library picks the legacy `{recipient, tx}` envelope (correct) and the legacy digest
(wrong; the node signs `InjectedTransaction::to_hashable_bytes`). The instance override points the digest at the
current byte layout.
