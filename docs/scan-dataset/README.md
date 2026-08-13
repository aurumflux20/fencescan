# MCP retry-safety scan — corpus v1

Structural scan of published MCP servers, released so the numbers quoted in
[modelcontextprotocol#3188](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3188)
can be checked rather than taken on trust.

No server names, owners or URLs are included. Each row carries a salted hash so
rows stay joinable across corpus versions without being re-identifiable.

## Files

| File | What it is |
|---|---|
| `aggregate.json` | The headline numbers, exactly as quoted in the discussion |
| `rows.csv` | One anonymized row per scanned repo |

`rows.csv` columns: `id`, `downloads_bucket`, `files`, `tools`, `writes`,
`guards`, `retries`, `candidates`, `patterns`.

## Method

1. Source: npm packages keyworded `mcp-server`.
2. Each repo cloned and read **from source** — not from its description, README
   or registry blurb.
3. Per repo, [`fencescan`](https://github.com/aurumflux20/fencescan) counts:
   - `tools` — declared MCP tools
   - `writes` — call sites performing a state-changing request
   - `guards` — idempotency-key / dedup / caller-token constructs visible in code
   - `retries` — retry loops
   - `candidates` — tools worth a human reading, with evidence attached
4. Failures are recorded **as failures** (`repos_failed: 84` — mostly repos that
   no longer resolve). They are never counted as zeros. A failed lookup is not a
   zero; that mistake has cost us a whole pool once already.

## Headline numbers

- 755 attempted → **671 scanned**, 84 failed
- **27,153** declared tools
- **80.3%** of scanned servers perform real writes
- **32.5%** of those writers show **no idempotency guard of any kind**
- 229 writers ship a retry loop; 470 repos produced at least one candidate

Pattern counts (`B_method_blind_retry` 63, `C_control_unreachable` 14,
`A_fresh_randomness` 10) are **lower bounds from a conservative matcher**, not
prevalence estimates. Treat them as "at least this many", never as a rate.

## What this dataset cannot tell you

Stated plainly, because the limits matter more than the totals:

- **It contains no error strings.** The scan reads code, never runtime output.
  It cannot say how often a `retry_after` is recoverable from free text.
- **`guards: 0` is not a verdict.** The guard often lives in a service the repo
  merely calls. The scanner emits evidence and candidates; it has no verdict
  field on purpose. Of seven candidates hand-read early on, four were wrong.
- **Counts are per-repo, not per-tool.** A repo with one guard and forty writes
  reads as "has a guard".
- **Downloads are bucketed**, since a raw count plus a tool count would
  re-identify the largest packages.
- **npm-only.** PyPI, Go and unpublished servers are out of the corpus.

## Licence

Apache-2.0, same as the scanner. Use it, check it, contradict it.
