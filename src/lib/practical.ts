/**
 * Step 10's "outside the data" notes (general knowledge, never checked against data).
 * The writer model may only use the maker's own price and calendar years as numbers here;
 * any other figure would look like data, so that sentence is removed and counted.
 * A tie-break is kept only when the rules really held two or more top ideas as too close to call.
 */
import { THRESHOLDS } from "./rules";
import type { IdeaScore, PracticalCheck } from "./types";

interface Draft {
  ideas: { idea: number; risks: string[]; priceFit: string }[];
  tieBreak: { idea: number; why: string } | null;
  notes?: { check: number; read: "likely right" | "likely wrong" | "unsure"; why: string }[];
}

/** Ideas the general-knowledge pick may choose from: none while the data names a first idea. */
export function startCandidates(ranking: IdeaScore[]): number[] {
  if (ranking.some((r) => r.call === "make" || r.call === "fix")) return [];
  const open = ranking.filter((r) => !r.dontMake && r.call !== "skip").map((r) => r.idea);
  return open.length >= 2 ? open : [];
}

function allowedNumbers(priceUsd: number | undefined, today: Date): Set<string> {
  const ok = new Set<string>();
  const y = today.getUTCFullYear();
  for (const n of [y - 1, y, y + 1, y + 2]) ok.add(String(n));
  if (priceUsd) {
    ok.add(String(priceUsd));
    ok.add(priceUsd.toFixed(2));
    ok.add(String(Math.round(priceUsd)));
  }
  return ok;
}

/** true when every number in the text is the maker's price or a calendar year. */
export function onlyAllowedNumbers(text: string, ok: Set<string>): boolean {
  // "Idea 1" points at a row the maker can see; it is not a figure.
  // A calendar date in an allowed year (e.g. today's server date) is a date, not a figure.
  const plain = text
    .replace(/\bideas?\s+#?\d+\b(?:\s*(?:,|and|&|or)\s*#?\d+\b)*/gi, "idea")
    .replace(/\b(\d{4})-\d{2}-\d{2}\b/g, (m, y: string) => (ok.has(y) ? "date" : m));
  return (plain.match(/\d+(?:[.,]\d+)?/g) ?? []).every((n) => ok.has(n.replace(",", "")));
}

/** The models see ideas numbered from 0; the maker sees Idea 1, 2, 3. Shift every idea reference by one. */
export function showIdeaNumbers(text: string): string {
  return text.replace(/\b(ideas?)(\s+#?)(\d+)\b((?:\s*(?:,|and|&|or)\s*#?\d+\b)*)/gi, (_m, w: string, sp: string, n: string, rest: string) =>
    w + sp + String(Number(n) + 1) + rest.replace(/\d+/g, (d) => String(Number(d) + 1)));
}

/** Risks as one line: "a; b" without a full stop before each semicolon. */
export function joinRisks(risks: string[]): string {
  return risks.map((r) => r.trim().replace(/[.。]+$/, "")).join("; ");
}

/** Ideas the rules held as too close to call, best first. */
export function heldTop(ranking: IdeaScore[]): number[] {
  // Only ideas held because their scores are too close; an idea held for missing evidence is not part of a tie.
  return [...ranking].sort((a, b) => b.score - a.score).filter((r) => r.call === "hold" && !r.unranked && !r.onHold).map((r) => r.idea);
}

export function checkPractical(
  draft: Draft | undefined,
  ideaCount: number,
  ranking: IdeaScore[],
  priceUsd: number | undefined,
  today: Date = new Date(),
  cannotCheck: number[] = [],
  checkTexts: string[] = [],
): PracticalCheck | undefined {
  if (!draft) return undefined;
  const ok = allowedNumbers(priceUsd, today);
  const dropped: string[] = [];
  const keepWith = (allowed: Set<string>) => (t: string): boolean => {
    const s = t.trim();
    if (!s) return false;
    if (onlyAllowedNumbers(s, allowed)) return true;
    dropped.push(s);
    return false;
  };
  const keep = keepWith(ok);
  const seen = new Set<number>();
  const ideas: PracticalCheck["ideas"] = [];
  for (const it of draft.ideas) {
    if (!Number.isInteger(it.idea) || it.idea < 0 || it.idea >= ideaCount || seen.has(it.idea)) continue;
    seen.add(it.idea);
    ideas.push({ idea: it.idea, risks: it.risks.filter(keep).slice(0, 3).map((r) => showIdeaNumbers(r.trim())), priceFit: keep(it.priceFit) ? showIdeaNumbers(it.priceFit.trim()) : "" });
  }
  ideas.sort((a, b) => a.idea - b.idea);
  const held = startCandidates(ranking);
  let tieBreak: PracticalCheck["tieBreak"] = null;
  const t = draft.tieBreak;
  // The tie-break may quote the scores shown in the ranking, their gap and the tie margin (that is why they are tied).
  const tieOk = new Set(ok);
  const addNum = (n: number) => {
    tieOk.add(String(n));
    tieOk.add(n.toFixed(2));
  };
  for (const a of ranking) {
    addNum(a.score);
    for (const b of ranking) if (a.score > b.score) addNum(Math.round((a.score - b.score) * 100) / 100);
  }
  addNum(THRESHOLDS.tieMargin);
  if (t && held.length >= 2 && held.includes(t.idea) && keepWith(tieOk)(t.why)) tieBreak = { idea: t.idea, why: showIdeaNumbers(t.why.trim()) };
  // Reads only for notes the data left open, one per check, numbers limited like the rest of this section.
  const allowedChecks = new Set(cannotCheck);
  const notes: NonNullable<PracticalCheck["notes"]> = [];
  for (const n of draft.notes ?? []) {
    // A read may quote the numbers in the maker's own note ("over 55"), but no other figure.
    const own = new Set(ok);
    for (const m of checkTexts[n.check]?.match(/\d+(?:[.,]\d+)?/g) ?? []) own.add(m.replace(",", ""));
    if (!allowedChecks.has(n.check) || notes.some((x) => x.check === n.check) || !keepWith(own)(n.why)) continue;
    notes.push({ check: n.check, read: n.read, why: showIdeaNumbers(n.why.trim()) });
  }
  return { ideas, tieBreak, ...(notes.length ? { notes } : {}), removed: dropped.length, dropped };
}
