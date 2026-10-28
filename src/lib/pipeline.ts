/**
 * The Pretaste pipeline, steps 0-10. Each step takes the RunState and returns an updated copy.
 * The browser calls the steps one by one (POST /api/pipeline/[step]) so progress can be shown
 * and no single request runs long. Server-only.
 *
 *  0 blind guesses (LLM)          6 trend velocity (Qloo)
 *  1 comparables to check (LLM)   7 select focus; demographics + regional heat (Qloo)
 *  2 resolve to entities (Qloo)   8 verdicts (rules)
 *  3 queue demographic check      9 ranking (rules)
 *  4 taste neighbours (Qloo)     10 grounded listing + receipts (LLM + checker)
 *  5 audience overlap (Qloo)
 */
import { checkMakerAssumptions, makerLikeCandidates } from "./maker-assumptions";
import { checkListingNames, listingNames } from "./listing-names";
import { randomBytes } from "node:crypto";
import { checkClaims, checkListing, type CallRecord } from "./claims";
import { MODELS, qlooMode } from "./config";
import { buildCommit } from "./build-info";
import { checkPractical } from "./practical";
import { buildEvidence, step0Blind, step10Grounded, step1Comparables, rephraseQuery, type LlmResult } from "./llm/tasks";
import { compareGroups, demographics, heatmap, isFiniteNumber, KIND_TO_URN, neighbors, sameEntityName, searchEntity, trending } from "./qloo/endpoints";
import { describeQlooError, QlooError, TRENDING_TYPES, type QlooEntityType } from "./qloo/types";
import { computeVerdicts, likeCandidates, rankIdeas } from "./rules";
import { FOCUS_IDEA, type ComparableKind, type NeighborEntity, type ProductInput, type ResolvedComparable, type RunState, type Source } from "./types";

export const LAST_STEP = 10;

export const STEP_LABELS: Record<number, string> = {
  0: "Blind guess",
  1: "Pick comparables",
  2: "Find them in Qloo",
  3: "Queue audience check",
  4: "Taste neighbours",
  5: "Audience overlap",
  6: "Trend velocity",
  7: "Select idea and check audience",
  8: "Verdicts",
  9: "Rank ideas",
  10: "Grounded listing",
};

export function newRun(input: ProductInput, scenarioId: string | null): RunState {
  const issuedAt = Date.now();
  return {
    runId: randomBytes(6).toString("hex"),
    scenarioId,
    input,
    issuedAt,
    lastStep: -1,
    focusIdea: FOCUS_IDEA,
    provenance: {
      commit: buildCommit(),
      qlooMode: qlooMode(),
      models: { planner: MODELS.planner, writer: MODELS.writer },
      startedAt: new Date(issuedAt).toISOString(),
    },
    calls: [],
    decisions: [],
    sources: {},
    errors: [],
  };
}

function qlooSource(): Source {
  return qlooMode() === "mock" ? "mock" : "qloo";
}

function neighbourType(input: ProductInput): QlooEntityType {
  return input.marketplace === "kdp" ? "urn:entity:book" : "urn:entity:brand";
}

/** Found entity ids for one idea. Steps 3, 4 (state.neighbors), 6 and 7 describe the focus idea's audience. */
function foundIds(state: RunState, idea: number = state.focusIdea): string[] {
  return (state.resolved ?? []).filter((r) => r.idea === idea).map((r) => r.entityId).filter((x): x is string => !!x);
}

function applyLlm<T>(state: RunState, step: number, r: LlmResult<T>): T {
  state.sources[step] = r.source;
  if (r.note) state.errors.push({ step, message: r.note });
  return r.value;
}

/** Throws a plain Error when prerequisites are missing (client bug or tampering). */
function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function runQloo(state: RunState, step: number, fn: () => Promise<void>): Promise<void> {
  state.sources[step] = qlooSource();
  try {
    await fn();
  } catch (e) {
    if (e instanceof QlooError) {
      state.errors.push({ step, message: describeQlooError(e) });
      // Failed requests need a receipt too. The precise params are unavailable at this boundary;
      // do not pretend the request succeeded or invent values for the failed call.
      state.calls.push({
        callId: `c${step}-failed-${randomBytes(3).toString("hex")}`,
        step,
        path: `pipeline step ${step} (failed request)`,
        params: {}, status: "error", source: qlooSource() === "mock" ? "mock" : "qloo", cached: false,
        durationMs: 0, warnings: [describeQlooError(e), "Failure recorded at the pipeline boundary; request parameters and duration were not captured."],
      });
    }
    else throw e;
  }
}

