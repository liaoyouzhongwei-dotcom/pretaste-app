/** Maker assertions are checked separately from the agent's blind guesses. */
import { AGE_BANDS, type MakerAssumption, type MakerAssumptionCheck, type NeighborEntity, type ProductInput, type RunState } from "./types";
import { THRESHOLDS } from "./rules";

/** Keep only exact quotes, and retain unparsed notes explicitly as uncheckable. */
export function preserveMakerNotes(input: ProductInput, parsed: MakerAssumption[]): MakerAssumption[] {
  const notes = input.ownAssumptions?.trim();
  if (!notes) return [];
  const kept = parsed.filter((a) => a.text.trim() && notes.includes(a.text) &&
    (a.idea === null || (Number.isInteger(a.idea) && a.idea >= 0 && a.idea < input.ideas.length)));
  let remainder = notes;
  for (const a of kept) remainder = remainder.split(a.text).join(" ");
  if (/[\p{L}\p{N}]/u.test(remainder.replace(/\b(and|but|also)\b/gi, ""))) {
    kept.push({ text: notes, idea: null, field: "other", values: [] });
  }
  // The model sometimes files "bought mostly by women over 55" as an unchecked belief. Plain demographic
  // words are also read by rule, so a stated age or gender is always checked whatever the model returned.
  const out: MakerAssumption[] = [];
  for (const a of kept) {
    if (a.field !== "other") { out.push(a); continue; }
    const sentences = a.text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [a.text];
    for (const text of sentences) {
      const demo = ruleDemographics(text);
      const covered = (f: string) => [...kept, ...out].some((x) => x.field === f && (x.text.includes(text) || text.includes(x.text)));
      const idea = a.idea ?? ideaNamed(text, input.ideas);
      if (demo.age && !covered("age")) out.push({ text, idea, field: "age", values: demo.age });
      if (demo.gender && !covered("gender")) out.push({ text, idea, field: "gender", values: [demo.gender] });
      if (!demo.age && !demo.gender) out.push({ ...a, text: sentences.length > 1 ? text : a.text });
    }
  }
  return out;
}

const BAND_RANGE: Record<(typeof AGE_BANDS)[number], [number, number]> = {
  "24_and_younger": [0, 24], "25_to_29": [25, 29], "30_to_34": [30, 34],
  "35_to_44": [35, 44], "45_to_54": [45, 54], "55_and_older": [55, Infinity],
};

/** Age bands and gender stated in plain words; nothing is inferred from the product. */
export function ruleDemographics(text: string): { age?: string[]; gender?: "female" | "male" } {
  const t = text.toLowerCase();
  const female = /\b(women|woman|girls?|moms?|mothers?|ladies|female)\b/.test(t);
  const male = /\b(men|man|boys?|dads?|fathers?|male)\b/.test(t);
  const over = t.match(/\b(?:over|above|older than)\s+(\d{2})\b|\b(\d{2})\s*(?:\+|and (?:over|older|up)\b)/);
  const under = t.match(/\b(?:under|below|younger than)\s+(\d{2})\b/);
  let age: string[] | undefined;
  if (over) {
    const n = Number(over[1] ?? over[2]);
    age = AGE_BANDS.filter((b) => BAND_RANGE[b][1] > n);
  } else if (under) {
    const n = Number(under[1]);
    age = AGE_BANDS.filter((b) => BAND_RANGE[b][0] < n);
  } else if (/\b(teens?|teenage|teenagers?|kids|children|students|young people)\b/.test(t)) age = ["24_and_younger"];
  else if (/\b(retirees|seniors|retired)\b/.test(t)) age = ["55_and_older"];
  const gender = female !== male ? (female ? "female" : "male") as "female" | "male" : undefined;
  return { ...(age?.length ? { age } : {}), ...(gender ? { gender } : {}) };
}

/** The one idea whose words the note uses, or null when it names none or several. */
function ideaNamed(text: string, ideas: string[]): number | null {
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.replace(/s$/, "")));
  const note = words(text);
  const hits = ideas.flatMap((idea, i) => ([...words(idea)].some((w) => note.has(w)) ? [i] : []));
  return hits.length === 1 ? hits[0] : null;
}

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function positiveNeighbour(state: RunState, value: string): NeighborEntity | undefined {
  return (state.neighbors ?? []).find((n) => normalize(n.name) === normalize(value) && Number.isFinite(n.affinity) && n.affinity > 0);
}

/** Maker-named likes whose name equals a positive neighbour. Step 7 searches each one, so the check
 *  below compares entity ids, not words (same rule as the agent's guessed likes, A3). */
export function makerLikeCandidates(state: RunState, limit = 4): { item: string; hit: NeighborEntity }[] {
  const seen = new Set<string>();
  return (state.makerAssumptions ?? [])
    .filter((a) => a.field === "likes")
    .flatMap((a) => a.values)
    .flatMap((item) => {
      const hit = positiveNeighbour(state, item);
      const key = hit ? hit.entityId + "|" + normalize(item) : "";
      if (!hit || seen.has(key)) return [];
      seen.add(key);
      return [{ item, hit }];
    })
    .slice(0, limit);
}

