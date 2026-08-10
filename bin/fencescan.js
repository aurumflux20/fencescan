#!/usr/bin/env node
/**
 * fencescan — find tool calls that could fire the same effect twice.
 *
 *   npx fencescan            scan the current directory
 *   npx fencescan ./path     scan a directory
 *   npx fencescan --json     machine-readable output
 *
 * Prints evidence and refuses to render a verdict. See src/scan.ts for why
 * each rule exists — every one of them is there because an earlier version got
 * a real repository wrong.
 */
import { scan } from "../dist/scan.js";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const target = resolve(argv.find((a) => !a.startsWith("-")) ?? ".");

const B = (s) => `[1m${s}[0m`;
const DIM = (s) => `[2m${s}[0m`;
const Y = (s) => `[33m${s}[0m`;
const G = (s) => `[32m${s}[0m`;
const plain = !process.stdout.isTTY || process.env.NO_COLOR;
const b = plain ? (s) => s : B;
const dim = plain ? (s) => s : DIM;
const y = plain ? (s) => s : Y;
const g = plain ? (s) => s : G;

// A missing or non-directory target must NOT scan zero files and report
// "nothing found" -- a typo would read as "your code is clean", which is the
// worst possible false negative for a tool like this.
import { existsSync, statSync } from "node:fs";
if (!existsSync(target)) {
  console.error(`fencescan: no such directory: ${target}`);
  process.exit(2);
}
if (!statSync(target).isDirectory()) {
  console.error(`fencescan: not a directory: ${target}`);
  process.exit(2);
}

const r = scan(target);

// process.exit() right after console.log truncates stdout at the 64KB pipe
// buffer on large outputs — the --json report arrived cut mid-string (found
// by our own scan pipeline, Aug 10). No explicit exit on success paths: let
// the process drain stdout and exit naturally.
if (asJson) {
  console.log(JSON.stringify(r, null, 2));
} else {
  report(r);
}

function report(r) {
console.log(`\n${b("fencescan")} ${dim(r.root)}`);
console.log(dim(`${r.filesScanned} files · ${r.toolsDeclared} tool declarations found\n`));

if (r.toolsDeclared === 0) {
  console.log("No tool declarations recognised here.");
  console.log(dim("fencescan looks for MCP-style tools (registerTool, @mcp.tool, Tool(...))."));
  console.log(dim("If this is an MCP server and nothing was found, that's a bug — please report it."));
  return;
}

if (r.candidates.length === 0) {
  console.log(g("No tools look like they cause an irreversible effect."));
  console.log(dim("That is the scan finding nothing, not a guarantee of safety.\n"));
  return;
}

const money = r.candidates.filter((c) => c.money);
const other = r.candidates.filter((c) => !c.money);

console.log(b("Tools worth checking") + dim("  (candidates, not verdicts)"));
const show = (c) => {
  const tag = c.money ? y("money") : dim("effect");
  const w = c.writesInSameFile ? dim(` · ${c.writesInSameFile} write call(s) in this file`) : "";
  console.log(`  ${tag}  ${b(c.tool)}  ${dim(`${c.file}:${c.line}`)}${w}`);
};
money.slice(0, 12).forEach(show);
other.slice(0, 8).forEach(show);
const hidden = r.candidates.length - Math.min(money.length, 12) - Math.min(other.length, 8);
if (hidden > 0) console.log(dim(`  …and ${hidden} more (--json for all)`));

console.log(`\n${b("What else is in this codebase")}`);
console.log(`  ${r.writes.length} write call site(s)`);
console.log(
  `  ${r.guards.length} idempotency-looking guard(s)` +
    (r.guards.length === 0 ? y("  ← none found in this repo") : ""),
);
console.log(`  ${r.retries.length} retry site(s)`);

if (r.retries.length && r.guards.length === 0) {
  console.log(
    `\n${y("Worth a close look:")} retry logic and no visible dedup key.` +
      `\n  A retry loop that does not branch on HTTP method will repeat writes.` +
      `\n  If a create is retried after a timeout, the first attempt may already have landed.`,
  );
}

console.log(`\n${b("What this scan cannot see")}`);
[
  "Whether the API you call deduplicates on its own side.",
  "A guard that lives in a sibling package or a service you call.",
  "Whether a tool that looks like a write only returns a payload for someone else to sign.",
].forEach((l) => console.log(dim(`  · ${l}`)));

console.log(
  `\n${dim("Open each candidate and ask: if this ran twice, would anyone notice?")}` +
    `\n${dim("Fixes and background: https://github.com/aurumflux20/effectfence")}\n`,
);
}
