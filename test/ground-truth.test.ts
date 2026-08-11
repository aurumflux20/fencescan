/**
 * Every test here encodes a mistake an earlier scanner actually made on a real
 * repository. Fixtures rather than live clones: a published test suite must not
 * need the network, and the repos it was calibrated against can change.
 *
 * The real-repo results these fixtures stand in for, hand-verified:
 *   devotel        32 guards / 41 writes  -> reads as "they built it properly"
 *   devsjony        0 guards /  1 write   -> surfaces as a genuine candidate
 *   amalo           read-only tools       -> must not dominate the candidate list
 *   metaads        59 writes              -> writes found in shared helpers
 *   yahoo-finance2  a package.json "name" -> flagged as a tool. Real bug, shipped
 *                                            in 0.1.0, caught auditing the first
 *                                            real production scan the next day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scan.ts";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fencescan-"));
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

test("a guard named in camelCase is found", () => {
  // THE BUG: `\b(idempot…)` cannot match `deriveIdempotencyKey` — there is no
  // word boundary before a capital mid-word. This made the original scanner
  // report a repo with an entire idempotency module as having none, and it
  // hid requestId and clientToken too, i.e. most of TypeScript.
  const dir = fixture({
    "src/idempotency.ts": `
      export function deriveIdempotencyKey(input: Input): string { return hash(input); }
      const clientToken = makeClientToken();
      const requestId = newRequestId();
    `,
  });
  try {
    const r = scan(dir);
    assert.ok(r.guards.length >= 3, `expected camelCase guards to be found, got ${r.guards.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-only tool does not inherit a neighbouring write's vocabulary", () => {
  // THE BUG: a flat character window after a tool name ran past the end of one
  // declaration into the next, so a read declared beside a payment tool
  // inherited its words. That single bug produced most of the false positives.
  const dir = fixture({
    "server.ts": `
      server.registerTool("getInboxDetails", {
        description: "Read inbox metadata. Returns counts only.",
        inputSchema: { inboxId: z.string() },
      }, async ({ inboxId }) => api.get(inboxId));

      server.registerTool("sendPayment", {
        description: "Charge the customer and transfer funds to the payee.",
        inputSchema: { amount: z.string() },
      }, async ({ amount }) => api.post("/pay", { amount }));
    `,
  });
  try {
    const r = scan(dir);
    const names = r.candidates.map((c) => c.tool);
    assert.ok(names.includes("sendPayment"), "the payment tool must be a candidate");
    assert.ok(
      !names.includes("getInboxDetails"),
      `a read must not be flagged; got ${JSON.stringify(names)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write is found when the HTTP verb is a ternary string literal", () => {
  // THE BUG: writes were matched after stripping string literals — but the verb
  // IS a literal. `method: body ? "POST" : "GET"` therefore matched nothing,
  // and a server that posted from a shared helper looked like it never wrote.
  const dir = fixture({
    "index.js": `
      async function call(path, { body } = {}) {
        return fetch(url, { method: body ? "POST" : "GET", body: JSON.stringify(body) });
      }
    `,
  });
  try {
    const r = scan(dir);
    assert.ok(r.writes.length >= 1, "a ternary HTTP verb must still register as a write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes in a shared helper are counted, not attributed to one tool", () => {
  const dir = fixture({
    "api.js": `export const post = (p, b) => axios.post(p, b);`,
    "tools.js": `
      server.registerTool("createCampaign", {
        description: "Create an ad campaign with a budget.",
      }, async (args) => post("/campaigns", args));
    `,
  });
  try {
    const r = scan(dir);
    assert.ok(r.writes.length >= 1, "the helper's write should be recorded");
    const c = r.candidates.find((x) => x.tool === "createCampaign");
    assert.ok(c, "the create tool should be a candidate");
    // Corroboration is per-file: the helper's write is not claimed as this
    // tool's, because proving that needs a human reading the call graph.
    assert.equal(typeof c!.writesInSameFile, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("money-shaped tools sort above other effects", () => {
  const dir = fixture({
    "s.ts": `
      server.registerTool("deployStack", { description: "Provision infrastructure." }, f);
      server.registerTool("refundCharge", { description: "Refund a payment to the buyer." }, f);
    `,
  });
  try {
    const r = scan(dir);
    assert.ok(r.candidates.length >= 2);
    assert.equal(r.candidates[0]?.tool, "refundCharge", "money should rank first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package manifest's name+description is not mistaken for a tool", () => {
  // THE BUG, shipped in 0.1.0: the gate accepted "description" alone as proof
  // of a tool declaration. Every npm/PyPI manifest has a description right
  // next to its name field. This exact shape -- caught scanning a real repo
  // the day after publish -- flagged yahoo-finance2's own build_npm.ts as a
  // tool called "yahoo-finance2" with zero actual write behaviour.
  const dir = fixture({
    "scripts/build_npm.ts": `
      export default {
        outDir: "./npm",
        package: {
          name: "some-real-library",
          version: "0.0.1",
          description: "Does something entirely unrelated to MCP tools",
          license: "MIT",
        },
      };
    `,
  });
  try {
    const r = scan(dir);
    assert.equal(
      r.candidates.length,
      0,
      `a package manifest must not be flagged as a tool: ${JSON.stringify(r.candidates)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real tool WITH a description is still found (the fix must not overcorrect)", () => {
  const dir = fixture({
    "s.ts": `
      server.registerTool("chargeCard", {
        description: "Charge the customer's card.",
        inputSchema: { amount: z.string() },
      }, async ({ amount }) => api.post("/charge", { amount }));
    `,
  });
  try {
    const r = scan(dir);
    assert.ok(
      r.candidates.some((c) => c.tool === "chargeCard"),
      "a real tool with inputSchema must still be found after tightening the gate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no verdict field is ever emitted", () => {
  // THE BUG: the original printed "AT RISK", which is an accusation — and it
  // was wrong on 4 of its first 7 real targets. There is nothing to render a
  // verdict from, so there is no verdict.
  const dir = fixture({
    "s.ts": `server.registerTool("sendSms", { description: "Send an SMS message." }, f);`,
  });
  try {
    const r = scan(dir) as Record<string, unknown>;
    for (const k of ["verdict", "risk", "atRisk", "severity"]) {
      assert.ok(!(k in r), `report must not contain a '${k}' field`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vendored and test directories are skipped", () => {
  const dir = fixture({
    "node_modules/pkg/x.js": `server.registerTool("chargeCard", {description:"pay"}, f);`,
    "tests/t.js": `server.registerTool("chargeCard2", {description:"pay"}, f);`,
    "src/real.js": `server.registerTool("chargeCard3", {description:"pay"}, f);`,
  });
  try {
    const r = scan(dir);
    const names = r.candidates.map((c) => c.tool);
    assert.deepEqual(names, ["chargeCard3"], `only first-party code should be scanned: ${names}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty directory reports nothing found rather than throwing", () => {
  const dir = fixture({ "readme.md": "no code here" });
  try {
    const r = scan(dir);
    assert.equal(r.toolsDeclared, 0);
    assert.equal(r.candidates.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean scan offers the badge, and only a clean scan", () => {
  // The badge is the self-distribution loop: a repo that scans clean can
  // display proof, and every visitor who sees it learns the tool exists.
  // It must never appear when candidates were found.
  const bin = join(import.meta.dirname, "..", "bin", "fencescan.js");

  const clean = fixture({
    "server.ts": `server.registerTool("list_items", { description: "read-only" }, async () => fetchItems());`,
  });
  try {
    const out = execFileSync("node", [bin, clean], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.match(out, /img\.shields\.io\/badge\/fencescan-0_candidates/, "clean scan must offer the badge");
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  const dirty = fixture({
    "server.ts": `server.registerTool("send_payment", { description: "charge the card" }, async (a) => http.post("/charge", a));`,
  });
  try {
    const out = execFileSync("node", [bin, dirty], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.doesNotMatch(out, /img\.shields\.io/, "a scan with candidates must NOT offer the badge");
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});
