# The MCP Retry Contract (draft 0.1)

**A machine-readable declaration of what happens when a tool is called twice.**

Status: draft, request-for-comment. Nothing here is settled. It exists because scanning code and *inferring* retry-safety — which is what [fencescan](https://github.com/aurumflux20/fencescan) does — has a ceiling: an outsider reading a repository usually cannot prove a double-fire, because the guard often lives in a backend the code calls. The honest fix is not a smarter scanner. It is for the tool to **declare** its retry behaviour, and for the scanner to check the declaration against the code.

This draft owes its shape to a reader (`mads_hansen` on the [671-server writeup](https://dev.to/aurumflux20/we-scanned-671-mcp-servers-to-see-what-happens-when-an-agent-retries-3pnc)) who pointed out that inferring safety from patterns is strictly weaker than validating a declared contract. Credited with permission.

---

## Why a contract, not a scanner

The caller of an MCP tool is a language model. When a call fails ambiguously — a timeout, a dropped connection — the model's instinct is to try again. Whether that's safe depends on facts the model cannot see:

- Did the first attempt actually land?
- Does the server deduplicate a repeat?
- If it does, on what key, and for how long?

None of that is in the tool's schema today. The model is guessing, and the most common guess — "the error means it didn't happen" — is exactly the one that double-charges a card.

A retry contract puts those facts where the caller (and a scanner, and a human auditor) can read them: in the tool declaration itself.

## The shape

A tool MAY declare a `retryContract` object. Every field is optional; a tool that declares none is treated as `effectClass: "unknown"`, which is the honest default — not "safe".

```jsonc
{
  "name": "create_payment",
  "description": "...",
  "retryContract": {
    // What kind of effect a call has. The single most important field.
    "effectClass": "irreversible",   // "read" | "idempotent" | "reversible" | "irreversible" | "unknown"

    // Can the caller mark two attempts as the same attempt?
    "callerKey": {
      "supported": true,
      "field": "idempotencyKey",     // where the caller puts it
      "scope": "account",            // "global" | "account" | "session" | "none"
      "retentionSeconds": 86400      // how long a key is remembered; null = unknown
    },

    // What happens if the SAME key arrives with a DIFFERENT payload?
    "duplicateKeyDifferentPayload": "reject",  // "reject" | "replace" | "ignore" | "unknown"

    // After an ambiguous failure, can the caller find out what happened?
    "ambiguousTimeout": {
      "recoverable": true,
      "reconcileVia": "get_payment", // a read tool that answers "did it land?"
      "reconcileBy": "id"            // what handle the read needs
    },

    // Does correctness depend on a backend the caller can't see?
    "downstreamDedup": "relied-upon" // "none" | "relied-upon" | "unknown"
  }
}
```

## The fields, and why each exists

**`effectClass`** — the load-bearing field.
- `read` — no effect; retry freely.
- `idempotent` — repeating produces the same result (declarative apply, PUT-by-id). Retry freely.
- `reversible` — a duplicate can be undone (a draft, a soft-delete). Retry with cleanup.
- `irreversible` — a duplicate cannot be taken back (a charge, an email, an on-chain send). **Do not retry blind.**
- `unknown` — not declared. Treated as `irreversible` for safety, because the cost of guessing wrong is asymmetric.

**`callerKey`** — whether the caller can supply an idempotency key, *and its scope and lifetime*. Scope matters: a key unique per session doesn't protect against a retry from a fresh process sharing the same account. Retention matters more: a key remembered for 24h means a retry after 24h is a fresh effect — the single most common idempotency bug in the wild.

**`duplicateKeyDifferentPayload`** — the subtle one. If the same key arrives with a different body, `reject` is safe (the caller made a mistake and is told). `replace` and `ignore` can silently lose data. A contract that claims idempotency but doesn't say this is under-specified.

**`ambiguousTimeout`** — after "I don't know", is there a read tool that turns it into "confirmed" or "absent"? If `reconcileVia` is present, a caller can recover without guessing. If it's absent, the only safe move on a timeout is to escalate to a human — and the contract should say so rather than imply the retry is fine.

**`downstreamDedup`** — the honesty field. If correctness depends on a backend the repository doesn't contain (`relied-upon`), a scanner reading the code *cannot verify it* and must not claim the tool is safe or unsafe. This field is what lets the contract be checked honestly: it marks the boundary of what's provable from the code alone.

## What a validator does with it

A scanner (fencescan, or anyone's) can then do something it currently cannot: **compare the declaration to the code.**

- Declares `effectClass: "idempotent"` but the handler does a bare `POST` that creates an entity, with no key check? → contradiction, flag it.
- Declares `callerKey.supported: true` but no parameter by that name reaches the request? → the key is decorative; flag it.
- Declares `ambiguousTimeout.recoverable: true` with a `reconcileVia` tool that doesn't exist in the server? → dangling promise; flag it.
- Declares `downstreamDedup: "relied-upon"`? → the scanner reports "cannot verify from code; ask the maintainer" instead of a false verdict.

The contract doesn't replace the scanner. It gives the scanner something true to check against, and turns every finding from "we inferred this might be unsafe" into "your declaration and your code disagree" — which is a claim the maintainer can act on without arguing about whether the scanner understood their backend.

## Open questions (this is a draft)

1. Where does the contract live — in the tool's `annotations`, a sibling field, or a separate manifest? MCP already has `annotations` with `readOnlyHint` / `destructiveHint`; this is a natural extension of that vocabulary, not a competitor to it.
2. Should `effectClass` reuse or align with the existing MCP hint annotations rather than introduce new terms?
3. Is `retentionSeconds` too precise to expect maintainers to know? Maybe a coarse enum (`short` / `long` / `permanent` / `unknown`).
4. What's the minimum viable contract — the two or three fields worth declaring even if nothing else is?

Comments, holes, and disagreement wanted. Open an issue on [fencescan](https://github.com/aurumflux20/fencescan). A false sense of safety from an under-specified contract would be worse than no contract, so the goal is to get the honesty boundaries right before the convenience.
