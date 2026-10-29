/**
 * Steps 8-9: deterministic rules, no LLM.
 * Verdicts and the ranking are computed from recorded signals with the thresholds below,
 * which are shown on screen so anyone can re-check them. [Thresholds are first guesses;
 * to be tuned once more live Qloo values are seen.]
 *
 * Verdicts are about the server-selected focus idea only: the agent's guesses are checked against
 * the audience of that idea's own comparables, never against a mix of every idea.
 * A missing signal never counts as a refutation: it is "can't be checked".
 */
import type { Claim, Evidence } from "./claims";
import {
  ASSUMPTION_FIELDS,
  ASSUMPTION_LABELS,
  NO_GUESS_NOTE,
  type AgeBand,
  type AssumptionField,
  type AssumptionVerdict,
  type IdeaScore,
  type NeighborEntity,
  type RunState,
  type StyleRanking,
  type TasteTag,
  type Verdict,
} from "./types";

export const THRESHOLDS = {
  /** Mean skew of the guessed age bands at/above this = supported, at/below the negative = refuted. */
  ageSkew: 0.05,
  /** Gender skew needed to call a lean. */
  genderSkew: 0.05,
  /** Below this share of the focus idea's comparables found, "Also likes" can't be checked. */
  minFoundRatio: 0.5,
  /** How many of Qloo's top neighbours a guessed "also likes" item is looked for in. */
  topNeighbors: 10,
  /** Mean velocity band for "flat". */
  trendFlat: 0.05,
  /** How many top regions count as "the top". */
  topRegions: 3,
  /** Ideas scoring below this get the "don't make" flag. */
  dontMake: 0.35,
  /** Mean neighbour affinity below this is treated as no taste signal (a near-zero hit is not evidence). */
  minAffinity: 0.01,
  /** Top two ideas within this many points are too close to call. Re-running the same ideas moved a score by
   *  up to 7 points (eval fresh2, 3 runs), so a gap of 7 or less is not read as a difference. */
  tieMargin: 0.08,
  /** A guessed look in the strongest quarter of these fans' style tags supports the guess. */
  styleTop: 0.25,
  /** In the weaker half of the list, or missing from a complete list, it challenges the guess. */
  styleLow: 0.5,
} as const;

let claimSeq = 0;
function claim(text: string, kind: Claim["kind"], evidence: Evidence[]): Claim {
  claimSeq += 1;
  return { id: `v${claimSeq}`, text, kind, evidence };
}

function tagWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

const TAG_STOP = new Set(["a", "an", "the", "of", "and", "or", "with", "in", "on", "style", "aesthetic", "vibe", "vibes", "look"]);

/**
 * A guessed look matches a Qloo tag when every word of the guess is in the tag ("Japanese" / "japanese drama"),
 * or a tag of two or more words is wholly in the guess. A one-word tag never matches a longer guess
 * ("Life" is not "slice-of-life"). Words match exactly or by a shared stem of at least 5 letters
 * ("japan" / "japanese", "nostalgic" / "nostalgia").
 */
export function tagMatches(guess: string, tag: string): boolean {
  const g = tagWords(guess).filter((w) => !TAG_STOP.has(w)), t = tagWords(tag).filter((w) => !TAG_STOP.has(w));
  if (!g.length || !t.length) return false;
  const covers = (small: string[], large: string[]) => small.every((w) => large.some((v) => same(w, v)));
  return covers(g, t) || (t.length >= 2 && covers(t, g));
  function same(x: string, y: string): boolean {
    if (x === y) return true;
    let k = 0;
    while (k < x.length && k < y.length && x[k] === y[k]) k++;
    return k >= 5 && k >= Math.min(x.length, y.length) - 2;
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function verdictBy(value: number, threshold: number): Verdict {
  if (value >= threshold) return "supported";
  if (value <= -threshold) return "refuted";
  return "unverifiable";
}

function assumedText(state: RunState, field: AssumptionField): string {
  const a = state.assumptions;
  if (!a) return "—";
  switch (field) {
    case "age":
      return a.age.bands.join(", ");
    case "gender":
      return a.gender.lean;
    case "lifeStage":
      return a.lifeStage.value;
    case "aesthetic":
      return a.aesthetic.tags.join(", ");
    case "likes":
      return a.likes.note;
    case "trendDirection":
      return a.trendDirection.value;
    case "region":
      return a.region.states.join(", ");
  }
}

/** The focus idea's own comparables. */
export function focusResolved(state: RunState) {
  return (state.resolved ?? []).filter((r) => r.idea === state.focusIdea);
}

const GENERIC_WORDS = new Set([
  "the", "and", "for", "with", "fans", "fan", "lovers", "films", "film", "movies", "movie", "books", "book",
  "fiction", "novels", "novel", "shows", "show", "series", "tv", "brands", "brand", "games", "game", "music",
  "travel", "style", "culture", "things", "products", "items", "other", "like", "likes", "also", "anything",
]);

const NEGATION_RE = /\b(not|no|never|nor|without|except|dislikes?|disliked|hates?|hated|avoids?|isn't|aren't|doesn't|don't|didn't|won't|unlike)\b|n't\b/i;

/** Split the free-text "also likes" guess into items, and each item into its distinctive words.
 *  An item in a sentence with a negation is marked: it is never counted as a positive like. */
export function guessedLikes(note: string): { item: string; words: string[]; negated: boolean }[] {
  return note
    .split(/[.!?]\s|[.!?]$|\n/)
    .flatMap((sentence) => {
      const negated = NEGATION_RE.test(sentence);
      return sentence.split(/[,;/]|\band\b/i).map((s) => ({ item: s.trim(), negated }));
    })
    .filter((x) => x.item.length >= 3)
    .map(({ item, negated }) => ({
      item,
      negated,
      words: item
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w)),
    }))
    .filter((x) => x.words.length > 0);
}

