/**
 * fencescan — find tool calls that could fire the same effect twice.
 *
 * A CANDIDATE FINDER, not a prover. It reports evidence and deliberately
 * renders no verdict, because an outsider reading a codebase usually cannot
 * prove a double-fire: the guard often lives in a service the code calls, or in
 * a sibling package, and a function whose name sounds like a write may only
 * build a payload for someone else to sign.
 *
 * Every pattern below exists because a real scan got it wrong first. The Python
 * original hand-verified at 3 out of 7; each of its four failure modes is now a
 * fixed behaviour rather than a caveat. Those are documented at each rule.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

export interface Finding {
  tool: string;
  file: string;
  line: number;
  money: boolean;
  writesInSameFile: number;
}

export interface Report {
  root: string;
  filesScanned: number;
  toolsDeclared: number;
  candidates: Finding[];
  guards: Array<{ file: string; line: number; code: string }>;
  retries: Array<{ file: string; line: number; code: string }>;
  writes: Array<{ file: string; line: number; code: string }>;
}

const CODE = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb"]);
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "target", "__pycache__", ".venv",
  "venv", "vendor", "coverage", ".next", ".turbo", "test", "tests", "__tests__",
  "spec", "e2e", "examples", "fixtures",
]);

/** Verbs that describe causing an effect in the world. */
const EFFECT =
  /\b(pay|payment|charge|transfer|payout|refund|settle|invoice|spend|send|sms|email|dispatch|notify|publish|submit|order|purchase|buy|sell|swap|mint|withdraw|deposit|create|deploy|provision|launch|terminate|delete|destroy|update|write|execute|trigger|enroll|register|book|reserve|cancel)\b/i;

const MONEY =
  /\b(pay|payment|charge|transfer|payout|refund|settle|invoice|spend|usdc|wallet|billing|purchase|buy|sell|swap|mint|withdraw|deposit|escrow|x402|budget|checkout|subscription|stripe)\b/i;

/** If the NAME says it reads, believe that over an incidental effect word. */
const READ =
  /\b(get|list|read|fetch|search|query|lookup|resolve|retrieve|check|describe|show|view|find|count|status|inspect|validate|verify)\b/i;

/**
 * NO \b ANCHORS.
 *
 * `\b(idempot…)` cannot match `deriveIdempotencyKey` — there is no word
 * boundary before a camelCase capital. That single anchor made the original
 * scanner accuse a repository of having no idempotency while it shipped an
 * entire `idempotency.ts` module, and it hid `requestId` and `clientToken` too,
 * i.e. most of TypeScript.
 */
const GUARD =
  /(idempot|dedup|alreadySent|already_sent|alreadyPaid|already_paid|alreadyProcessed|already_processed|exactly[- ]?once|effectfence|once\.run|onceKernel|seenKeys?|seen_keys?|seenIds?|seen_ids?|processedIds?|processed_ids?|replayProtect|replay_protect|requestId|request_id|clientToken|client_token|transactionKey|transaction_key|dedupeKey|dedupe_key|nonce)/i;

/** Retrying a non-idempotent write is its own route to a double-fire. */
const RETRY = /\b(retry|retries|backoff|max_?attempts|reattempt|tenacity|p-retry)\b/i;

/**
 * Writes live in shared helpers, not inside a tool declaration — one target
 * posted from a `call()` helper reached by every tool. So write sites are
 * collected per FILE and reported as corroboration, never claimed as "this
 * tool writes".
 *
 * Matched on the RAW line, not with string literals stripped: the HTTP verb is
 * itself a literal (`method: body ? "POST" : "GET"`), so stripping literals
 * first deletes the very evidence being looked for.
 */
