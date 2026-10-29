/**
 * Minimal typed view of the Qloo responses Pretaste reads.
 * Shapes follow docs.qloo.com as read before the hackathon key arrived; every field is optional
 * because the API silently ignores bad parameters and may omit blocks. Parsers check the fields
 * they need and record a warning when one is missing. [Field names to be re-verified with a live key.]
 */

export type QlooEntityType =
  | "urn:entity:artist"
  | "urn:entity:book"
  | "urn:entity:brand"
  | "urn:entity:destination"
  | "urn:entity:movie"
  | "urn:entity:place"
  | "urn:entity:podcast"
  | "urn:entity:tv_show"
  | "urn:entity:videogame";

export interface QlooEntity {
  entity_id?: string;
  name?: string;
  type?: string;
  types?: string[];
  subtype?: string;
  popularity?: number;
  query?: {
    affinity?: number;
    population_percentile?: number;
    velocity?: number;
    explainability?: Record<string, { entity_id?: string; score?: number }[] | undefined>;
  };
}

export interface QlooSearchResponse {
  results?: QlooEntity[];
}

export interface QlooInsightsResponse {
  success?: boolean;
  results?: {
    entities?: QlooEntity[];
    demographics?: {
      entity_id?: string;
      query?: {
        age?: Record<string, number>;
        gender?: Record<string, number>;
      };
    }[];
    heatmap?: {
      location?: { latitude?: number; longitude?: number; geohash?: string; label?: string };
      query?: { affinity?: number; popularity?: number };
    }[];
    tags?: { tag_id?: string; name?: string; type?: string; subtype?: string; query?: { affinity?: number } }[];
  };
}

/**
 * /v2/analysis/compare, checked with the live hackathon key on 2026-10-21:
 * results.tags = tags both sides share (query.score), results.a / results.b = tags only on that side,
 * results.matchEntities = entities on both sides. There is no single overlap number.
 * `overlap` exists only in mock mode.
 */
export interface QlooCompareResponse {
  success?: boolean;
  results?: {
    tags?: { tag_id?: string; name?: string; query?: { score?: number } }[];
    a?: { tag_id?: string; name?: string }[];
    b?: { tag_id?: string; name?: string }[];
    matchEntities?: QlooEntity[];
    overlap?: number;
  };
}

/**
 * /v2/trending, checked live on 2026-10-21: needs filter.start_date and filter.end_date, takes ONE
 * entity per call, and filter.type must be one of TRENDING_TYPES. Live rows come in results.trending;
 * mock rows come in results.entities. With the hackathon key every probe so far returned [].
 */
export interface QlooTrendingResponse {
  success?: boolean;
  results?: { entities?: QlooEntity[]; trending?: QlooEntity[] };
}

export const TRENDING_TYPES: QlooEntityType[] = [
  "urn:entity:artist",
  "urn:entity:brand",
  "urn:entity:movie",
  "urn:entity:podcast",
  "urn:entity:tv_show",
];

export type QlooErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "request_rejected"
  | "server"
  | "network"
  | "blocked"
  | "bad_response";

export class QlooError extends Error {
  constructor(
    public kind: QlooErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

/** Human-readable message for the error banner. */
export function describeQlooError(e: QlooError): string {
  switch (e.kind) {
    case "unauthorized":
      return "Qloo rejected the API key (401). Check QLOO_API_KEY and that the hackathon host is used.";
    case "forbidden":
      return "Qloo refused this endpoint for the current key (403).";
    case "not_found":
      return "Qloo endpoint not found (404).";
    case "rate_limited":
      return "Qloo rate limit reached (429). Try a prepared scenario, or wait a minute.";
    case "request_rejected":
      return `Qloo rejected this request${e.status === undefined ? "" : ` (HTTP ${e.status})`}. This check could not be completed.`;
    case "server":
      return `Qloo returned a server error${e.status === undefined ? "" : ` (HTTP ${e.status})`}. This check could not be completed.`;
    case "network":
      return "Could not reach Qloo (network/timeout).";
    case "blocked":
      return "Request blocked by Pretaste's own guard (host/method/path/input).";
    case "bad_response":
      return `Qloo returned an unexpected response${e.status === undefined ? "" : ` (HTTP ${e.status})`}. This check could not be completed.`;
  }
}
