/**
 * Claim = one sentence shown to the user, plus its receipt.
 * "qloo" claims must point at a recorded Qloo call; "interpretation" claims are
 * the agent's reading and are rendered in a different colour.
 */

export type ClaimKind = "qloo" | "interpretation";

export type EvidenceValue = string | number | boolean | null;

export interface Evidence {
  /** Id of the recorded call (see CallRecord.callId). */
  callId: string;
  /** Qloo entity id (or synthetic id in mock mode) this value belongs to. */
  entityId?: string;
  /** Dotted path of the field inside the response, e.g. "query.affinity". */
  field: string;
  value: EvidenceValue;
}

export interface Claim {
  id: string;
  text: string;
  kind: ClaimKind;
  evidence: Evidence[];
}

/** Record of one outbound call, kept for the Receipts screen. Params are redacted. */
export interface CallRecord {
  callId: string;
  step: number;
  path: string;
  params: Record<string, string>;
  status: number | "cache" | "mock" | "error";
  source: "qloo" | "mock";
  cached: boolean;
  durationMs: number;
  warnings: string[];
}

export interface CheckResult {
  kept: Claim[];
  /** qloo claims downgraded to interpretation (with the reason). */
  downgraded: { claim: Claim; reason: string }[];
  /** claims removed entirely (with the reason). */
  dropped: { claim: Claim; reason: string }[];
}

/** Standalone numbers only: digits inside identifiers such as "55_and_older" or "c4-1a2b3c" are ignored. */
const NUMBER_RE = /(?<![\w.])-?(?:\d+(?:\.\d+)?|\.\d+)%?(?![\w])/g;

function normalizeNumber(s: string): number | null {
  const pct = s.endsWith("%");
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

function evidenceNumbers(evidence: Evidence[]): number[] {
  const out: number[] = [];
  for (const e of evidence) {
    if (typeof e.value === "number") out.push(e.value);
    if (typeof e.value === "string") {
      for (const m of e.value.match(NUMBER_RE) ?? []) {
        const n = normalizeNumber(m);
        if (n !== null) out.push(n);
      }
    }
  }
  return out;
}

function numberIsBacked(n: number, backing: number[]): boolean {
  // Percentage tokens are normalized by the parser. Never reinterpret an unmarked number as
  // 100 times another metric. Permit only exact values or normal two-decimal display rounding.
  return backing.some((b) => Math.abs(b - n) < 1e-6 || Math.abs(Math.round(b * 100) / 100 - n) < 1e-6);
}

/** Qloo taste indices are not purchase probabilities or percentages of people. */
const SALES_FACT = /\b(purchase\s+(?:intent|probability|likelihood|rate)|conversion\s+rate|sales\s+(?:rate|probability)|(?:will|likely to|guaranteed to)\s+(?:buy|purchase|sell)|(?:buyers?|customers?|people)\s+(?:buy|purchase|convert)|majority|(?:mostly|predominantly)\s+(?:women|men|female|male)|most\s+(?:buyers?|customers?|people|fans?|readers?))\b/i;
const METRICS: { words: RegExp; field: RegExp }[] = [
  { words: /\bage(?=\b|_)/i, field: /^age\./ },
  { words: /\b(?:female|women|woman)\b/i, field: /^gender\.female$/ },
  { words: /\b(?:male|men|man)\b/i, field: /^gender\.male$/ },
  { words: /\bgender\b/i, field: /^gender\./ },
  { words: /\b(?:velocity|trend)\b/i, field: /velocity$/ },
  { words: /\b(?:regional|region|state)\b/i, field: /^heatmap\./ },
  { words: /\baffinity\b/i, field: /(?:affinity$|^heatmap\.)/ },
];

function metricProblem(text: string, evidence: RegistryItem[]): string | null {
  // A title such as "Age of Empires" is a subject, not an assertion about age.
  for (const e of evidence) {
    if (e.subject) text = text.split(new RegExp(e.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).join(" ");
  }
  if (SALES_FACT.test(text)) return "taste evidence does not measure buyer proportions, sales or purchase intent";
  if (/%|\bpercent(?:age)?\b/i.test(text) && !evidence.some((e) => /population_percentile$/.test(e.field))) {
    return "taste indices and demographic skews are not percentages of buyers";
  }
  // Check each sentence against the kind of evidence it names, as well as its subject and value.
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
    for (const metric of METRICS) {
      if (metric.words.test(sentence) && !evidence.some((e) => metric.field.test(e.field))) {
        return "the stated metric is not present in the cited evidence";
      }
    }
  }
  return null;
}

/** An evidence item the server recorded itself (see buildEvidence). Claims may only cite these. */
export interface RegistryItem extends Evidence {
  /** What the value is about, as it should appear in the sentence (a neighbour, a state, an age band). */
  subject?: string;
}

/** Case-insensitive positions of every occurrence of `sub` in `text`. */
function positions(text: string, sub: string): number[] {
  const out: number[] = [];
  const t = text.toLowerCase();
  const n = sub.toLowerCase();
  if (!n) return out;
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + n.length)) out.push(i);
  return out;
}

