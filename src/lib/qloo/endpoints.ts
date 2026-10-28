/**
 * Typed wrappers around the Qloo endpoints Pretaste uses.
 * Parameter names follow docs.qloo.com; each one is to be confirmed with a live key
 * ("capability table", planned for the day the key arrives).
 */
import type { CallRecord } from "../claims";
import type { AgeBand, ComparableKind } from "../types";
import { AGE_BANDS } from "../types";
import { qlooGet } from "./client";
import { stateOf } from "./geo";
import type {
  QlooCompareResponse,
  QlooEntity,
  QlooEntityType,
  QlooInsightsResponse,
  QlooSearchResponse,
  QlooTrendingResponse,
} from "./types";

export const KIND_TO_URN: Record<ComparableKind, QlooEntityType> = {
  book: "urn:entity:book",
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  brand: "urn:entity:brand",
  videogame: "urn:entity:videogame",
  artist: "urn:entity:artist",
  podcast: "urn:entity:podcast",
  destination: "urn:entity:destination",
};

export async function searchEntity(
  query: string,
  kind: ComparableKind,
  step: number,
): Promise<{ entity: QlooEntity | null; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooSearchResponse>(
    "/search",
    { query, types: KIND_TO_URN[kind], take: "5" },
    { step, expect: ["results"] },
  );
  // `types` and `take` on /search are not in the public parameter guide (checked 2026-10-22,
  // docs/qloo-params.md), so do not trust the server to have filtered: take the first result
  // that carries the requested type, and drop the name if none does.
  const named = data.results?.filter((e) => e.entity_id && e.name) ?? [];
  const typed = named.filter((e) => e.types ? e.types.includes(KIND_TO_URN[kind]) : !e.type || e.type === KIND_TO_URN[kind]);
  if (typed.length === 0 && named.length > 0) {
    record.warnings.push(`type mismatch for "${query}": got ${named.map((e) => (e.types ?? []).join("/")).join(", ")}`);
  }
  // Prefer the result whose name is the query; the first hit can be a different title that shares words.
  const q = nameKey(query);
  const exact = typed.filter((e) => nameKey(e.name!) === q);
  const aliases = typed.filter((e) => sameEntityName(e.name!, query, kind));
  // A prefix is not an identity: a sequel, another volume or an unrelated first hit must not
  // silently become the audience for this idea. Only normalization and explicit aliases qualify.
  const candidates = exact.length ? exact : aliases;
  const unique = [...new Map(candidates.map((e) => [e.entity_id, e])).values()];
  const match = unique.length === 1 ? unique[0] : null;
  if (match && nameKey(match.name!) !== q) {
    record.warnings.push(`verified name variant for "${query}": "${match.name}" (${match.entity_id}); punctuation/article or curated alias`);
  } else if (!match && typed.length) {
    record.warnings.push(`ambiguous or different title for "${query}": no unique verified name match; candidates: ${typed.map((e) => e.name).join(", ")}`);
  }
  return { entity: match, record };
}

