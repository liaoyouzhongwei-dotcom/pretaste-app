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
const NUMBER_RE = /(?<![\w.])-?\d+(?:\.\d+)?%?(?![\w])/g;

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
  // Accept the same value, or the same value shown as a percentage / rounded.
  return backing.some(
    (b) =>
      Math.abs(b - n) < 1e-6 ||
      Math.abs(b * 100 - n) < 0.51 ||
      Math.abs(b - n) < 0.0051 ||
      Math.abs(b - n * 100) < 0.51,
  );
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
  const free = evidenceNumbers(matched.filter((m) => !m.subject));
  const bySubject = new Map(named.map((sub) => [sub, evidenceNumbers(matched.filter((m) => m.subject === sub))]));
  const bad: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const at = m.index ?? 0;
    if (spans.some((sp) => at >= sp.start && at < sp.end)) continue;
    const n = normalizeNumber(m[0]);
    if (n === null) continue;
    if (numberIsBacked(n, free)) continue;
    const before = spans.filter((sp) => sp.end <= at).sort((x, y) => y.end - x.end)[0];
    const after = spans.filter((sp) => sp.start > at).sort((x, y) => x.start - y.start)[0];
    const owner = (before ?? after)?.subject;
    const backing = owner ? bySubject.get(owner) ?? [] : evidenceNumbers(matched);
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
 * - a sentence that states a measurement (a percentage, a decimal, or stat words) must use only
 *   numbers that are in the registry; otherwise the sentence is removed;
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
  const backing = [...evidenceNumbers(registry), ...allowed];
  const looksMeasured = (s: string) => /\d+(?:\.\d+)?%|\b\d*\.\d+\b/.test(s) || STAT_WORDS.test(s) || AUDIENCE_FACT.test(s);
  const unbacked = (s: string) =>
    (s.match(NUMBER_RE) ?? [])
      .map(normalizeNumber)
      .filter((n): n is number => n !== null)
      .filter((n) => !numberIsBacked(n, backing));
  // A measured-looking text passes only if it has numbers, all of them are in the evidence, and it is
  // not an audience fact resting on a word like "most" rather than on a number.
  const wordAudienceFact = (s: string) => AUDIENCE_FACT.test(s.replace(/\d[\d,.]*%?/g, "#"));
  const passes = (s: string) => !looksMeasured(s) || (/\d/.test(s) && unbacked(s).length === 0 && !wordAudienceFact(s));
  const why = (s: string) =>
    unbacked(s).length > 0
      ? `number(s) not in evidence: ${unbacked(s).join(", ")}`
      : "states a measurement or an audience fact with no number from the evidence";
  const gate = (where: string, text: string) =>
    text
      .split(/(?<=[.!?])\s+/)
      .filter((s) => {
        if (passes(s)) return true;
        notes.push(`listing: removed from ${where} "${s.trim()}" — ${why(s)}`);
        return false;
      })
      .join(" ")
      .trim();

  const description = gate("description", listing.description);
  const coverDirection = listing.coverDirection === undefined ? undefined : gate("cover", listing.coverDirection);

  let title = listing.title.trim();
  if (!passes(title)) {
    const replacement = (fallbackTitle ?? "").trim();
    notes.push(`listing: title "${title}" ${why(title)}; replaced with ${replacement ? `"${replacement}"` : "an empty title"}`);
    title = replacement;
  }

  const max = marketplace === "kdp" ? 7 : 13;
  const maxLen = marketplace === "etsy" ? 20 : 50;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of listing.tags) {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) continue;
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
