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
  /** Top two ideas within this many points are too close to call. */
  tieMargin: 0.03,
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
      const ev: Evidence[] = a.age.bands
        .filter((b) => typeof d.age[b] === "number")
        .map((b) => ({ callId: d.callId, field: `age.${b}`, value: d.age[b] as number }));
      if (ev.length === 0) return unverifiable("Guessed age bands not present in the signal.");
      const mean = r2(ev.reduce((s, e) => s + (e.value as number), 0) / ev.length);
      const top = (Object.entries(d.age) as [AgeBand, number][]).sort((x, y) => y[1] - x[1])[0];
      const v = verdictBy(mean, THRESHOLDS.ageSkew);
      const claims = [claim(`Mean skew of the guessed age bands is ${mean}.`, "qloo", ev)];
      if (top) claims.push(claim(`Strongest band is ${top[0]} (${top[1]}).`, "qloo", [{ callId: d.callId, field: `age.${top[0]}`, value: top[1] }]));
      return { verdict: v, reason: `the guessed age groups are ${mean < 0 ? "under" : "over"}-represented by ${Math.abs(mean)} on average compared with the average Qloo audience (beyond ±${THRESHOLDS.ageSkew} counts as a lean; taste affinity, not purchase intent)`, claims };
    }
    case "gender": {
      const d = state.demographics;
      const f = d?.gender.female;
      if (!d || typeof f !== "number") return unverifiable("No gender signal returned.");
      const ev: Evidence[] = [{ callId: d.callId, field: "gender.female", value: f }];
      let v: Verdict;
      if (a.gender.lean === "neutral") v = Math.abs(f) < THRESHOLDS.genderSkew ? "supported" : "refuted";
      else v = verdictBy(a.gender.lean === "female" ? f : -f, THRESHOLDS.genderSkew);
      return {
        verdict: v,
        reason: `the audience leans toward ${f < 0 ? "men" : "women"} by ${Math.abs(f)} compared with the average Qloo audience (beyond ±${THRESHOLDS.genderSkew} counts as a lean; taste affinity, not purchase intent)`,
        claims: [claim(`Female skew of this audience is ${f}.`, "qloo", ev)],
      };
    }
    case "lifeStage":
      return unverifiable("Qloo does not report life stage; kept as the agent's guess.");
    case "aesthetic": {
      const t = state.tasteTags;
      if (!t?.tags.length) return unverifiable("Qloo returned no taste tags for these comparables.");
      const guessed = a.aesthetic.tags.map((g) => g.trim()).filter(Boolean);
      if (guessed.length === 0) return unverifiable("The guess names no look to check.");
      const hits = guessed.map((g) => ({ g, tag: t.tags.find((x) => tagMatches(g, x.name)) }));
      const matched = hits.filter((x) => x.tag);
      const ev = (x: TasteTag): Evidence => ({ callId: x.callId, field: `tags.${x.name}.affinity`, value: x.affinity });
      const styles = t.tags.filter((x) => x.kind === "style");
      const strongest = (styles.length ? styles : t.tags).slice(0, 4);
      const strongestText = strongest.map((x) => x.name).join(", ");
      const claims = [
        ...matched.map((m) => claim(`"${m.g}" matches Qloo's tag ${m.tag!.name} (affinity ${r2(m.tag!.affinity)}).`, "qloo", [ev(m.tag!)])),
        claim(`Qloo's strongest ${styles.length ? "style " : ""}tags for these fans: ${strongestText}.`, "qloo", strongest.map(ev)),
      ];
      const missed = hits.filter((x) => !x.tag).map((x) => x.g);
      const scope = `the ${t.tags.length} style and topic tags Qloo most ties to fans of the comparables`;
      if (matched.length === 0) {
        return { verdict: "refuted", reason: `none of the guessed looks (${guessed.join(", ")}) is among ${scope}; the strongest style tags are ${strongestText}`, claims };
      }
      if (matched.length * 2 >= guessed.length) {
        return { verdict: "supported", reason: `${matched.length} of ${guessed.length} guessed looks are among ${scope}${missed.length ? `; not found: ${missed.join(", ")}` : ""}`, claims };
      }
      return unverifiable(`Mixed: only ${matched.map((m) => m.g).join(", ")} of the guessed looks is among ${scope}; ${missed.join(", ")} ${missed.length > 1 ? "are" : "is"} not. The strongest style tags are ${strongestText}.`, claims);
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
export const RANK_FORMULA = "0.4·affinity + 0.3·trend + 0.3·found − 0.2·tag similarity";
/** Used when Qloo returned no trend for any idea (trend dropped, the rest rescaled by 1/0.7). */
export const RANK_FORMULA_NO_TREND = "(0.4·affinity + 0.3·found) ÷ 0.7 − 0.2·tag similarity (no trend data for any idea)";

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
      ? r2((0.4 * affinity + 0.3 * found) / 0.7 - 0.2 * overlap)
      : r2(0.4 * affinity + 0.3 * trend + 0.3 * found - 0.2 * overlap);

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
  if (scored.length >= 2 && scored[0] === out[0]) out[0] = { ...out[0], robust: weightCheck(scored, noTrend) };
  return assignCalls(state, out);
}

/** Moves each weight up and down by 0.1 and counts the weightings that keep the same idea first. */
export function weightCheck(scored: IdeaScore[], noTrend: boolean): { held: number; of: number } {
  const base = { affinity: 0.4, trend: 0.3, found: 0.3, overlap: 0.2 };
  const keys = (noTrend ? ["affinity", "found", "overlap"] : ["affinity", "trend", "found", "overlap"]) as (keyof typeof base)[];
  const score = (p: IdeaScore["parts"], w: typeof base) => noTrend
    ? (w.affinity * p.affinity + w.found * p.found) / (w.affinity + w.found) - w.overlap * p.overlap
    : w.affinity * p.affinity + w.trend * p.trend + w.found * p.found - w.overlap * p.overlap;
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
  const wrong = [
    ...(state.verdicts ?? []).filter((v) => v.verdict === "refuted").map((v) => ASSUMPTION_LABELS[v.field].toLowerCase()),
    ...(state.makerAssumptionChecks ?? []).filter((c) => c.status === "contradicts").map((c) => `your note "${c.text}"`),
  ];
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
        r.callReason = `Ranks first on Qloo's taste signals, but Qloo challenged its ${wrong.join(", ")} guess${wrong.length > 1 ? "es" : ""}: revise those, then research it.`;
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
