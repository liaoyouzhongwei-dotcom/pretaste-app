import type { CallRecord, Claim } from "./claims";

export type Marketplace = "etsy" | "kdp" | "other";

export interface ProductInput {
  /** 1-3 product ideas (free text). No personal data. */
  ideas: string[];
  marketplace: Marketplace;
  priceUsd?: number;
  /** Optional: the maker's own assumptions; if empty the agent writes them. */
  ownAssumptions?: string;
}

export const ASSUMPTION_FIELDS = [
  "age",
  "gender",
  "lifeStage",
  "aesthetic",
  "likes",
  "trendDirection",
  "region",
] as const;
export type AssumptionField = (typeof ASSUMPTION_FIELDS)[number];

export const ASSUMPTION_LABELS: Record<AssumptionField, string> = {
  age: "Age",
  gender: "Gender",
  lifeStage: "Life stage",
  aesthetic: "Aesthetic",
  likes: "Also likes",
  trendDirection: "Trend",
  region: "Region (US)",
};

/** Age buckets used for both the assumption and the demographic signal. */
export const AGE_BANDS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** Note on every field of a sheet built without the live model: there is no guess to check. */
export const NO_GUESS_NOTE = "No guess: the live model was unavailable.";

export interface AssumptionSheet {
  age: { bands: AgeBand[]; note: string };
  gender: { lean: "female" | "male" | "neutral"; note: string };
  lifeStage: { value: string };
  aesthetic: { tags: string[]; note: string };
  likes: { note: string };
  trendDirection: { value: "rising" | "flat" | "falling" };
  region: { states: string[]; note: string };
}

export interface ListingDraft {
  title: string;
  /** Etsy: 13 tags. KDP: 7 keywords. */
  tags: string[];
  description: string;
  coverDirection: string;
}

/** One atomic assertion quoted from the maker's own notes, not an agent guess. */
export interface MakerAssumption {
  text: string;
  /** null means all ideas; otherwise a zero-based input idea. */
  idea: number | null;
  field: "age" | "gender" | "region" | "likes" | "trendDirection" | "other";
  values: string[];
}

export interface MakerAssumptionCheck extends MakerAssumption {
  status: "matches" | "contradicts" | "cannot check";
  reason: string;
  /** Only observed values; never a guessed correction. */
  signals: { callId: string; field: string; value: number | string }[];
}

export interface IdeaDraft {
  idea: number;
  assumptions: AssumptionSheet;
  blindListing: ListingDraft;
}

export type ComparableKind = "book" | "movie" | "tv_show" | "brand" | "videogame" | "artist" | "podcast" | "destination";

export interface Comparable {
  name: string;
  kind: ComparableKind;
  /** Which idea index (0-based) this comparable represents. */
  idea: number;
}

export interface ResolvedComparable extends Comparable {
  entityId: string | null;
  resolvedName: string | null;
  /** true when found only after one rephrase by the agent. */
  rephrased: boolean;
  callId: string | null;
  /**
   * What happened to this planned comparable. "failed" = Qloo stopped on it (e.g. 429),
   * "unprocessed" = never asked because Qloo stopped earlier. Missing on older runs = checked.
   */
  status?: ComparableStatus;
  /** true when the agent added it because too few of the idea's first comparables were found. */
  replacement?: boolean;
}

export type ComparableStatus = "found" | "not_found" | "failed" | "unprocessed";

export interface DemographicSkew {
  /** Relative affinity by age band, -1..1 (0 = average). */
  age: Partial<Record<AgeBand, number>>;
  gender: { female?: number; male?: number };
  callId: string;
  /** The same call's per-comparable rows, used to test whether a verdict depends on one comparable. */
  perEntity?: { entityId: string; age: Partial<Record<AgeBand, number>>; gender: { female?: number; male?: number } }[];
}

export interface NeighborEntity {
  entityId: string;
  name: string;
  kind: string;
  affinity: number;
  /** Which input comparables drove this result (from explainability). */
  drivenBy: string[];
  callId: string;
}