/** Lower-case words joined by single spaces, without a leading "the". */
function phrase(s: string): string {
  return s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean).join(" ").replace(/^the /, "");
}

/** The whole neighbour name must appear in the item as a phrase (one shared word such as "Harry" is not enough). */
export function likeMatches(item: string, name: string): boolean {
  const n = phrase(name);
  if (n.replace(/ /g, "").length < 4) return false;
  return ` ${phrase(item)} `.includes(` ${n} `);
}

function topNeighbors(state: RunState): NeighborEntity[] {
  return [...(state.neighbors ?? [])].sort((x, y) => y.affinity - x.affinity).slice(0, THRESHOLDS.topNeighbors);
}

/** Non-negated guessed items whose words name one of the top neighbours. Step 7 searches each one
 *  (as written, with the neighbour's type) so that the rules can compare entity ids, not words. */
export function likeCandidates(state: RunState, limit = 4): { item: string; hit: NeighborEntity }[] {
  const top = topNeighbors(state);
  return guessedLikes(state.assumptions?.likes.note ?? "")
    .filter((it) => !it.negated)
    .flatMap((it) => {
      const hit = top.find((n) => likeMatches(it.item, n.name));
      return hit ? [{ item: it.item, hit }] : [];
    })
    .slice(0, limit);
}

type DemoRow = NonNullable<NonNullable<RunState["demographics"]>["perEntity"]>[number];
/** Leave-one-out over the comparables in the same demographics call: does the verdict survive dropping any one?
 *  With two comparables each must lean the same way on its own; with one, the verdict rests on it alone.
 *  Returns undefined when it cannot be tested. */
export function leaveOneOut(
  state: RunState,
  verdict: Verdict,
  measure: (rows: DemoRow[]) => number | undefined,
  verdictOf: (x: number) => Verdict,
): AssumptionVerdict["stability"] {
  const rows = state.demographics?.perEntity ?? [];
  if (rows.length === 0 || verdict === "unverifiable") return undefined;
  if (rows.length === 1) {
    const r = (state.resolved ?? []).find((c) => c.entityId === rows[0].entityId);
    return { held: false, comparables: 1, dependsOn: r?.resolvedName ?? r?.name ?? rows[0].entityId };
  }
  for (let i = 0; i < rows.length; i++) {
    const x = measure(rows.filter((_, j) => j !== i));
    if (x === undefined || verdictOf(x) !== verdict) {
      const r = (state.resolved ?? []).find((c) => c.entityId === rows[i].entityId);
      return { held: false, comparables: rows.length, dependsOn: r?.resolvedName ?? r?.name ?? rows[i].entityId };
    }
  }
  return { held: true, comparables: rows.length };
}
const meanOf = (xs: (number | undefined)[]): number | undefined => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};
const restsOnOne = (s: NonNullable<AssumptionVerdict["stability"]>) => s.comparables === 1
  ? `; only one comparable ("${s.dependsOn}") gave this signal, so it rests on one comparable and is not established`
  : `; with "${s.dependsOn}" left out the lean no longer passes the threshold, so it rests on one comparable and is not established`;

