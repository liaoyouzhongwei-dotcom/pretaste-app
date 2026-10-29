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
import { QlooError } from "./types";
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
  // Qloo rejects queries over 100 characters. Bound only the transmitted search text;
  // the complete original query below remains the authority for title identity.
  const searchQuery = query.trim().slice(0, 100).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  if (!searchQuery) throw new QlooError("blocked", "Search query must not be blank");
  const { data, record } = await qlooGet<QlooSearchResponse>(
    "/search",
    { query: searchQuery, types: KIND_TO_URN[kind], take: "5" },
    { step, expect: ["results"] },
  );
  if (searchQuery !== query) record.warnings.push(`search query trimmed/limited to 100 UTF-16 code units; identity checked against the complete original title: "${query}"`);
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
  // Two narrower forms are also the same work: the first book of a series that carries its series
  // label ("Title (Series, #1)"), and a title plus a subtitle with no sequel marker ("Title: Subtitle").
  const seriesFirst = typed.filter((e) => { const t = firstOfSeries(e.name!); return t !== null && sameEntityName(t, query, kind); });
  const subtitled = typed.filter((e) => { const t = withSubtitle(e.name!); return t !== null && sameEntityName(t, query, kind); });
  const tier = exact.length ? "exact" : aliases.length ? "alias" : seriesFirst.length ? "series" : "subtitle";
  const candidates = exact.length ? exact : aliases.length ? aliases : seriesFirst.length ? seriesFirst : subtitled;
  const unique = [...new Map(candidates.map((e) => [e.entity_id, e])).values()];
  // Records that differ only in how the series label is written are one book listed twice; any
  // Other duplicates stay ambiguous unless one record is clearly the famous one (a remake or a
  // low-signal duplicate listing): its popularity must lead the next record by POPULARITY_LEAD.
  const byPop = [...unique].sort((x, y) => (y.popularity ?? 0) - (x.popularity ?? 0));
  const lead = unique.length > 1 ? (byPop[0].popularity ?? 0) - (byPop[1].popularity ?? 0) : 0;
  const popular = tier !== "series" && unique.length > 1 && lead >= POPULARITY_LEAD ? byPop[0] : null;
  const match = unique.length === 1 || (tier === "series" && unique.length > 1) ? unique[0] : popular;
  if (popular) {
    record.warnings.push(`picked the clearly most popular of ${unique.length} records named like "${query}": "${popular.name}" (${popular.entity_id}), popularity ${r2(popular.popularity ?? 0)} vs next ${r2(byPop[1].popularity ?? 0)}`);
  } else if (match && tier === "series") {
    record.warnings.push(`verified first book of a series for "${query}": "${match.name}" (${match.entity_id})${unique.length > 1 ? `; ${unique.length - 1} more record(s) with the same title and #1 label not used` : ""}`);
  } else if (match && tier === "subtitle") {
    record.warnings.push(`verified title with subtitle for "${query}": "${match.name}" (${match.entity_id}); the subtitle has no sequel marker`);
  } else if (match && nameKey(match.name!) !== q) {
    record.warnings.push(`verified name variant for "${query}": "${match.name}" (${match.entity_id}); punctuation/article or curated alias`);
  } else if (!match && typed.length) {
    record.warnings.push(`ambiguous or different title for "${query}": no unique verified name match; candidates: ${typed.map((e) => e.name).join(", ")}`);
  }
  return { entity: match, record };
}