export function checkMakerAssumptions(state: RunState): MakerAssumptionCheck[] {
  return (state.makerAssumptions ?? []).map((a) => {
    const result: MakerAssumptionCheck = {
      ...a, status: "cannot check", reason: "Qloo does not measure this assertion.", signals: [],
    };
    // Age and gender notes about another idea use that idea's own comparables (fetched in step 7).
    const otherIdea = a.idea !== null && a.idea !== state.focusIdea;
    const demo = otherIdea ? state.makerDemographics?.find((m) => m.idea === a.idea)?.skew : state.demographics;
    if (otherIdea && !(demo && (a.field === "age" || a.field === "gender"))) {
      result.reason = `The audience checks cover selected idea ${state.focusIdea + 1}, not idea ${a.idea! + 1}.`;
      return result;
    }
    const decide = (value: number, threshold: number) => {
      result.status = value >= threshold ? "matches" : value <= -threshold ? "contradicts" : "cannot check";
      result.reason = "Compared with relative affinity, not buyer counts or purchase shares. Values are the recorded signals.";
    };
    switch (a.field) {
      case "age": {
        const age = demo?.age;
        if (!age || !demo) break;
        const d = demo;
        result.signals = Object.entries(age).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
          .map(([band, value]) => ({ callId: d.callId, field: `age.${band}`, value: value! }));
        const bands = a.values.filter((v) => AGE_BANDS.includes(v as typeof AGE_BANDS[number]));
        const signals = result.signals.filter((s) => bands.includes(s.field.slice(4)));
        if (!bands.length || bands.length !== a.values.length || signals.length !== bands.length) {
          result.reason = "The full asserted age range is not available in the recorded age bands.";
          break;
        }
        decide(signals.reduce((sum, s) => sum + Number(s.value), 0) / signals.length, THRESHOLDS.ageSkew);
        // A mean can hide a group that points the other way (45-54 at -0.43 but 55+ at +0.14): then it is mixed, not decided.
        const against = signals.filter((s) => result.status === "contradicts" ? Number(s.value) >= THRESHOLDS.ageSkew : result.status === "matches" && Number(s.value) <= -THRESHOLDS.ageSkew);
        if (against.length) {
          result.status = "cannot check";
          result.reason = `Mixed: the stated age groups do not lean the same way (${signals.map((s) => `${s.field.slice(4)} ${s.value}`).join(", ")}). Relative affinity, not buyer counts.`;
        }
        break;
      }
      case "gender": {
        const d = demo;
        if (!d) break;
        result.signals = Object.entries(d.gender).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
          .map(([gender, value]) => ({ callId: d.callId, field: `gender.${gender}`, value: value! }));
        if (a.values.length !== 1) break;
        const lean = a.values[0];
        const f = d.gender.female;
        const m = d.gender.male;
        if (lean === "neutral" && typeof f === "number" && Number.isFinite(f)) {
          result.status = Math.abs(f) < THRESHOLDS.genderSkew ? "matches" : "contradicts";
          result.reason = "Compared with the recorded female affinity skew; this is not a buyer share.";
        } else if (lean === "female" || lean === "male") {
          const own = lean === "female" ? f : m;
          const opposite = lean === "female" ? m : f;
          const value = own ?? (opposite === undefined ? undefined : -opposite);
          if (value !== undefined && Number.isFinite(value)) decide(value, THRESHOLDS.genderSkew);
        }
        break;
      }
      case "region": {
        result.signals = (state.heatmap ?? []).filter((r) => Number.isFinite(r.score))
          .sort((x, y) => y.score - x.score).slice(0, 5)
          .map((r) => ({ callId: r.callId, field: `heatmap.${r.region}`, value: r.score }));
        result.reason = "Regional affinity does not establish where most buyers live. Top recorded regions are shown for comparison.";
        break;
      }
      case "likes": {
        // A name match counts only when Qloo resolved the item as written to that neighbour's own id.
        const hits = a.values.map((value) => {
          const n = positiveNeighbour(state, value);
          const same = n && state.likeEntities?.some((e) => e.item === value && e.neighborEntityId === n.entityId && e.entityId === n.entityId);
          return n ? { n, same: !!same } : undefined;
        });
        result.signals = hits.flatMap((h) => h ? [{ callId: h.n.callId, field: `affinity.${h.n.name}`, value: h.n.affinity }] : []);
        if (hits.length && hits.every((h) => h?.same)) {
          result.status = "matches";
          result.reason = "Each named item resolves to a positive-affinity taste neighbour's own Qloo id; this is not proof of purchases.";
        } else if (hits.some((h) => h && !h.same)) {
          result.reason = "A neighbour has the same name, but Qloo did not resolve the item to that neighbour's id, so it may be another title.";
        } else result.reason = "A limited neighbour list cannot disprove a preference; not every asserted item was found.";
        break;
      }
      case "trendDirection": {
        const ids = new Set((state.resolved ?? []).filter((r) => r.idea === state.focusIdea).map((r) => r.entityId));
        const trends = (state.trends ?? []).filter((t) => ids.has(t.entityId) && Number.isFinite(t.velocity));
        result.signals = trends.map((t) => ({ callId: t.callId, field: `velocity.${t.name}`, value: t.velocity }));
        if (!trends.length || a.values.length !== 1 || !["rising", "flat", "falling"].includes(a.values[0])) break;
        const mean = trends.reduce((sum, t) => sum + t.velocity, 0) / trends.length;
        const direction = mean > THRESHOLDS.trendFlat ? "rising" : mean < -THRESHOLDS.trendFlat ? "falling" : "flat";
        result.status = direction === a.values[0] ? "matches" : "contradicts";
        result.reason = `Comparable trend direction: ${direction}; this does not measure product sales or saturation.`;
        break;
      }
    }
    // Relative affinity cannot confirm quantified demographics or commercial outcomes.
    if (result.status === "matches" && /\b(most|mostly|majority|all|only|everyone|will buy|will sell|sell well|profit|revenue)\b|%|過半数|大半|ほとんど|必ず|売れる/i.test(a.text)) {
      result.status = "cannot check";
      result.reason = "Not confirmed: Qloo shows only a relative lean, which cannot show a buyer share or sales, so the claim stays unproven.";
    }
    return result;
  });
}
