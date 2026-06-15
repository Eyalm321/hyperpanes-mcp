# Cross-language wire fixtures

## `task-wire.golden.json`

The canonical serialized form of a fully-populated `Task`. It is **owned by the
Rust work queue** (`rs/crates/core/src/control/work.rs`) and was derived by
running a fully-populated `Task` through `serde_json::to_string_pretty` — not
hand-written. The Rust serialization is **authoritative**; `src/worker-pool/kinds.ts`
mirrors it.

This is the contract the controller's `Task` type must accept verbatim:
camelCase keys, epoch-ms NUMBER timestamps, and a FLATTENED lease
(`claimedBy` / `fencingToken` / `visibilityDeadline` at the top level — never a
nested `lease` object).

> **MUST stay byte-identical** with its twin in the Rust repo:
> `hp-integration/rs/crates/core/tests/fixtures/task-wire.golden.json`.
> Both copies are checked by a contract test in each repo. If you regenerate this
> golden, update BOTH copies in the same change or the contract tests break.