const WRITE_CALL =
  /(\.post\s*\(|\.put\s*\(|\.patch\s*\(|\.delete\s*\(|requests\.(post|put|patch|delete)|axios\.(post|put|patch|delete)|httpx\.(post|put|patch|delete)|method\s*[:=][^,;\n]*(POST|PUT|PATCH|DELETE)|\.create\s*\(|\.send\s*\(|\.submit\s*\(|\.execute\s*\(|\.sign(AndSubmit|Transaction)?\s*\(|submitTransaction|sendTransaction|\.insert\s*\(|\.save\s*\()/i;

const STRLIT = /"[^"]*"|'[^']*'|`[^`]*`/g;

/** Tool declarations across the common MCP SDKs and decorators. */
const TOOLNAME = new RegExp(
  [
    `name:\\s*["'\`]([a-z0-9_.\\-]{3,60})["'\`]`,
    `@mcp\\.tool\\(\\s*\\)?\\s*(?:\\n\\s*)?def\\s+([a-z0-9_]{3,60})`,
    `registerTool\\(\\s*["'\`]([a-z0-9_.\\-]{3,60})["'\`]`,
    `Tool\\(\\s*["'\`]([a-z0-9_.\\-]{3,60})["'\`]`,
    `@tool\\(\\s*["'\`]?([a-z0-9_.\\-]{3,60})`,
  ].join("|"),
  "gi",
);

/**
 * Return only THIS tool's declaration, by brace matching.
 *
 * The original used a flat character window, which ran past the end of one tool
 * into the next and mixed their vocabularies. A read-only tool declared beside
 * a write inherited the write's words — that one bug produced most of the
 * original's false positives.
 */
function ownBlock(txt: string, start: number, limit = 4000): string {
  const i = txt.indexOf("{", start);
  if (i === -1) return txt.slice(start, start + 300);
  let depth = 0;
  const end = Math.min(txt.length, i + limit);
  for (let j = i; j < end; j++) {
    const c = txt[j];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return txt.slice(start, j + 1);
  }
  return txt.slice(start, end);
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name.toLowerCase())) continue;
      yield* walk(p, depth + 1);
    } else if (CODE.has(extname(e.name))) {
      yield p;
    }
  }
}

export function scan(root: string): Report {
  const tools = new Map<string, { file: string; line: number; block: string }>();
  const guards: Report["guards"] = [];
  const retries: Report["retries"] = [];
  const writes: Report["writes"] = [];
  let filesScanned = 0;

  for (const path of walk(root)) {
    let txt: string;
    try {
      if (statSync(path).size > 2_000_000) continue; // skip generated blobs
      txt = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    filesScanned++;
    const rel = relative(root, path) || path;

    TOOLNAME.lastIndex = 0;
    for (let m = TOOLNAME.exec(txt); m; m = TOOLNAME.exec(txt)) {
      const groupIndex = m.slice(1).findIndex(Boolean);
      const nm = m[groupIndex + 1];
      if (!nm || tools.has(nm)) continue;
      const block = ownBlock(txt, m.index);

      // Group 0 is the generic `name: "..."` alternative -- the only one loose
      // enough to match a plain object that has nothing to do with a tool. A
      // package.json-style manifest has `name` right beside `description`,
      // which false-matched yahoo-finance2's OWN build script as a tool called
      // "yahoo-finance2". The other alternatives (registerTool(, Tool(,
      // @mcp.tool, @tool() are SDK call syntax that essentially never appears
      // outside a real tool declaration, so they are trusted on their own
      // syntax rather than re-gated on nearby words.
      if (groupIndex === 0) {
        // Some SDKs pass the handler as a THIRD positional argument, outside
        // the config object: registerTool("x", { description: "..." }, fn). A
        // tool with only a description and no inputSchema is legal and common,
        // so look a little past the object too -- capped tightly so this
        // cannot bleed into the next declaration, the bug that produced most
        // of v1's false positives.
        const tail = txt.slice(m.index + block.length, m.index + block.length + 200);
        const nextDecl = tail.search(/registerTool\(|@mcp\.tool|@tool\(|\bTool\(/);
        const window = block + (nextDecl === -1 ? tail : tail.slice(0, nextDecl));
        if (!/(handler|inputSchema|input_schema|callback|execute|async|=>)/i.test(window)) continue;
      }

      tools.set(nm, { file: rel, line: txt.slice(0, m.index).split("\n").length, block });
    }

    const lines = txt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) continue;
      const codeOnly = line.replace(STRLIT, "");
      if (GUARD.test(codeOnly)) guards.push({ file: rel, line: i + 1, code: t.slice(0, 110) });
      if (RETRY.test(codeOnly)) retries.push({ file: rel, line: i + 1, code: t.slice(0, 110) });
      if (WRITE_CALL.test(line)) writes.push({ file: rel, line: i + 1, code: t.slice(0, 110) });
    }
  }

  const candidates: Finding[] = [];
  for (const [tool, t] of tools) {
    // A read verb in the NAME vetoes effect words found anywhere in the block.
    if (READ.test(tool) && !MONEY.test(tool)) continue;
    if (!EFFECT.test(tool) && !EFFECT.test(t.block)) continue;
    candidates.push({
      tool,
      file: t.file,
      line: t.line,
      money: MONEY.test(tool) || MONEY.test(t.block),
      writesInSameFile: writes.filter((w) => w.file === t.file).length,
    });
  }
  candidates.sort(
    (a, b) => Number(b.money) - Number(a.money) || b.writesInSameFile - a.writesInSameFile,
  );

  return { root, filesScanned, toolsDeclared: tools.size, candidates, guards, retries, writes };
}