export async function demographics(
  entityIds: string[],
  step: number,
): Promise<{ age: Partial<Record<AgeBand, number>>; gender: { female?: number; male?: number }; record: CallRecord } | null> {
  const { data, record } = await qlooGet<QlooInsightsResponse>(
    "/v2/insights",
    { "filter.type": "urn:demographics", "signal.interests.entities": entityIds.join(",") },
    { step, expect: ["results.demographics"] },
  );
  const rows = data.results?.demographics ?? [];
  if (rows.length === 0) return null;
  const age: Partial<Record<AgeBand, number>> = {};
  for (const band of AGE_BANDS) {
    const vals = rows.map((r) => r.query?.age?.[band]).filter(isFiniteNumber);
    if (vals.length) age[band] = round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  const avg = (k: string) => {
    const vals = rows.map((r) => r.query?.gender?.[k]).filter(isFiniteNumber);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : undefined;
  };
  return { age, gender: { female: avg("female"), male: avg("male") }, record };
}

export async function neighbors(
  entityIds: string[],
  filterType: QlooEntityType,
  step: number,
): Promise<{ entities: QlooEntity[]; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooInsightsResponse>(
    "/v2/insights",
    {
      "filter.type": filterType,
      "signal.interests.entities": entityIds.join(","),
      "feature.explainability": "true",
      take: "10",
      // Keep results away from pure mass-market items. [threshold to tune with live data]
      "filter.popularity.max": "0.98",
    },
    { step, expect: ["results.entities"] },
  );
  return { entities: data.results?.entities ?? [], record };
}

export async function compareGroups(
  a: string[],
  b: string[],
  step: number,
): Promise<{ overlap: number | null; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooCompareResponse>(
    "/v2/analysis/compare",
    { "a.signal.interests.entities": a.join(","), "b.signal.interests.entities": b.join(",") },
    { step, expect: ["results"] },
  );
  // Mock mode returns results.overlap. Live mode returns shared tags (results.tags) and tags only on
  // one side (results.a / results.b), so overlap = shared / (shared + a-only + b-only) over tags.
  const given = data.results?.overlap;
  let overlap: number | null = isFiniteNumber(given) && given >= 0 && given <= 1 ? given : null;
  if (given !== undefined && given !== null && overlap === null) {
    record.warnings.push(`compare: overlap ${String(given)} is not a share between 0 and 1; ignored`);
  }
  if (overlap === null) {
    const shared = data.results?.tags?.length ?? 0;
    const total = shared + (data.results?.a?.length ?? 0) + (data.results?.b?.length ?? 0);
    if (total > 0) overlap = round(shared / total);
    else record.warnings.push("compare: no tags returned on either side; overlap not derivable");
  }
  return { overlap, record };
}

/** Trending window: the 90 days up to yesterday (the live API requires both dates). */
function trendingWindow(): { start: string; end: string } {
  const day = 86_400_000;
  const end = new Date(Date.now() - day);
  const start = new Date(end.getTime() - 90 * day);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** One entity per call (the live API refuses lists). Caller skips types not in TRENDING_TYPES. */
export async function trending(
  entityId: string,
  filterType: QlooEntityType,
  step: number,
): Promise<{ entities: QlooEntity[]; record: CallRecord }> {
  const w = trendingWindow();
  const { data, record } = await qlooGet<QlooTrendingResponse>(
    "/v2/trending",
    {
      "filter.type": filterType,
      "signal.interests.entities": entityId,
      "filter.start_date": w.start,
      "filter.end_date": w.end,
    },
    { step, expect: ["results"] },
  );
  return { entities: data.results?.trending ?? data.results?.entities ?? [], record };
}

export async function heatmap(
  entityIds: string[],
  step: number,
): Promise<{ regions: { region: string; score: number }[]; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooInsightsResponse>(
    "/v2/insights",
    {
      "filter.type": "urn:heatmap",
      "signal.interests.entities": entityIds.join(","),
      "filter.location.query": "United States",
    },
    { step, expect: ["results.heatmap"] },
  );
  // Mock cells carry a state label. Live cells carry lat/lon only (8,000-10,000 per US call, checked
  // 2026-10-21), and the best cells hit affinity 1.0 in almost every state. So each cell is mapped to
  // a state and a state scores the mean affinity of all its cells; states with fewer than 5 cells
  // (e.g. DC = 1 cell) are dropped as too thin. Mock labels are one cell each and pass as they are.
  const byState = new Map<string, number[]>();
  for (const r of data.results?.heatmap ?? []) {
    const lat = r.location?.latitude;
    const lon = r.location?.longitude;
    const name = r.location?.label ?? (typeof lat === "number" && typeof lon === "number" ? stateOf(lat, lon) : null);
    if (!name) continue;
    const aff = r.query?.affinity ?? 0;
    if (!isFiniteNumber(aff)) continue;
    const list = byState.get(name) ?? [];
    list.push(aff);
    byState.set(name, list);
  }
  if (byState.size === 0 && (data.results?.heatmap?.length ?? 0) > 0) {
    record.warnings.push("heatmap: cells had neither a label nor lat/lon; no regions derived");
  }
  const live = [...byState.values()].some((v) => v.length > 1);
  const regions = [...byState]
    .filter(([, scores]) => !live || scores.length >= 5)
    .map(([region, scores]) => ({ region, score: round(scores.reduce((x, y) => x + y, 0) / scores.length) }))
    .sort((x, y) => y.score - x.score)
    // The whole run state travels with every step request, so keep it small.
    .slice(0, 10);
  return { regions, record };
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Case, spacing and punctuation-insensitive key for comparing a search query with a result name. */
function nameKey(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").replace(/[’']/g, "")
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Editorial title aliases, not fuzzy guesses. Kept type-specific to avoid crossing adaptations. */
function canonicalName(name: string, kind: ComparableKind): string {
  const key = nameKey(name).replace(/^the /, "");
  const aliases: Partial<Record<ComparableKind, Record<string, string>>> = {
    book: { "travelling cat chronicles": "traveling cat chronicles" },
    movie: { "tonari no totoro": "my neighbor totoro", "majo no takkyubin": "kikis delivery service" },
    tv_show: { "shinya shokudo tokyo stories": "midnight diner tokyo stories" },
  };
  return aliases[kind]?.[key] ?? key;
}

/** Same deliberately limited identity rule for both initial lookup and rephrased lookup. */
export function sameEntityName(a: string, b: string, kind: ComparableKind): boolean {
  return canonicalName(a, kind) === canonicalName(b, kind);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
