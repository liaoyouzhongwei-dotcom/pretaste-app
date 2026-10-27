#!/usr/bin/env node
/**
 * Pre-commit guard: blocks keys and Qloo-response-like data from entering the repo.
 *
 *   node scripts/check-leaks.mjs         # scan staged files (used by .githooks/pre-commit)
 *   node scripts/check-leaks.mjs --all   # scan every tracked + untracked (non-ignored) file
 *
 * Exit code 1 when something is found. Synthetic mock ids ("SYN-...") are allowed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const SKIP = [/^package-lock\.json$/, /^scripts\/check-leaks\.mjs$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf)$/i];

const RULES = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "generic secret key", re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "key assigned in env style", re: /\b(QLOO_API_KEY|PRETASTE_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY)[ \t]*=[ \t]*["']?[A-Za-z0-9_\-]{12,}/ },
  { name: "X-Api-Key header with a literal value", re: /["']?X-Api-Key["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i },
  { name: "Qloo-style entity id (UUID)", re: /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i },
  { name: "Qloo response JSON (entity_id with affinity)", re: /"entity_id"\s*:\s*"(?!SYN-)[^"]+"[\s\S]{0,400}"affinity"\s*:/ },
  // Test files hold synthetic values on purpose (see their header), so this rule skips them.
  { name: "Qloo skew value in prose", notIn: /\.test\.ts$/, re: /\bskew(?: of [^.]{0,40}?)?\s*(?:is\s*)?[\u2212+-]?\s?0?\.\d{2}/i },
  { name: "Qloo response JSON (results.entities)", re: /"results"\s*:\s*\{\s*"entities"\s*:\s*\[\s*\{\s*"entity_id"\s*:\s*"(?!SYN-)/ },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
}

const all = process.argv.includes("--all");
const files = all
  ? git(["ls-files", "--cached", "--others", "--exclude-standard"])
  : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);

const findings = [];
for (const f of files) {
  const path = f.replace(/\\/g, "/");
  if (SKIP.some((re) => re.test(path))) continue;
  let text;
  try {
    if (statSync(path).size > 2_000_000) {
      findings.push(`${path}: file larger than 2 MB (check it is not a data dump)`);
      continue;
    }
    // For staged mode, scan the staged content, not the working copy.
    text = all ? readFileSync(path, "utf8") : execFileSync("git", ["show", `:${path}`], { encoding: "utf8", maxBuffer: 4_000_000 });
  } catch {
    continue;
  }
  if (/^\.env/.test(path.split("/").pop() ?? "") && !path.endsWith(".env.example")) findings.push(`${path}: env file must not be committed`);
  if (/(^|\/)\.cache\//.test(path)) findings.push(`${path}: cache directory must not be committed`);
  for (const rule of RULES) {
    if (rule.notIn?.test(path)) continue;
    const m = text.match(rule.re);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push(`${path}:${line}: ${rule.name}`);
    }
  }
}

if (findings.length) {
  console.error("check-leaks: blocked —");
  for (const f of findings) console.error("  " + f);
  console.error("Remove the data (or move it to .env.local / the ignored cache) and try again.");
  process.exit(1);
}
console.log(`check-leaks: ok (${files.length} file(s) scanned${all ? ", --all" : ", staged"})`);