export async function demographics(
  entityIds: string[],
  step: number,
): Promise<{ age: Partial<Record<AgeBand, number>>; gender: { female?: number; male?: number }; perEntity: { entityId: string; age: Partial<Record<AgeBand, number>>; gender: { female?: number; male?: number } }[]; record: CallRecord } | null> {
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
  const perEntity = rows.flatMap((r) => {
    if (typeof r.entity_id !== "string") return [];
    const a: Partial<Record<AgeBand, number>> = {};
    for (const band of AGE_BANDS) { const v = r.query?.age?.[band]; if (isFiniteNumber(v)) a[band] = round(v); }
    const f = r.query?.gender?.female, m = r.query?.gender?.male;
    return [{ entityId: r.entity_id, age: a, gender: { female: isFiniteNumber(f) ? round(f) : undefined, male: isFiniteNumber(m) ? round(m) : undefined } }];
  });
  return { age, gender: { female: avg("female"), male: avg("male") }, perEntity, record };
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

/**
 * Tag kinds asked for, as two calls: the look and mood ("style"), and what the work is about.
 * Place tags (payment cards, hotel stars) are left out. Checked live 2026-10-29: take above 50 is refused.
 */
export const TASTE_TAG_TYPES = {
  style: ["urn:tag:style:qloo"],
  topic: ["urn:tag:keyword:media", "urn:tag:genre:media", "urn:tag:theme:qloo", "urn:tag:subgenre:qloo"],
} as const;

/** The tags Qloo most ties to fans of these entities, strongest first. */
export const TAG_PAGE = 50;
export async function tasteTags(
  entityIds: string[],
  set: keyof typeof TASTE_TAG_TYPES,
  step: number,
  page = 1,
): Promise<{ tags: { name: string; kind: string; affinity: number }[]; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooInsightsResponse>(
    "/v2/insights",
    {
      "filter.type": "urn:tag",
      "filter.tag.types": TASTE_TAG_TYPES[set].join(","),
      "signal.interests.entities": entityIds.join(","),
      take: String(TAG_PAGE),
      ...(page > 1 ? { page: String(page) } : {}),
    },
    { step, expect: ["results.tags"] },
  );
  const tags = (data.results?.tags ?? [])
    .filter((t) => t.name?.trim())
    .map((t) => ({ name: t.name!.trim(), kind: (t.subtype ?? t.type ?? "").split(":")[2] ?? "", affinity: round(t.query?.affinity ?? 0) }));
  return { tags, record };
}

/** The Qloo style tag named exactly like the guess (case, spacing and hyphens ignored), if Qloo has one. */
export async function styleTagNamed(guess: string, step: number): Promise<{ name: string | null; record: CallRecord }> {
  const { data, record } = await qlooGet<QlooInsightsResponse>(
    "/v2/tags",
    { "filter.query": guess, "filter.tag.types": TASTE_TAG_TYPES.style.join(","), take: "5" },
    { step, expect: ["results.tags"] },
  );
  const hit = (data.results?.tags ?? []).find((t) => t.name && sameTagName(t.name, guess));
  return { name: hit?.name?.trim() ?? null, record };
}

export function sameTagName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Case, spacing and punctuation-insensitive key for comparing a search query with a result name. */
function nameKey(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").replace(/[’']/g, "")
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** "Title (Series, #1)" -> "Title". Other volumes (#2, #1-4, #1.5) are not the same work. */
/** How far the most popular same-named record must lead the next one to be taken as the work meant. */
export const POPULARITY_LEAD = 0.2;
const r2 = (n: number) => Math.round(n * 100) / 100;

function firstOfSeries(name: string): string | null {
  const m = name.match(/^(.+?)\s*\(([^()]*?),?\s*#\s*1\)\s*$/);
  return m ? m[1] : null;
}

const SEQUEL_MARK = /\b(part|vol|volume|season|arc|chapter|book|movie|film|episode|returns|ii|iii|iv|vi|\d+)\b/i;

/** "Title: Subtitle" -> "Title", unless the subtitle reads like a sequel, a season or a spin-off film. */
function withSubtitle(name: string): string | null {
  const i = name.indexOf(":");
  if (i <= 0) return null;
  const subtitle = name.slice(i + 1).trim();
  return subtitle && !SEQUEL_MARK.test(subtitle) ? name.slice(0, i) : null;
}

/** Editorial title aliases, not fuzzy guesses. Kept type-specific to avoid crossing adaptations. */
function canonicalName(name: string, kind: ComparableKind): string {
  const key = nameKey(name).replace(/^the /, "");
  const aliases: Partial<Record<ComparableKind, Record<string, string>>> = {
    book: { "travelling cat chronicles": "traveling cat chronicles" },
    movie: { "tonari no totoro": "my neighbor totoro", "majo no takkyubin": "kikis delivery service" },
    tv_show: { "shinya shokudo tokyo stories": "midnight diner tokyo stories", "shirokuma cafe": "polar bears cafe" },
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