/**
 * Each number must be backed by the evidence of the subject it is written next to (the nearest named
 * subject before it, else the first one after it), or by evidence that has no subject. So "A has
 * affinity .9" fails when .9 is B's value even if both A and B were cited. Digits inside a subject's
 * own name ("Vol. 1") are skipped, case-insensitively and whatever the spacing ("Vol.  1").
 */
function unbackedPairs(rawText: string, matched: RegistryItem[]): number[] {
  // Same spacing rule as the subject check in checkClaims, so a name it accepts is also found here.
  // Underscores are kept: digits inside identifiers ("55_and_older") must stay non-standalone.
  const text = squeezeSpaces(rawText);
  const named = [...new Set(matched.map((m) => m.subject).filter((x): x is string => !!x))];
  const spans: { start: number; end: number; subject: string }[] = [];
  for (const sub of named) {
    const s = squeezeSpaces(sub).trim();
    for (const p of positions(text, s)) spans.push({ start: p, end: p + s.length, subject: sub });
  }
  const metricSpans = METRICS.flatMap((metric) => [...text.matchAll(new RegExp(metric.words.source, "gi"))]
    .filter((m) => !spans.some((s) => (m.index ?? 0) >= s.start && (m.index ?? 0) < s.end))
    .map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, field: metric.field })));
  const boundaries = [...text.matchAll(/[;!?]\s*|\.\s+(?=[A-Z])|\band\b|\n/g)]
    .map((m) => m.index ?? 0).filter((p) => !spans.some((s) => p >= s.start && p < s.end));
  const bad: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const at = m.index ?? 0;
    if (spans.some((sp) => at >= sp.start && at < sp.end)) continue;
    const n = normalizeNumber(m[0]);
    if (n === null) continue;
    const left = boundaries.filter((p) => p < at).at(-1) ?? -1;
    const right = boundaries.find((p) => p > at) ?? text.length;
    const nearby = metricSpans.filter((m) => m.start > left && m.end <= right);
    const metric = nearby.filter((m) => m.end <= at).sort((a, b) => b.end - a.end)[0]
      ?? nearby.filter((m) => m.start > at).sort((a, b) => a.start - b.start)[0];
    const eligible = metric ? matched.filter((e) => metric.field.test(e.field)) : matched;
    const free = evidenceNumbers(eligible.filter((e) => !e.subject));
    if (numberIsBacked(n, free)) continue;
    const before = spans.filter((sp) => sp.end <= at).sort((x, y) => y.end - x.end)[0];
    const after = spans.filter((sp) => sp.start > at).sort((x, y) => x.start - y.start)[0];
    const owner = (before ?? after)?.subject;
    const backing = evidenceNumbers(owner ? eligible.filter((e) => e.subject === owner) : eligible);
    if (!numberIsBacked(n, backing)) bad.push(n);
  }
  return bad;
}