/** A guessed "also likes" item whose words name a top neighbour, and what Qloo search returns
 *  for the item as written (same type as the neighbour). Only an equal entity id counts as a match. */
export interface LikeEntity {
  item: string;
  neighborEntityId: string;
  entityId: string | null;
  callId: string | null;
}

export interface CompareResult {
  ideaA: number;
  ideaB: number;
  /** 0..1 taste-tag similarity of the two ideas (shared tags / all tags). Not a share of buyers. */
  overlap: number;
  callId: string;
}

export interface TrendPoint {
  entityId: string;
  name: string;
  /** Week-over-week change in population percentile (sign = direction). */
  velocity: number;
  callId: string;
}

export interface TasteTag {
  name: string;
  /** Qloo tag kind, e.g. "style", "theme", "keyword". */
  kind: string;
  affinity: number;
  callId: string;
}

export interface TasteTags {
  /** Style (look and mood) tags first, then topic tags; each set strongest first. */
  tags: TasteTag[];
}

/** One guessed look, looked up as a Qloo style tag and ranked among every style tag Qloo ties to these fans. */
export interface AestheticCheck {
  guess: string;
  /** Qloo style tag with the same name (from /v2/tags); absent when Qloo has none. */
  tag?: string;
  searchCallId?: string;
  /** Place in the full ranked list, 1 = strongest; absent when the tag is not in it. */
  rank?: number;
  affinity?: number;
  callId?: string;
}

export interface StyleRanking {
  /** Style tags Qloo ties to fans of the comparables, counted over every page. */
  total: number;
  /** True when the last page was reached, so a tag missing from the list is missing for these fans. */
  complete: boolean;
  /** Call that returned the last page (receipt for the total). */
  lastCallId?: string;
  checks: AestheticCheck[];
}

export interface HeatRegion {
  region: string;
  score: number;
  callId: string;
}

export type Verdict = "supported" | "refuted" | "unverifiable";

export interface AssumptionVerdict {
  field: AssumptionField;
  assumed: string;
  verdict: Verdict;
  reason: string;
  claims: Claim[];
  /** Leave-one-out check over the comparables (age and gender only): did the verdict hold with each one left out? */
  stability?: { held: boolean; comparables: number; dependsOn?: string };
}

export interface IdeaScore {
  idea: number;
  score: number;
  formula: string;
  parts: Record<string, number>;
  /** Parts with no signal: they add 0 points instead of a neutral guess. */
  missing: string[];
  dontMake: boolean;
  /** Why "don't make (yet)", in plain words. null when the idea is not flagged. */
  dontMakeReason: string | null;
  /** true when Qloo stopped before all of this idea's comparables were checked: no verdict yet. */
  onHold?: boolean;
  /** true when Qloo gave this idea no taste signal to score (no comparables found, or no affinity): held and listed after the scored ideas. */
  unranked?: boolean;
  /** On the first idea only: how many nearby weightings (each weight moved by 0.1) keep it first. */
  robust?: { held: number; of: number };
  /** The call for this idea: make it, make it after fixing a wrong guess, skip it, or hold (not enough to decide). */
  call?: "make" | "fix" | "skip" | "hold";
  /** Why, in plain words. */
  callReason?: string;
}

/** The audience Qloo returned for one idea's own comparables. */
export interface IdeaNeighbors {
  idea: number;
  neighbors: NeighborEntity[];
  /** How many rows Qloo returned before rows without an affinity score were dropped. */
  returned?: number;
}

/**
 * Step 10: what the taste data cannot see (competition, season, effort, licensing, price fit).
 * General knowledge from the writer model, never checked against data; shown with that label.
 */
