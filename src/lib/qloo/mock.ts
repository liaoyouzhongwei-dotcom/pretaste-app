/**
 * SYNTHETIC data generator used when QLOO_MODE=mock (or no key).
 * Nothing here comes from Qloo. Values are derived deterministically from a hash of the
 * request so screens are stable. Ids start with "SYN-" so they can never be mistaken
 * for real Qloo ids (and the leak checker ignores them).
 */
import { createHash } from "node:crypto";
import type {
  QlooCompareResponse,
  QlooEntity,
  QlooInsightsResponse,
  QlooSearchResponse,
  QlooTrendingResponse,
} from "./types";

export const SYNTHETIC_LABEL = "SYNTHETIC — not Qloo data";

function h(s: string): number {
  return parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);
}
/** Deterministic number in [min, max). */
function rnd(seed: string, min: number, max: number): number {
  return min + ((h(seed) % 10_000) / 10_000) * (max - min);
}
function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
export function synId(seed: string): string {
  return `SYN-${createHash("sha256").update(seed).digest("hex").slice(0, 10).toUpperCase()}`;
}

const ADJ = ["Quiet", "Paper", "Lantern", "Willow", "Slow", "Tidy", "Velvet", "Maple", "Harbor", "Little", "Moss", "Cozy"];
const NOUN = ["Garden", "Studio", "Atlas", "Club", "Hours", "Kitchen", "Notes", "Path", "Market", "Society", "Field", "Room"];
const KIND_SUFFIX: Record<string, string> = {
  "urn:entity:brand": "Co.",
  "urn:entity:book": "(novel)",
  "urn:entity:movie": "(film)",
  "urn:entity:tv_show": "(series)",
  "urn:entity:podcast": "Podcast",
  "urn:entity:artist": "(band)",
  "urn:entity:videogame": "(game)",
  "urn:entity:destination": "(town)",
};
function fakeName(seed: string, type: string): string {
  return `[SYN] ${ADJ[h(seed + "a") % ADJ.length]} ${NOUN[h(seed + "n") % NOUN.length]} ${KIND_SUFFIX[type] ?? ""}`.trim();
}

const AGE_KEYS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
const STATES = ["California", "Texas", "New York", "Florida", "Washington", "Oregon", "Illinois", "Colorado", "Massachusetts", "Ohio", "Georgia", "Minnesota"];

function ids(params: Record<string, string>, key: string): string[] {
  return (params[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function search(params: Record<string, string>): QlooSearchResponse {
  const q = params.query ?? "";
  const type = params.types ?? "urn:entity:brand";
  // ~1 in 6 long names are "not found" until rephrased (shortened), to exercise the agent's retry.
  const miss = q.length > 18 && h("miss:" + q) % 6 === 0;
  if (miss || !q) return { results: [] };
  return {
    results: [
      {
        entity_id: synId(`${type}:${q.toLowerCase()}`),
        name: q,
        types: [type],
        popularity: round(rnd("pop:" + q, 0.4, 0.99)),
      },
    ],
  };
}

function insights(params: Record<string, string>): QlooInsightsResponse {
  const type = params["filter.type"] ?? "";
  const signal = ids(params, "signal.interests.entities");
  const seed = `${type}|${signal.join(",")}`;

  if (type === "urn:demographics") {
    return {
      success: true,
      results: {
        demographics: signal.map((id) => ({
          entity_id: id,
          query: {
            age: Object.fromEntries(AGE_KEYS.map((k) => [k, round(rnd(`age:${id}:${k}`, -0.45, 0.45))])),
            gender: (() => {
              const f = round(rnd(`g:${id}`, -0.4, 0.4));
              return { female: f, male: round(-f) };
            })(),
          },
        })),
      },
    };
  }

  if (type === "urn:tag") {
    const style = (params["filter.tag.types"] ?? "").includes("style");
    const pool = style
      ? STYLE_POOL
      : ["Food", "Village", "Everyday life", "Japanese", "Travel", "Family", "Cats", "Festival", "City", "School"];
    const subtype = style ? "urn:tag:style:qloo" : "urn:tag:keyword:media";
    const picks = [...pool].sort((a, b) => h(seed + a) - h(seed + b)).slice(0, 8);
    return {
      success: true,
      results: { tags: picks.map((name, i) => ({ tag_id: `${subtype}:${name.toLowerCase()}`, name, type: "urn:tag", subtype, query: { affinity: round(0.99 - i * 0.01) } })) },
    };
  }

  if (type === "urn:heatmap") {
    const picks = [...STATES].sort((a, b) => h(seed + a) - h(seed + b)).slice(0, 6);
    return {
      success: true,
      results: {
        heatmap: picks.map((label, i) => ({
          location: { label },
          query: { affinity: round(0.95 - i * 0.08 - rnd(seed + label, 0, 0.05)) },
        })),
      },
    };
  }

  const take = Math.min(Number(params.take ?? 10) || 10, 20);
  const entities: QlooEntity[] = Array.from({ length: take }, (_, i) => {
    const s = `${seed}#${i}`;
    const drivers = signal.filter((id) => h(s + id) % 2 === 0);
    return {
      entity_id: synId(s),
      name: fakeName(s, type),
      type,
      popularity: round(rnd("p" + s, 0.2, 0.95)),
      query: {
        affinity: round(0.98 - i * 0.035 - rnd("a" + s, 0, 0.02)),
        explainability: {
          "signal.interests.entities": (drivers.length ? drivers : signal.slice(0, 1)).map((id) => ({
            entity_id: id,
            score: round(rnd("x" + s + id, 0.2, 0.9)),
          })),
        },
      },
    };
  });
  return { success: true, results: { entities } };
}

function compare(params: Record<string, string>): QlooCompareResponse {
  const a = ids(params, "a.signal.interests.entities");
  const b = ids(params, "b.signal.interests.entities");
  return {
    success: true,
    results: { overlap: round(rnd(`cmp:${a.join(",")}|${b.join(",")}`, 0.12, 0.78)) },
  };
}

function trending(params: Record<string, string>): QlooTrendingResponse {
  const signal = ids(params, "signal.interests.entities");
  return {
    success: true,
    results: {
      entities: signal.map((id) => ({
        entity_id: id,
        query: {
          population_percentile: round(rnd("pp" + id, 0.3, 0.95)),
          velocity: round(rnd("v" + id, -0.25, 0.3)),
        },
      })),
    },
  };
}

/** Route a mock request by path. */
const STYLE_POOL = ["Whimsical", "Contemplative", "Heartwarming", "Nostalgic", "Cozy", "Minimalist", "Dreamy", "Dark", "Epic", "Retro"];

export function mockResponse(apiPath: string, params: Record<string, string>): unknown {
  switch (apiPath) {
    case "/search":
      return search(params);
    case "/v2/insights":
      return insights(params);
    case "/v2/analysis/compare":
      return compare(params);
    case "/v2/trending":
      return trending(params);
    case "/v2/tags": {
      // Synthetic style tag lookup: a guess is a tag only when it is in the mock style pool.
      const q = (params["filter.query"] ?? "").trim().toLowerCase();
      const hit = STYLE_POOL.find((x) => x.toLowerCase() === q);
      return { success: true, results: { tags: hit ? [{ tag_id: `urn:tag:style:qloo:${q}`, name: hit, type: "urn:tag:style:qloo" }] : [] } };
    }
    default:
      return { success: true, results: {} };
  }
}