function sameEvidence(a: Evidence, b: Evidence): boolean {
  return a.callId === b.callId && a.field === b.field && (a.entityId ?? null) === (b.entityId ?? null) && a.value === b.value;
}

function squeezeSpaces(s: string): string {
  return s.replace(/\s+/g, " ");
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[_\s]+/g, " ");
}

/**
 * Machine part of the checker. Every cited evidence item must be one the server recorded itself
 * (same call, field, entity and value), so a writer cannot invent a field or a value.
 * - a qloo claim with no such evidence is downgraded to an interpretation;
 * - a qloo claim whose evidence is about something it never names (e.g. cites one neighbour's
 *   affinity but talks about another) is downgraded;
 * - any number in a qloo claim that is not in its evidence values drops the claim;
 * - an interpretation claim may not carry numbers.
 */
export function checkClaims(claims: Claim[], registry: RegistryItem[]): CheckResult {
  const result: CheckResult = { kept: [], downgraded: [], dropped: [] };

  for (const claim of claims) {
    const nums = (claim.text.match(NUMBER_RE) ?? [])
      .map(normalizeNumber)
      .filter((n): n is number => n !== null);

    if (claim.kind === "qloo") {
      const matched = claim.evidence
        .map((e) => registry.find((r) => sameEvidence(r, e)))
        .filter((r): r is RegistryItem => !!r);
      const problem = metricProblem(claim.text, matched);
      if (problem) {
        result.dropped.push({ claim, reason: problem });
        continue;
      }
      if (matched.length === 0) {
        // A downgraded claim is shown as an interpretation, and interpretations may not carry numbers.
        if (nums.length > 0) {
          result.dropped.push({ claim, reason: "no evidence that matches a recorded Qloo value, and it states numbers" });
        } else {
          result.downgraded.push({
            claim: { ...claim, kind: "interpretation", evidence: [] },
            reason: "no evidence that matches a recorded Qloo value",
          });
        }
        continue;
      }
      const subjects = matched.map((m) => m.subject).filter((x): x is string => !!x);
      const text = normText(claim.text);
      if (subjects.length > 0 && !subjects.some((sub) => text.includes(normText(sub)))) {
        if (nums.length > 0) {
          result.dropped.push({ claim, reason: `cites evidence about ${subjects.join(", ")} but does not name it, and it states numbers` });
        } else {
          result.downgraded.push({
            claim: { ...claim, kind: "interpretation", evidence: [] },
            reason: `cites evidence about ${subjects.join(", ")} but does not name it`,
          });
        }
        continue;
      }
      const unbacked = unbackedPairs(claim.text, matched);
      if (unbacked.length > 0) {
        result.dropped.push({
          claim,
          reason: `number(s) not in the evidence for the subject they are written next to: ${unbacked.join(", ")}`,
        });
        continue;
      }
      result.kept.push({ ...claim, evidence: matched.map(({ callId, entityId, field, value }) => ({ callId, entityId, field, value })) });
    } else {
      if (nums.length > 0) {
        result.dropped.push({ claim, reason: "interpretation states numbers" });
        continue;
      }
      result.kept.push({ ...claim, evidence: [] });
    }
  }
  return result;
}

/** Words that make a listing sentence read as a measured fact about the audience. */
const STAT_WORDS = /\b(affinity|skew|percent|percentile|velocity|over-?represented|according to qloo)\b/i;
/** A statement about how many buyers / readers / fans do or are something ("99 buyers love this", "most buyers are ..."). */
const AUDIENCE_FACT =
  /\b(\d[\d,.]*%?|most|majority|half|all|every)\b[^.!?]{0,30}?\b(buyers?|customers?|readers?|fans?|shoppers?|people|users?|parents|kids|players|listeners|viewers)\b/i;

export interface ListingCheck {
  title: string;
  description: string;
  coverDirection?: string;
  tags: string[];
  notes: string[];
}