/** "Before We Say Goodbye (Before the Coffee Gets Cold, #4)" → "before the coffee gets cold". */
export function seriesOf(name: string): string | null {
  const m = name.match(/\(([^()]+?),\s*#\s*\d[^()]*\)\s*$/);
  return m ? m[1].trim().toLowerCase() : null;
}

/** Another entry of a comparable's own series (or the comparable itself) says little about what else its fans like. */
export function dropOwnSeries<T extends { name: string; entityId: string }>(
  list: T[],
  comparables: { name: string; entityId: string | null }[],
): { kept: T[]; dropped: T[] } {
  const ids = new Set(comparables.map((c) => c.entityId).filter((x): x is string => !!x));
  const own = new Set<string>();
  for (const c of comparables) {
    const s = seriesOf(c.name);
    if (s) own.add(s);
    own.add(c.name.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase());
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const e of list) {
    const s = seriesOf(e.name);
    (ids.has(e.entityId) || (s !== null && own.has(s)) ? dropped : kept).push(e);
  }
  return { kept, dropped };
}

/** Looks Qloo challenged (in the weakest half, or missing from a complete list): guess and tag name. */
export function challengedLooks(sr: StyleRanking | null | undefined): string[] {
  if (!sr) return [];
  return sr.checks.flatMap((c) => {
    if (!c.tag) return [];
    const low = c.rank ? c.rank / sr.total > THRESHOLDS.styleLow : sr.complete;
    return low ? [c.guess, c.tag] : [];
  });
}

/** Drops search tags that repeat a look Qloo challenged, so the After draft does not keep it. */
export function dropChallengedTags(tags: string[], looks: string[]): { tags: string[]; notes: string[] } {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const keys = [...new Set(looks.map(norm).filter((k) => k.trim()))];
  const notes: string[] = [];
  const kept = tags.filter((t) => {
    const hit = keys.find((k) => norm(t).includes(k));
    if (hit) notes.push(`listing: dropped tag "${t}" — repeats "${hit.trim()}", a look Qloo challenged for these fans`);
    return !hit;
  });
  return { tags: kept, notes };
}

/** Qloo tag names sometimes carry trailing punctuation ("Colorful,"); text shows them without it. */
const tagText = (t: string) => t.replace(/[\s,.;:]+$/, "");

function judgeLooks(sr: StyleRanking, strongestText: string, strongestClaim: Claim[]): Omit<AssumptionVerdict, "field" | "assumed"> {
  const total = sr.total;
  const placed = sr.checks.map((c) => {
    if (!c.tag) return { c, v: "none" as const };
    if (c.rank) {
      const share = c.rank / total;
      return { c, v: share <= THRESHOLDS.styleTop ? ("high" as const) : share > THRESHOLDS.styleLow ? ("low" as const) : ("middle" as const) };
    }
    return { c, v: sr.complete ? ("missing" as const) : ("none" as const) };
  });
  const claims: Claim[] = placed.flatMap(({ c, v }) => {
    if (c.rank && c.callId) return [claim(`"${c.guess}" is Qloo's style tag ${tagText(c.tag!)}: #${c.rank} of ${total} style tags for these fans (affinity ${c.affinity}).`, "qloo", [
      { callId: c.callId, field: `tags.${c.tag}.rank`, value: c.rank },
      { callId: sr.lastCallId ?? c.callId, field: "tags.style.total", value: total },
      { callId: c.callId, field: `tags.${c.tag}.affinity`, value: c.affinity ?? null },
    ])];
    if (v === "missing" && c.searchCallId) return [claim(`Qloo has a style tag ${tagText(c.tag!)}, but it is not among the ${total} style tags it ties to these fans.`, "qloo", [
      { callId: c.searchCallId, field: "results.tags.name", value: c.tag! },
      { callId: sr.lastCallId ?? c.searchCallId, field: "tags.style.total", value: total },
    ])];
    return [];
  });
  claims.push(...strongestClaim);
  const high = placed.filter((x) => x.v === "high"), low = placed.filter((x) => x.v === "low" || x.v === "missing");
  const checkable = placed.filter((x) => x.v !== "none");
  const none = placed.filter((x) => x.v === "none").map((x) => x.c.guess);
  const midList = placed.filter((x) => x.v === "middle").map((x) => `${x.c.guess} is #${x.c.rank}`);
  const midText = midList.length ? `; ${midList.join(", ")}, in the middle, so counted neither way` : "";
  const noneText = none.length ? `; ${none.join(", ")} ${none.length > 1 ? "are not Qloo style tags" : "is not a Qloo style tag"}, so not checked` : "";
  const scope = `the ${total} style tags Qloo ties to fans of the comparables`;
  if (!checkable.length) return { verdict: "unverifiable", reason: `none of the guessed looks (${none.join(", ")}) is a Qloo style tag, so none could be checked; the strongest style tags are ${strongestText}`, claims };
  const list = (xs: string[]) => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "";
  const ranked = (xs: typeof placed) => xs.map((x) => `${x.c.guess} is #${x.c.rank}`);
  const describe = (xs: typeof placed) => {
    const parts = [...ranked(xs.filter((x) => x.c.rank))];
    const miss = xs.filter((x) => x.v === "missing").map((x) => x.c.guess);
    if (miss.length) parts.push(`${list(miss)} ${miss.length > 1 ? "are" : "is"} not in the list at all`);
    return parts.join("; ");
  };
  if (low.length * 2 > checkable.length && !high.length) {
    return { verdict: "refuted", reason: `of ${scope}, ${describe(low)}${midText}${noneText}; the strongest are ${strongestText}`, claims };
  }
  if (high.length * 2 > checkable.length && !low.length) {
    return { verdict: "supported", reason: `of ${scope}, ${describe(high)}, in the strongest quarter${midText}${noneText}`, claims };
  }
  return { verdict: "unverifiable", reason: `mixed: of ${scope}, ${describe(checkable)}${noneText}; the strongest are ${strongestText}`, claims };
}

function judge(state: RunState, field: AssumptionField): Omit<AssumptionVerdict, "field" | "assumed"> {
  const a = state.assumptions!;
  const unverifiable = (reason: string, claims: Claim[] = []): Omit<AssumptionVerdict, "field" | "assumed"> => ({
    verdict: "unverifiable",
    reason,
    claims,
  });

  if (a.age.note === NO_GUESS_NOTE) return unverifiable("No LLM-only guess to check: the live model was unavailable.");

  switch (field) {
    case "age": {
      const d = state.demographics;
      if (!d) return unverifiable("No demographic signal returned.");
      const all = (Object.entries(d.age) as [AgeBand, number][]).filter(([, x]) => typeof x === "number");
      const guessedSet = new Set(a.age.bands);
      const mineBands = all.filter(([b]) => guessedSet.has(b)), others = all.filter(([b]) => !guessedSet.has(b));
      if (mineBands.length === 0) return unverifiable("Guessed age bands not present in the signal.");
      if (others.length === 0) return unverifiable("The guess covers every age band, so there is nothing to compare it with.");
      // Each band's skew is against the average Qloo audience. Compare the guessed bands with the
      // other bands of the same audience, so an audience that is low everywhere does not refute every guess.
      const rel = (ms: (number | undefined)[], os: (number | undefined)[]) => {
        const m = meanOf(ms), o = meanOf(os);
        return m === undefined || o === undefined ? undefined : r2(m - o);
      };
      const gap = rel(mineBands.map(([, x]) => x), others.map(([, x]) => x))!;
      const v = verdictBy(gap, THRESHOLDS.ageSkew);
      const evOf = (rows: [AgeBand, number][]): Evidence[] => rows.map(([b, x]) => ({ callId: d.callId, field: `age.${b}`, value: x }));
      const top = [...all].sort((x, y) => y[1] - x[1])[0];
      const claims = [
        claim(`Mean skew of the guessed age bands is ${r2(meanOf(mineBands.map(([, x]) => x))!)}.`, "qloo", evOf(mineBands)),
        claim(`Mean skew of the other age bands is ${r2(meanOf(others.map(([, x]) => x))!)}.`, "qloo", evOf(others)),
        claim(`Strongest band is ${top[0]} (${top[1]}).`, "qloo", evOf([top])),
      ];
      const stability = leaveOneOut(state, v,
        (rows) => rel(mineBands.map(([b]) => meanOf(rows.map((r) => r.age[b]))), others.map(([b]) => meanOf(rows.map((r) => r.age[b])))),
        (x) => verdictBy(x, THRESHOLDS.ageSkew));
      const reason = `the guessed age groups score ${Math.abs(gap)} ${gap < 0 ? "below" : "above"} the other age groups of the same audience (each against the average Qloo audience; a gap beyond ±${THRESHOLDS.ageSkew} counts as a lean; taste affinity, not purchase intent)`;
      if (stability && !stability.held) return { verdict: "unverifiable", reason: reason + restsOnOne(stability), claims, stability };
      // A higher average can hide a guessed band that is clearly weaker than the rest; that guess is mixed, not supported.
      const othersMean = meanOf(others.map(([, x]) => x))!;
      const weak = mineBands.filter(([, x]) => x < othersMean - THRESHOLDS.ageSkew);
      if (v === "supported" && weak.length) {
        return {
          verdict: "unverifiable",
          reason: `mixed: ${reason}, but ${weak.map(([b, x]) => `${b} (${x})`).join(", ")} ${weak.length > 1 ? "are" : "is"} more than ${THRESHOLDS.ageSkew} below the other age groups`,
          claims: [...claims, claim(`Guessed band${weak.length > 1 ? "s" : ""} ${weak.map(([b, x]) => `${b} (${x})`).join(", ")} below the other age groups.`, "qloo", evOf(weak))],
          ...(stability ? { stability } : {}),
        };
      }
      return { verdict: v, reason, claims, ...(stability ? { stability } : {}) };
    }
    case "gender": {
      const d = state.demographics;
      const f = d?.gender.female;
      if (!d || typeof f !== "number") return unverifiable("No gender signal returned.");
      const ev: Evidence[] = [{ callId: d.callId, field: "gender.female", value: f }];
      const lean = a.gender.lean;
      const genderVerdict = (x: number): Verdict =>
        lean === "neutral" ? (Math.abs(x) < THRESHOLDS.genderSkew ? "supported" : "refuted") : verdictBy(lean === "female" ? x : -x, THRESHOLDS.genderSkew);
      const v = genderVerdict(f);
      const stability = leaveOneOut(state, v, (rows) => meanOf(rows.map((r) => r.gender.female)), genderVerdict);
      const reason = `the audience leans toward ${f < 0 ? "men" : "women"} by ${Math.abs(f)} compared with the average Qloo audience (beyond ±${THRESHOLDS.genderSkew} counts as a lean; taste affinity, not purchase intent)`;
      const claims = [claim(`Female skew of this audience is ${f}.`, "qloo", ev)];
      if (stability && !stability.held) return { verdict: "unverifiable", reason: reason + restsOnOne(stability), claims, stability };
      return { verdict: v, reason, claims, ...(stability ? { stability } : {}) };
    }
    case "lifeStage":
      return unverifiable("Qloo does not report life stage; kept as the agent's guess.");
    case "aesthetic": {
      const t = state.tasteTags;
      const guessed = a.aesthetic.tags.map((g) => g.trim()).filter(Boolean);
      if (guessed.length === 0) return unverifiable("The guess names no look to check.");
      const ev = (x: TasteTag): Evidence => ({ callId: x.callId, field: `tags.${x.name}.affinity`, value: x.affinity });
      const styles = (t?.tags ?? []).filter((x) => x.kind === "style");
      const strongest = (styles.length ? styles : t?.tags ?? []).slice(0, 4);
      const strongestText = strongest.map((x) => x.name).join(", ");
      const strongestClaim = strongest.length ? [claim(`Qloo's strongest style tags for these fans: ${strongestText}.`, "qloo", strongest.map(ev))] : [];
      const sr = state.styleRanking;
      if (sr?.checks.length && sr.total > 0) return judgeLooks(sr, strongestText, strongestClaim);
      if (!t?.tags.length) return unverifiable("Qloo returned no taste tags for these comparables.");
      // Fallback when the full list was not fetched: only the top tags are known, so a missing look is not refuted.
      const hits = guessed.map((g) => ({ g, tag: t.tags.find((x) => tagMatches(g, x.name)) }));
      const matched = hits.filter((x) => x.tag);
      const claims = [...matched.map((m) => claim(`"${m.g}" matches Qloo's tag ${m.tag!.name} (affinity ${r2(m.tag!.affinity)}).`, "qloo", [ev(m.tag!)])), ...strongestClaim];
      const missed = hits.filter((x) => !x.tag).map((x) => x.g);
      const scope = `the ${t.tags.length} style and topic tags Qloo most ties to fans of the comparables`;
      if (matched.length && matched.length * 2 >= guessed.length) {
        return { verdict: "supported", reason: `${matched.length} of ${guessed.length} guessed looks are among ${scope}${missed.length ? `; not found: ${missed.join(", ")}` : ""}`, claims };
      }
      return unverifiable(`${matched.length ? `Only ${matched.map((m) => m.g).join(", ")}` : "None"} of the guessed looks is among ${scope}. Not counted as refuted: only the top tags were fetched. The strongest style tags are ${strongestText}.`, claims);
    }
    case "likes": {
      const mine = focusResolved(state);
      const found = mine.filter((r) => r.entityId).length;
      const ratio = mine.length ? found / mine.length : 0;
      if (ratio < THRESHOLDS.minFoundRatio || found === 0) {
        return unverifiable(`Only ${found} of ${mine.length} comparables for this idea were found in Qloo.`);
      }
      const top = topNeighbors(state);
      if (top.length === 0) return unverifiable("No taste neighbours returned.");
      const items = guessedLikes(a.likes.note);
      if (items.length === 0) return unverifiable("The guess names nothing specific to look for.");
      const named = likeCandidates(state);
      const topList = top.slice(0, 3).map((n) => `${n.name} (${r2(n.affinity)})`).join(", ");
      const topEv: Evidence[] = top.slice(0, 3).map((n) => ({ callId: n.callId, entityId: n.entityId, field: "query.affinity", value: n.affinity }));
      if (named.length > 0 && !state.likeEntities) {
        return unverifiable("Guessed items share a name with a neighbour, but whether they are the same entity was not checked.",
          [claim(`Qloo's strongest neighbours: ${topList}.`, "qloo", topEv)]);
      }
      const checked = named.map((m) => ({ ...m, found: state.likeEntities?.find((e) => e.item === m.item && e.neighborEntityId === m.hit.entityId) }));
      const matches = checked.filter((m) => m.found?.entityId === m.hit.entityId);
      const others = checked.filter((m) => m.found && m.found.entityId !== m.hit.entityId);
      if (matches.length > 0) {
        return {
          verdict: "supported",
          reason: `${matches.length} of ${items.length} guessed items are the same Qloo entity as one of the top ${top.length} neighbours`,
          claims: matches.map((m) =>
            claim(`"${m.item}" is ${m.hit.name} (affinity ${r2(m.hit.affinity)}).`, "qloo", [
              { callId: m.hit.callId, entityId: m.hit.entityId, field: "query.affinity", value: m.hit.affinity },
            ]),
          ),
        };
      }
      const differ = others.length
        ? ` ${others.length} item(s) share a name with a neighbour but Qloo search resolves them to a different entity, so they are not counted.`
        : "";
      return unverifiable(
        `None of the ${items.length} guessed items is the same entity as one of Qloo's top ${top.length} neighbours. Not counted as refuted: the list only shows the strongest neighbours.${differ}`,
        [claim(`Qloo's strongest neighbours instead: ${topList}.`, "qloo", topEv)],
      );
    }
    case "trendDirection": {
      const ids = new Set(focusResolved(state).map((r) => r.entityId).filter(Boolean));
      const t = (state.trends ?? []).filter((p) => ids.has(p.entityId));
      if (t.length === 0) return unverifiable("No trend data for this idea's comparables.");
      const mean = r2(t.reduce((s, p) => s + p.velocity, 0) / t.length);
      const actual = mean > THRESHOLDS.trendFlat ? "rising" : mean < -THRESHOLDS.trendFlat ? "falling" : "flat";
      const ev: Evidence[] = t.map((p) => ({ callId: p.callId, entityId: p.entityId, field: "query.velocity", value: p.velocity }));
      return {
        verdict: actual === a.trendDirection.value ? "supported" : "refuted",
        reason: `mean velocity ${mean} over ${t.length} comparable(s), flat band ±${THRESHOLDS.trendFlat} -> ${actual}`,
        claims: [claim(`Mean trend velocity of the comparables is ${mean} (${actual}).`, "qloo", ev)],
      };
    }
    case "region": {
      const h = [...(state.heatmap ?? [])].sort((x, y) => y.score - x.score);
      if (h.length === 0) return unverifiable("No regional signal returned.");
      const top = h.slice(0, THRESHOLDS.topRegions);
      const guessed = new Set(a.region.states.map((s) => s.trim().toLowerCase()));
      const ranks = h.map((r, i) => ({ r, rank: i + 1 })).filter((x) => guessed.has(x.r.region.toLowerCase()));
      const hits = ranks.filter((x) => x.rank <= THRESHOLDS.topRegions);
      const ev: Evidence[] = top.map((r) => ({ callId: r.callId, field: `heatmap.${r.region}`, value: r.score }));
      const claims = [claim(`Top regions: ${top.map((r) => `${r.region} (${r.score})`).join(", ")}.`, "qloo", ev)];
      if (hits.length > 0) {
        return { verdict: "supported", reason: `${hits.map((x) => x.r.region).join(", ")} in the top ${top.length}`, claims };
      }
      // Only the top regions are kept, so a low place in this list is not a low national rank.
      // Never refute a region guess from it.
      const where = ranks.length ? ranks.map((x) => `${x.r.region} #${x.rank}`).join(", ") : "none of the guessed states";
      return unverifiable(`Not in the top ${top.length} (${where} among the ${h.length} highest-scoring states kept); the full national ranking isn't recorded, so this can't show the guess is wrong.`, claims);
    }
  }
}

/** Step 8. */
export function computeVerdicts(state: RunState): AssumptionVerdict[] {
  if (!state.assumptions) return [];
  return ASSUMPTION_FIELDS.map((field) => ({ field, assumed: assumedText(state, field), ...judge(state, field) }));
}

/** Step 9: rank ideas. A part with no signal adds 0 points (never a neutral guess). */
// How many comparables were found is a gate (under half found = not ranked), never a weight:
// otherwise two ideas with the same audience would be separated by search luck.
export const RANK_FORMULA = "(0.4·affinity + 0.3·trend) ÷ 0.7 − 0.2·tag similarity";
/** Used when Qloo returned no trend for any idea. */
export const RANK_FORMULA_NO_TREND = "affinity − 0.2·tag similarity (no trend data for any idea)";

export function rankIdeas(state: RunState): IdeaScore[] {
  const n = state.input.ideas.length;
  const resolved = state.resolved ?? [];
  const out: IdeaScore[] = [];
  // An interrupted shared comparison is not evidence against whichever idea happened to be
  // queried later. Keep the available scores for inspection, but make no production decision.
  const failedComparisons = [...new Set(state.errors.filter((e) => [2, 4, 5, 6].includes(e.step)).map((e) => e.step))];
  const trendIds = new Set((state.trends ?? []).map((t) => t.entityId));
  // One signal set for the whole run: trend counts only when every idea with a found comparable has it.
  // Otherwise trend is dropped for all, so one idea's extra trend cannot reorder the others (N07).
  const withFound = Array.from({ length: n }, (_, idea) => idea).filter((idea) => resolved.some((r) => r.idea === idea && r.entityId));
  const noTrend = withFound.length === 0 || withFound.some((idea) =>
    !resolved.some((r) => r.idea === idea && r.entityId && trendIds.has(r.entityId)));
  for (let idea = 0; idea < n; idea++) {
    const mine = resolved.filter((r) => r.idea === idea);
    const foundN = mine.filter((r) => r.entityId).length;
    const found = mine.length ? foundN / mine.length : 0;
    const missing: string[] = [];

    const ownGroup = state.ideaNeighbors?.find((x) => x.idea === idea);
    const own = ownGroup?.neighbors ?? [];
    const returnedN = ownGroup?.returned ?? own.length;
    const topOwn = [...own].sort((x, y) => y.affinity - x.affinity).slice(0, 5);
    const affinity = topOwn.length ? topOwn.reduce((s, nb) => s + nb.affinity, 0) / topOwn.length : 0;
    if (topOwn.length === 0) missing.push("affinity");

    const ids = new Set(mine.map((r) => r.entityId).filter(Boolean));
    const vel = (state.trends ?? []).filter((t) => ids.has(t.entityId));
    let trend = 0;
    if (vel.length) {
      const v = vel.reduce((s, t) => s + t.velocity, 0) / vel.length;
      trend = Math.max(0, Math.min(1, 0.5 + v * 2));
    } else missing.push("trend");

    const overlap = Math.max(0, ...(state.compare ?? []).filter((c) => c.ideaA === idea || c.ideaB === idea).map((c) => c.overlap));
    // Without trend for every idea, trend cannot separate them: drop it and rescale the rest to 0–1.
    const score = noTrend
      ? r2(affinity - 0.2 * overlap)
      : r2((0.4 * affinity + 0.3 * trend) / 0.7 - 0.2 * overlap);

    const checkedN = mine.filter((r) => r.status !== "failed" && r.status !== "unprocessed").length;
    const onHold = checkedN < mine.length || failedComparisons.length > 0;
    let dontMakeReason: string | null = null;
    let unranked = false;
    if (failedComparisons.length) dontMakeReason = `On hold: Qloo comparison step(s) ${failedComparisons.join(", ")} failed or stopped partway; ${checkedN} of ${mine.length} planned comparables for this idea were checked (${foundN} found). The available scores are provisional, not evidence to make or reject an idea. Re-run before deciding.`;
    else if (onHold) dontMakeReason = `On hold: Qloo stopped partway, so only ${checkedN} of ${mine.length} planned comparables were checked (${foundN} found). Re-run before deciding.`;
    else if (foundN === 0) { unranked = true; dontMakeReason = "Not ranked: none of its comparables were found in Qloo, so nothing backs it. Pick other comparables and run again."; }
    else if (found < THRESHOLDS.minFoundRatio) { unranked = true; dontMakeReason = `Not ranked: only ${foundN} of ${mine.length} comparables were found, too little evidence to place it. Pick other comparables and run again.`; }
    else if (topOwn.length === 0) {
      unranked = true;
      dontMakeReason = returnedN > 0
        ? `Not ranked: Qloo returned ${returnedN} taste neighbour(s) but none had an affinity score, so this idea cannot be ranked on taste. Pick other comparables and run again.`
        : "Not ranked: Qloo returned no taste neighbours for it, so there is no audience to point at. Pick other comparables and run again.";
    }
    else if (affinity < THRESHOLDS.minAffinity) dontMakeReason = `Its taste signal is near zero (mean affinity ${affinity.toPrecision(2)} < ${THRESHOLDS.minAffinity}): finding the titles is not the same as an audience.`;
    else if (score < THRESHOLDS.dontMake) dontMakeReason = `${pts(score)} / 100 is under the ${pts(THRESHOLDS.dontMake)}-point line, the lowest score worth researching.`;

    out.push({
      idea,
      score,
      formula: noTrend ? RANK_FORMULA_NO_TREND : RANK_FORMULA,
      parts: { affinity: r2(affinity), trend: r2(trend), found: r2(found), overlap: r2(overlap) },
      missing: noTrend && !missing.includes("trend") ? [...missing, "trend"] : missing,
      dontMake: dontMakeReason !== null,
      dontMakeReason,
      ...(onHold ? { onHold: true } : {}),
      ...(unranked && !onHold ? { unranked: true } : {}),
    });
  }
  // Ideas with no taste signal have no comparable score: they go after every scored idea.
  out.sort((a, b) => Number(!!a.unranked) - Number(!!b.unranked) || b.score - a.score);
  const scored = out.filter((s) => !s.unranked && !s.onHold);
  // Without trend data only the small overlap weight can move, which cannot reorder ideas: no check to show.
  if (scored.length >= 2 && !noTrend && scored[0] === out[0]) out[0] = { ...out[0], robust: weightCheck(scored, noTrend) };
  return assignCalls(state, out);
}

/** Moves each weight up and down by 0.1 and counts the weightings that keep the same idea first. */
export function weightCheck(scored: IdeaScore[], noTrend: boolean): { held: number; of: number } {
  const base = { affinity: 0.4, trend: 0.3, overlap: 0.2 };
  const keys = (noTrend ? ["overlap"] : ["affinity", "trend", "overlap"]) as (keyof typeof base)[];
  const score = (p: IdeaScore["parts"], w: typeof base) => noTrend
    ? p.affinity - w.overlap * p.overlap
    : (w.affinity * p.affinity + w.trend * p.trend) / (w.affinity + w.trend) - w.overlap * p.overlap;
  let held = 0, of = 0;
  for (const k of keys) for (const d of [-0.1, 0.1]) {
    const w = { ...base, [k]: r2(base[k] + d) };
    of++;
    const top = scored.reduce((best, s) => (score(s.parts, w) > score(best.parts, w) ? s : best));
    if (top.idea === scored[0].idea) held++;
  }
  return { held, of };
}

// Words that name a format or a version, not what the product is about.
const FORMAT_WORDS = new Set(
  ("a an the of for and or with to in on at by from as is it its your my me no same new current kept higher lower " +
    "more fewer larger smaller bigger page pages count title edition expanded version revised updated size " +
    "paperback hardcover book printable pdf digital listing set sets bundle price cheaper only")
    .split(" "),
);

function subjectWords(idea: string): Set<string> {
  return new Set(
    idea.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !/\d/.test(w) && !FORMAT_WORDS.has(w)),
  );
}

/**
 * Ideas that are the same product in another format or version (more pages, a new edition):
 * every subject word of the shorter idea is in the longer one, with at least 3 such words.
 * Qloo's signals come from each idea's comparables, so a score gap between these ideas only
 * reflects which comparables were picked. Returns, for each idea, the other ideas it matches.
 */
export function sameProductIdeas(ideas: string[]): number[][] {
  const words = ideas.map(subjectWords);
  return words.map((a, i) =>
    words.flatMap((b, j) => {
      if (i === j) return [];
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      return small.size >= 3 && [...small].every((w) => large.has(w)) ? [j] : [];
    }),
  );
}

/** A 0–1 score as points out of 100, the scale the screen shows. */
function pts(v: number): number {
  return Math.round(v * 100);
}

/** Make / fix / skip / hold for each ranked idea, with the reason. Only the top idea can be made. */
function assignCalls(state: RunState, ranked: IdeaScore[]): IdeaScore[] {
  const open = ranked.filter((r) => !r.dontMake);
  const [top, second] = open;
  const same = sameProductIdeas(state.input.ideas);
  const twins = top ? open.filter((r) => r !== top && same[top.idea]?.includes(r.idea)) : [];
  if (top && twins.length) {
    const group = [top, ...twins];
    const names = group.map((r) => `#${ranked.indexOf(r) + 1}`).join(", ");
    for (const r of ranked) {
      if (r.onHold) { r.call = "hold"; r.callReason = r.dontMakeReason ?? "Not all comparables were checked."; continue; }
      if (group.includes(r)) {
        r.call = "hold";
        r.callReason = `Can't separate: ideas ${names} are the same product in another format or version. Their scores differ only because different comparables were picked, not because Qloo saw a different audience. Decide between them with a sales test, not this ranking.`;
        continue;
      }
      r.call = "skip";
      if (r.unranked) { r.call = "hold"; r.callReason = r.dontMakeReason ?? ""; continue; }
      r.callReason = r.dontMake ? r.dontMakeReason ?? "" : `Above the ${pts(THRESHOLDS.dontMake)}-point line but behind ${names}, which can't be separated: settle those first.`;
    }
    return ranked;
  }
  // Scores are rounded to 2 places; compare the rounded gap so 0.96 vs 0.93 (exactly 0.03) is not called a tie by float error.
  const gap = (a: number, b: number) => Math.round((a - b) * 100) / 100;
  // Every open idea within the tie margin of #1 is held together, so no idea is told to wait for a "winner" it can't be separated from.
  const tied = top && second && gap(top.score, second.score) < THRESHOLDS.tieMargin
    ? open.filter((r) => !r.onHold && gap(top.score, r.score) < THRESHOLDS.tieMargin)
    : [];
  const tiedNames = tied.map((r) => `#${ranked.indexOf(r) + 1}`).join(", ");
  const wrongGuesses = (state.verdicts ?? []).filter((v) => v.verdict === "refuted").map((v) => ASSUMPTION_LABELS[v.field].toLowerCase());
  // One note can hold an age and a gender part; name it once.
  const wrongNotes = [...new Set((state.makerAssumptionChecks ?? []).filter((c) => c.status === "contradicts").map((c) => c.text))];
  const wrong = [...wrongGuesses, ...wrongNotes];
  const challenged = [
    ...(wrongGuesses.length ? [`its ${wrongGuesses.join(", ")} guess${wrongGuesses.length > 1 ? "es" : ""}`] : []),
    ...(wrongNotes.length ? [`your note${wrongNotes.length > 1 ? "s" : ""} ${wrongNotes.map((t) => `"${t}"`).join(", ")}`] : []),
  ].join(" and ");
  for (const r of ranked) {
    if (r.onHold) { r.call = "hold"; r.callReason = r.dontMakeReason ?? "Not all comparables were checked."; continue; }
    if (r.unranked) { r.call = "hold"; r.callReason = r.dontMakeReason ?? ""; continue; }
    if (r.dontMake) { r.call = "skip"; r.callReason = r.dontMakeReason ?? ""; continue; }
    if (tied.includes(r)) {
      r.call = "hold";
      const low = tied[tied.length - 1].score;
      r.callReason = tied.length > 2
        ? `Too close to call: ideas ${tiedNames} score ${pts(top.score)} to ${pts(low)}, all under ${pts(THRESHOLDS.tieMargin)} points from #1. The checks below use the first one; test them before choosing.`
        : `Too close to call: ${pts(top.score)} vs ${pts(second.score)} is under ${pts(THRESHOLDS.tieMargin)} points apart. The checks below use the first one; test both before choosing.`;
      continue;
    }
    if (r === top) {
      if (wrong.length && r.idea === state.focusIdea) {
        r.call = "fix";
        r.callReason = `${second ? `Leads the next idea by ${pts(top.score - second.score)} points on Qloo affinity` : "Ranks first on Qloo affinity"}, but Qloo challenged ${challenged}: revise ${wrong.length > 1 ? "those" : "that"}, then research it.`;
      } else {
        r.call = "make";
        r.callReason = second ? `Leads the next idea by ${pts(top.score - second.score)} points on the same signals.` : `The only idea above the ${pts(THRESHOLDS.dontMake)}-point line.`;
      }
      continue;
    }
    r.call = "skip";
    r.callReason = tied.length
      ? `Above the ${pts(THRESHOLDS.dontMake)}-point line but behind ${tiedNames}, which can't be separated: settle those first.`
      : top.call === "fix"
        ? `Above the ${pts(THRESHOLDS.dontMake)}-point line, ${pts(top.score - r.score)} points behind #1: fix #1 first, then compare again.`
        : `Above the ${pts(THRESHOLDS.dontMake)}-point line, ${pts(top.score - r.score)} points behind #1: make #1 first.`;
  }
  return ranked;
}
