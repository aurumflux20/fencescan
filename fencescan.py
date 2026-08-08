#!/usr/bin/env python3
"""fencescan — MCP servers whose tools can fire the same effect twice.

The unit of analysis is the TOOL, not the line: an agent-facing tool whose
name or description describes a money / message / provisioning effect, in a
repo with no idempotency guard anywhere. That is the shape of a double-fire.

Heuristic, not a prover. Every finding is read by a human before it is sent
to anyone -- a wrong accusation costs far more than a missed lead.
"""
import re, sys, pathlib, json

CODE = {".ts", ".js", ".mjs", ".py", ".go", ".rs"}
SKIP = ("node_modules", ".git", "dist", "build", "target", "__pycache__",
        "test", "tests", "__tests__", "spec", "e2e", "scripts", "examples")

EFFECT = re.compile(r"\b(pay|payment|charge|transfer|payout|refund|settle|invoice|spend|"
                    r"send|sms|email|message|notify|post|publish|"
                    r"create|deploy|provision|launch|terminate|delete|destroy|update)\b", re.I)
MONEY = re.compile(r"\b(pay|payment|charge|transfer|payout|refund|settle|invoice|spend|usdc|wallet|billing)\b", re.I)
GUARD = re.compile(r"\b(idempot|dedup|already[_ ]?(sent|paid|processed|done)|"
                   r"exactly[- ]once|effectfence|once\.run|seen[_ ]?(keys?|ids?)|"
                   r"idempotency[_ ]?key|processed[_ ]?ids?|replay[_ ]?protect)\b", re.I)
# tool declarations across the common SDKs
STRLIT = re.compile(r'''"[^"]*"|\'[^\']*\'|`[^`]*`''')
TOOLNAME = re.compile(r"""(?:name:\s*["']([a-z0-9_.\-]{3,60})["']|@mcp\.tool\(\s*\)?\s*(?:\n\s*)?def\s+([a-z0-9_]{3,60})|Tool\(\s*["']([a-z0-9_.\-]{3,60})["'])""", re.I)

def scan(root: pathlib.Path):
    tools, guards = {}, []
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix not in CODE: continue
        if any(d in [q.lower() for q in p.parts] for d in SKIP): continue
        try: txt = p.read_text(encoding="utf-8", errors="ignore")
        except Exception: continue
        for m in TOOLNAME.finditer(txt):
            nm = next(g for g in m.groups() if g)
            ctx = txt[m.start(): m.start() + 900]          # name + its description block
            if not re.search(r"(description|handler|inputSchema|input_schema|callback|execute)", ctx, re.I): continue
            if nm not in tools: tools[nm] = (str(p.relative_to(root)),
                                             txt[:m.start()].count("\n") + 1, ctx)
        for i, line in enumerate(txt.splitlines(), 1):
            # a guard must be code, not a phrase inside a user-facing string
            code_only = STRLIT.sub("", line)
            if GUARD.search(code_only) and not line.strip().startswith(("//", "#", "*", "/*", "/**")):
                guards.append({"file": str(p.relative_to(root)), "line": i, "code": line.strip()[:120]})
    risky = {n: v for n, v in tools.items() if EFFECT.search(n) or EFFECT.search(v[2])}
    money = {n: v for n, v in risky.items() if MONEY.search(n) or MONEY.search(v[2])}
    return tools, risky, money, guards

if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1])
    tools, risky, money, guards = scan(root)
    verdict = ("AT RISK - money" if money and not guards else
               "AT RISK" if risky and not guards else
               "guarded" if guards else
               "no effectful tools found")
    print(json.dumps({
        "repo": root.name, "verdict": verdict,
        "tools_found": len(tools), "effectful_tools": len(risky), "money_tools": len(money),
        "guard_sites": len(guards),
        "flagged": [{"tool": n, "file": v[0], "line": v[1]}
                    for n, v in (money or risky).items()][:6],
        "guards": guards[:3],
    }, indent=1))