/**
 * Checks the grounded listing body, not only the claims:
 * - audience statistics belong in the cited analysis, never in the customer-facing listing;
 *   a matching number from an unrelated metric cannot license them;
 * - tags are trimmed, de-duplicated and cut to the marketplace limits (Etsy: 13 tags of at most
 *   20 characters; KDP: 7 keywords of at most 50 characters).
 */
export function checkListing(
  listing: { title: string; description: string; tags: string[]; coverDirection?: string },
  registry: RegistryItem[],
  marketplace: "etsy" | "kdp" | "other",
  /** Numbers the maker gave (e.g. the price), which the listing may repeat. */
  allowed: number[] = [],
  /** Used when the title states an unbacked measurement (normally the idea as the maker wrote it). */
  fallbackTitle?: string,
): ListingCheck {
  const notes: string[] = [];
  // Keep the registry argument for API compatibility; even a real audience statistic must not be
  // turned into listing copy. Ordinary specs (Vol. 1, 8.5 x 11, $4.99) are not audience statistics.
  void registry;
  const makerNumbers = [...allowed, ...evidenceNumbers([{ callId: "input", field: "input", value: fallbackTitle ?? "" }])];
  const passes = (s: string) => {
    if (STAT_WORDS.test(s) || AUDIENCE_FACT.test(s) || SALES_FACT.test(s)) return false;
    // Currency amounts are prices, not arbitrary product dimensions. Only the explicitly supplied
    // maker price may be repeated, regardless of what numbers happen to appear in Qloo evidence.
    const prices = [...s.matchAll(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)|\bUSD\s*(\d+(?:,\d{3})*(?:\.\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?)\s*USD\b/gi)]
      .map((m) => Number((m[1] ?? m[2] ?? m[3]).replace(/,/g, "")));
    if (prices.some((price) => !numberIsBacked(price, allowed))) return false;
    // A maker-supplied material percentage may stay; a random taste index cannot back it.
    const percentages = [...s.matchAll(/\d+(?:\.\d+)?%/g)].map((m) => normalizeNumber(m[0])!);
    return percentages.every((n) => numberIsBacked(n, makerNumbers));
  };
  const why = () => "audience statistics and sales assertions belong in the evidence analysis; currency prices must match the maker's supplied price";
  const gate = (where: string, text: string) =>
    text
      .split(/(?<=[.!?])\s+/)
      .filter((s) => {
        if (passes(s)) return true;
        notes.push(`listing: removed from ${where} "${s.trim()}" — ${why()}`);
        return false;
      })
      .join(" ")
      .trim();

  const description = gate("description", listing.description);
  const coverDirection = listing.coverDirection === undefined ? undefined : gate("cover", listing.coverDirection);

  let title = listing.title.trim();
  if (!passes(title)) {
    const fallback = (fallbackTitle ?? "").trim();
    const replacement = passes(fallback) ? fallback : "";
    notes.push(`listing: title "${title}" ${why()}; replaced with ${replacement ? `"${replacement}"` : "an empty title"}`);
    title = replacement;
  }

  const max = marketplace === "kdp" ? 7 : 13;
  const maxLen = marketplace === "etsy" ? 20 : 50;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of listing.tags) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) continue;
    if (!passes(t)) {
      notes.push(`listing: dropped tag "${t}" — ${why()}`);
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.length > maxLen) {
      notes.push(`listing: dropped tag "${t}" — longer than ${maxLen} characters`);
      continue;
    }
    tags.push(t);
  }
  if (tags.length > max) {
    notes.push(`listing: cut ${tags.length - max} tag(s) over the limit of ${max}`);
    tags.length = max;
  }
  if (marketplace === "etsy" && title.length > 140) {
    notes.push("listing: title cut to Etsy's 140 characters");
    title = title.slice(0, 140).trim();
  }
  return { title, description, ...(coverDirection === undefined ? {} : { coverDirection }), tags, notes };
}