export async function runStep(step: number, prev: RunState): Promise<RunState> {
  const state = await runOne(step, structuredClone(prev));
  state.lastStep = step;
  return state;
}

async function runOne(step: number, state: RunState): Promise<RunState> {
  const calls = (rec: CallRecord) => state.calls.push(rec);

  switch (step) {
    case 0: {
      const v = applyLlm(state, 0, await step0Blind(state));
      state.ideaDrafts = v.drafts;
      state.assumptions = v.drafts[0].assumptions;
      state.blindListing = v.drafts[0].blindListing;
      state.makerAssumptions = v.makerAssumptions;
      return state;
    }
    case 1: {
      need(state.assumptions, "step 0 first");
      const v = applyLlm(state, 1, await step1Comparables(state));
      state.comparables = v.comparables;
      state.candidateTags = v.candidateTags;
      return state;
    }
    case 2: {
      need(state.comparables, "step 1 first");
      const resolved: ResolvedComparable[] = [];
      await runQloo(state, 2, async () => {
        for (const c of state.comparables!) {
          let { entity, record } = await searchEntity(c.name, c.kind, 2);
          calls(record);
          let rephrased = false;
          if (!entity) {
            // Agent decision: rephrase once, never more.
            const r = await rephraseQuery(c.name, c.kind);
            if (r.value && r.value !== c.name) {
              state.decisions.push({ step: 2, kind: "rephrase", detail: `"${c.name}" not found -> retried as "${r.value}" (${r.source})` });
              ({ entity, record } = await searchEntity(r.value, c.kind, 2));
              if (entity && !sameEntityName(c.name, entity.name!, c.kind)) {
                record.warnings.push(`unverified rephrase identity: original "${c.name}" does not match "${entity.name}"; candidate not used`);
                state.decisions.push({ step: 2, kind: "skip", detail: `Rephrase found "${entity.name}", but its identity as "${c.name}" is unverified; no audience borrowed.` });
                entity = null;
              }
              calls(record);
              rephrased = true;
            }
          }
          resolved.push({
            ...c,
            entityId: entity?.entity_id ?? null,
            resolvedName: entity?.name ?? null,
            rephrased,
            callId: entity ? record.callId : null,
            status: entity ? "found" : "not_found",
          });
        }
      });
      // If Qloo stopped partway (429, network...), keep every planned comparable in the list:
      // the one it stopped on is "failed", the rest "unprocessed". Coverage keeps the planned
      // count as its denominator, so 1 found out of 3 planned never reads as 100%.
      const planned = state.comparables;
      const stoppedAt = resolved.length;
      for (let i = stoppedAt; i < planned.length; i++) {
        resolved.push({ ...planned[i], entityId: null, resolvedName: null, rephrased: false, callId: null,
          status: i === stoppedAt ? "failed" : "unprocessed" });
      }
      state.resolved = resolved;
      state.coverageIncomplete = stoppedAt < planned.length;
      state.foundRatio = planned.length ? resolved.filter((r) => r.entityId).length / planned.length : 0;
      const names = listingNames(state);
      const beforeNotes: Record<number, string[]> = {};
      state.ideaDrafts = state.ideaDrafts?.map((draft) => {
        const checked = checkListingNames(draft.blindListing, names, state.input.ideas[draft.idea]);
        beforeNotes[draft.idea] = checked.notes.map((n) => n.replace(/^listing:/, "before listing:"));
        return { ...draft, blindListing: checked.listing };
      });
      state.beforeListingNotes = beforeNotes;
      state.blindListing = state.ideaDrafts?.find((draft) => draft.idea === state.focusIdea)?.blindListing;
      return state;
    }
    case 3: {
      // Ranking needs steps 4-6. Query demographics once, after selecting the focus in step 7.
      state.demographics = null;
      return state;
    }
    case 4: {
      // Neighbours per idea (each idea is ranked on its own), shown for the focus idea.
      const nameById = new Map((state.resolved ?? []).map((r) => [r.entityId, r.resolvedName ?? r.name]));
      state.ideaNeighbors = [];
      state.neighbors = [];
      await runQloo(state, 4, async () => {
        for (let idea = 0; idea < state.input.ideas.length; idea++) {
          const ids = foundIds(state, idea);
          if (ids.length === 0) continue;
          const { entities, record } = await neighbors(ids, neighbourType(state.input), 4);
          calls(record);
          // A row without a positive affinity carries no taste signal (Qloo sometimes returns
          // unrelated popular titles with affinity 0); it is not evidence, so it is not kept.
          const usable = entities.filter((e) => {
            const aff = e.query?.affinity ?? 0;
            return e.entity_id && e.name && isFiniteNumber(aff) && aff > 0;
          });
          if (usable.length < entities.length) {
            state.decisions.push({
              step: 4,
              kind: "skip",
              detail: `idea ${idea + 1}: ignored ${entities.length - usable.length} of ${entities.length} neighbour(s) with no affinity score (${record.callId})`,
            });
          }
          const list: NeighborEntity[] = usable
            .map((e) => ({
              entityId: e.entity_id!,
              name: e.name!,
              kind: e.type ?? e.types?.[0] ?? "",
              affinity: e.query?.affinity ?? 0,
              drivenBy: (e.query?.explainability?.["signal.interests.entities"] ?? [])
                .map((x) => nameById.get(x.entity_id ?? "") ?? null)
                .filter((x): x is string => !!x),
              callId: record.callId,
            }));
          state.ideaNeighbors!.push({ idea, neighbors: list, returned: entities.length });
          if (idea === state.focusIdea) state.neighbors = list;
        }
      });
      return state;
    }
    case 5: {
      const groups = state.input.ideas
        .map((_, i) => ({ i, ids: (state.resolved ?? []).filter((r) => r.idea === i && r.entityId).map((r) => r.entityId!) }))
        .filter((g) => g.ids.length > 0);
      state.compare = [];
      if (groups.length < 2) {
        state.decisions.push({ step: 5, kind: "skip", detail: "fewer than 2 ideas have found comparables; overlap skipped" });
        return state;
      }
      await runQloo(state, 5, async () => {
        for (let a = 0; a < groups.length; a++) {
          for (let b = a + 1; b < groups.length; b++) {
            const { overlap, record } = await compareGroups(groups[a].ids, groups[b].ids, 5);
            calls(record);
            if (overlap !== null) state.compare!.push({ ideaA: groups[a].i, ideaB: groups[b].i, overlap, callId: record.callId });
          }
        }
      });
      return state;
    }
    case 6: {
      // All ideas: the ranking uses each idea's own trend.
      const found = (state.resolved ?? []).filter((r) => r.entityId);
      state.trends = [];
      const byKind = new Map<ComparableKind, ResolvedComparable[]>();
      for (const r of found) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
      const skipped = [...byKind.keys()].filter((k) => !TRENDING_TYPES.includes(KIND_TO_URN[k]));
      if (skipped.length) {
        state.decisions.push({ step: 6, kind: "skip", detail: `trending is not offered for: ${skipped.join(", ")}` });
      }
      await runQloo(state, 6, async () => {
        for (const [kind, rs] of byKind) {
          if (!TRENDING_TYPES.includes(KIND_TO_URN[kind])) continue;
          for (const r of rs) {
            const { entities, record } = await trending(r.entityId!, KIND_TO_URN[kind], 6);
            calls(record);
            // Only the entity itself counts; another title's velocity is not this one's trend.
            const e = entities.find((x) => x.entity_id === r.entityId);
            if (e && isFiniteNumber(e.query?.velocity)) {
              state.trends!.push({ entityId: r.entityId!, name: r.resolvedName ?? r.name, velocity: e.query.velocity, callId: record.callId });
            }
          }
        }
      });
      return state;
    }
    case 7: {
      state.ranking = rankIdeas(state);
      state.focusIdea = state.ranking.find((r) => !r.dontMake)?.idea
        ?? state.ranking.find((r) => r.onHold && r.parts.found > 0)?.idea ?? FOCUS_IDEA;
      state.neighbors = state.ideaNeighbors?.find((x) => x.idea === state.focusIdea)?.neighbors ?? [];
      const draft = state.ideaDrafts?.find((d) => d.idea === state.focusIdea);
      state.assumptions = draft?.assumptions;
      state.blindListing = draft?.blindListing;
      state.demographics = null;

      const ids = foundIds(state);
      if (ids.length === 0) {
        state.demographics = null;
        state.decisions.push({ step: 3, kind: "skip", detail: `no comparables were found for idea ${state.focusIdea + 1}; demographics skipped` });
      } else {
        await runQloo(state, 3, async () => {
          const d = await demographics(ids, 3);
          if (d) {
            calls(d.record);
            state.demographics = { age: d.age, gender: d.gender, callId: d.record.callId };
          }
        });
      }
      state.heatmap = [];
      delete state.likeEntities;
      if (ids.length === 0) {
        state.decisions.push({ step: 7, kind: "skip", detail: `no comparables were found for idea ${state.focusIdea + 1}; regions skipped` });
        return state;
      }
      await runQloo(state, 7, async () => {
        const { regions, record } = await heatmap(ids, 7);
        calls(record);
        state.heatmap = regions.map((r) => ({ ...r, callId: record.callId }));
      });
      // A3: a guessed like counts only when Qloo resolves the item as written to the neighbour's own entity.
      // The maker's named likes go through the same id check (improvement 3).
      const likes = [...likeCandidates(state), ...makerLikeCandidates(state)].filter(
        (x, i, all) => all.findIndex((y) => y.item === x.item && y.hit.entityId === x.hit.entityId) === i,
      );
      if (likes.length) {
        const checked: NonNullable<RunState["likeEntities"]> = [];
        await runQloo(state, 7, async () => {
          for (const { item, hit } of likes) {
            // Qloo labels neighbours only "urn:entity", so search with the type step 4 filtered them by.
            const urn = neighbourType(state.input);
            const kind = (Object.keys(KIND_TO_URN) as ComparableKind[]).find((k) => KIND_TO_URN[k] === urn);
            if (!kind) {
              checked.push({ item, neighborEntityId: hit.entityId, entityId: null, callId: null });
              continue;
            }
            const { entity, record } = await searchEntity(item, kind, 7);
            calls(record);
            checked.push({ item, neighborEntityId: hit.entityId, entityId: entity?.entity_id ?? null, callId: record.callId });
          }
        });
        state.likeEntities = checked;
      } else state.likeEntities = [];
      return state;
    }
    case 8: {
      need(state.ideaDrafts?.length, "step 0 first");
      state.makerAssumptionChecks = checkMakerAssumptions(state);
      state.verdicts = computeVerdicts(state);
      state.sources[8] = "rules";
      return state;
    }
    case 9: {
      state.ranking = rankIdeas(state);
      state.sources[9] = "rules";
      return state;
    }
    case 10: {
      need(state.verdicts, "step 8 first");
      const registry = buildEvidence(state);
      const v = applyLlm(state, 10, await step10Grounded(state, registry));
      const check = checkClaims(v.claims, registry);
      const allowed = state.input.priceUsd ? [state.input.priceUsd] : [];
      const listing = checkListing(v.listing, registry, state.input.marketplace, allowed, state.input.ideas[state.focusIdea]);
      const names = checkListingNames(
        {
          ...v.listing,
          title: listing.title,
          description: listing.description,
          tags: listing.tags,
          coverDirection: listing.coverDirection ?? v.listing.coverDirection,
        },
        listingNames(state),
        state.input.ideas[state.focusIdea],
      );
      state.groundedListing = names.listing;
      const practical = v.practical && state.ranking?.some((r) => r.onHold)
        ? { ...v.practical, tieBreak: null } : v.practical;
      state.practical = checkPractical(practical, state.input.ideas.length, state.ranking ?? [], state.input.priceUsd);
      state.groundedClaims = [...check.kept, ...check.downgraded.map((d) => d.claim)];
      state.checker = {
        downgraded: check.downgraded.length,
        dropped: check.dropped.length,
        listingFixes: listing.notes.length + names.notes.length + (state.beforeListingNotes?.[state.focusIdea]?.length ?? 0),
        notes: [
          ...check.downgraded.map((d) => `downgraded: "${d.claim.text}" — ${d.reason}`),
          ...check.dropped.map((d) => `dropped: "${d.claim.text}" — ${d.reason}`),
          ...listing.notes,
          ...names.notes,
          ...(state.beforeListingNotes?.[state.focusIdea] ?? []),
        ],
      };
      return state;
    }
    default:
      throw new Error(`unknown step ${step}`);
  }
}