export interface PracticalCheck {
  ideas: { idea: number; risks: string[]; priceFit: string }[];
  /** Only when no idea is make or fix (a tie, or ideas the data could not rank): where to start, for a practical reason. */
  tieBreak: { idea: number; why: string } | null;
  /** General-knowledge read of a maker note the data could not settle (check = index in makerAssumptionChecks). */
  notes?: { check: number; read: "likely right" | "likely wrong" | "unsure"; why: string }[];
  /** Sentences removed because they stated figures the data does not hold. */
  removed: number;
  /** The removed sentences themselves, kept for review (not shown as advice). */
  dropped?: string[];
}

/** Default until the server selects the highest-ranked recommendable idea. */
export const FOCUS_IDEA = 0;

export interface AgentDecision {
  step: number;
  kind: "rephrase" | "replace" | "extra_compare" | "extra_query" | "skip";
  detail: string;
}

export type Source = "llm" | "fixture" | "qloo" | "mock" | "rules";

export interface RunProvenance {
  commit: string;
  qlooMode: "live" | "mock";
  models: { planner: string; writer: string };
  /** ISO time of step 0. */
  startedAt: string;
}

export interface RunState {
  runId: string;
  scenarioId: string | null;
  input: ProductInput;
  /** ms epoch when step 0 ran; signed with the state, so old states expire. */
  issuedAt: number;
  /** Last step that ran (-1 before step 0). Steps must run in order. */
  lastStep: number;
  /** Server-selected and covered by the state signature. Never accepted as start input. */
  focusIdea: number;
  /** Set by the server at step 0 and signed with the state: what produced this run. */
  provenance?: RunProvenance;
  /** step 0 */
  assumptions?: AssumptionSheet;
  blindListing?: ListingDraft;
  ideaDrafts?: IdeaDraft[];
  makerAssumptions?: MakerAssumption[];
  makerAssumptionChecks?: MakerAssumptionCheck[];
  /** step 1 */
  comparables?: Comparable[];
  candidateTags?: string[];
  /** step 2 */
  resolved?: ResolvedComparable[];
  /** Found ÷ planned comparables (not ÷ the ones Qloo answered before it stopped). */
  foundRatio?: number;
  /** true when step 2 stopped before every planned comparable was checked. */
  coverageIncomplete?: boolean;
  /** Queued in step 3, queried in step 7 for the selected focus idea. */
  demographics?: DemographicSkew | null;
  /** Step 7: age and gender of another idea's comparables, fetched only when the maker's own notes make an age or
   *  gender claim about that idea. */
  makerDemographics?: { idea: number; skew: DemographicSkew }[];
  /** Selected from step 4's per-idea neighbours in step 7. */
  neighbors?: NeighborEntity[];
  /** step 4: every idea's own neighbours (for the ranking) */
  ideaNeighbors?: IdeaNeighbors[];
  /** step 5 */
  compare?: CompareResult[];
  /** step 6 */
  trends?: TrendPoint[];
  /** step 7 (focus idea's comparables) */
  heatmap?: HeatRegion[];
  /** step 7: taste tags Qloo ties to the fans of the focus idea's comparables, strongest first. */
  tasteTags?: TasteTags | null;
  /** step 7: the guessed looks ranked among every style tag of these fans. */
  styleRanking?: StyleRanking | null;
  /** step 7: identity check of the guessed likes that name a top neighbour (A3). */
  likeEntities?: LikeEntity[];
  /** step 8 */
  verdicts?: AssumptionVerdict[];
  /** Computed in step 7 to select the focus; reported again in step 9. */
  ranking?: IdeaScore[];
  /** step 10 */
  groundedListing?: ListingDraft;
  groundedClaims?: Claim[];
  checker?: { downgraded: number; dropped: number; listingFixes: number; notes: string[] };
  /** What the name guard removed from each idea's before listing (step 2), by idea. */
  beforeListingNotes?: Record<number, string[]>;
  /** step 10, live model only */
  practical?: PracticalCheck;

  calls: CallRecord[];
  decisions: AgentDecision[];
  /** Where each step's output came from (for the SYNTHETIC / offline badges). */
  sources: Record<number, Source>;
  errors: { step: number; message: string }[];
}
