# fencescan

**Find tool calls that could fire the same effect twice.**

```bash
npx fencescan
```

No install, no dependencies, no network, no config. Scans the current directory
and prints what's worth a second look.

## What it does

An agent that retries a tool call after a timeout doesn't know whether the first
attempt landed. The request reached the server, the work happened, the response
never came back. Nothing failed loudly — it succeeded twice.

`fencescan` reads your code and lists the tools where that would cost you
something, alongside what else it found: write call sites, anything that looks
like an idempotency guard, and retry logic.

```
fencescan /your/mcp-server
  42 files · 11 tool declarations found

Tools worth checking  (candidates, not verdicts)
  money   createCampaign   src/tools/ads.py:609 · 12 write call(s) in this file
  money   chargeAccount    src/tools/billing.py:88
  effect  sendTemplate     src/tools/whatsapp.py:151

What else is in this codebase
  59 write call site(s)
  0 idempotency-looking guard(s)  ← none found in this repo
  14 retry site(s)

Worth a close look: retry logic and no visible dedup key.
```

## What it deliberately does not do

**It renders no verdict.** There is no risk score, no "AT RISK", no severity.
An outsider reading a codebase usually *cannot* prove a double-fire: the guard
often lives in a service the code calls or a sibling package, and a function
whose name sounds like a write may only build a payload for someone else to
sign. Every run prints what it cannot see.

This isn't modesty. An earlier version did print verdicts, and hand-verification
killed **4 of its first 7**. Each of those failures is now a fixed behaviour with
a test:

| It got this wrong | Why | Fixed by |
|---|---|---|
| Said a repo had no idempotency when it shipped a whole module | `\b(idempot…)` cannot match `deriveIdempotencyKey` — no word boundary before a mid-word capital. Same blindness hid `requestId`, `clientToken` | anchors removed |
| Flagged read-only tools | A flat window after a tool name ran into the *next* declaration, so reads inherited writes' vocabulary | brace-matched to the tool's own block; a read verb in the name vetoes |
| Found no writes at all | Writes live in shared helpers, not in the tool declaration | collected per file as corroboration, never claimed as "this tool writes" |
| Missed `method: body ? "POST" : "GET"` | String literals were stripped before matching — but the HTTP verb *is* a literal | matched on the raw line |

If it flags something and you're sure it's wrong, that's worth an issue. A false
positive here costs more than a miss.

## Usage

```bash
npx fencescan              # scan the current directory
npx fencescan ./server     # scan a path
npx fencescan --json       # machine-readable
```

Exit codes: `0` scanned, `2` bad path. It never exits non-zero for findings —
findings are for a human to read, not for a build to fail on.

Recognises MCP-style tool declarations (`registerTool`, `@mcp.tool`, `Tool(...)`,
`@tool`) across TypeScript, JavaScript, Python, Go, Rust, Java and Ruby.

## If it finds nothing

A clean scan prints a badge you can paste into your README:

[![fencescan: 0 candidates](https://img.shields.io/badge/fencescan-0_candidates-brightgreen)](https://github.com/aurumflux20/fencescan)

```markdown
[![fencescan: 0 candidates](https://img.shields.io/badge/fencescan-0_candidates-brightgreen)](https://github.com/aurumflux20/fencescan)
```

It claims exactly what happened — the scan found zero candidates — and nothing
more. Not "safe": that is a claim no scanner can make, since the guard may live
in a service it cannot read. Anyone can re-run `npx fencescan` to check you.

## If it finds something

Open each candidate and ask one question: **if this ran twice, would anyone
notice?**

If the answer is no, that's the bug — not the crash you'd have caught.

For fixes: [`once`](https://github.com/aurumflux20/once-kernel-ts) is an
exactly-once kernel for TypeScript and Python, and
[`effectfence`](https://github.com/aurumflux20/effectfence) is an MCP server that
fences tool calls. Both free. If you'd rather someone did the work,
[the Fence Audit](https://github.com/aurumflux20/effectfence/blob/main/SUPPORT.md).

## Licence

MIT
