#!/usr/bin/env node
/**
 * evaluate.mjs — does Qloo change the answer? Pretaste (the model + Qloo) against the same model alone.
 *
 * Method (v0, 2026-10-22). The pass line: Pretaste wins at least 2 of the 3 fair yardsticks (3, 4, 5).
 * Yardsticks 1 and 2 only show the difference: the side with data obviously has more data.
 *
 * Sides
 * - LLM only: the model Pretaste runs on (checked against /api/status), one call, effort medium, no tools and
 *   no web, through the Claude Code CLI in a clean mode (--safe-mode: no CLAUDE.md, memory, hooks, plugins or
 *   MCP; --tools ""; started in an empty folder; the context size of every call is logged so a leak shows).
 *   Its prompt is a strong one that does the whole job: buyer guess, comparables, a check of the maker's notes,
 *   make / fix / skip per idea, a top pick and a listing for idea 0.
 * - Pretaste: the deployed pipeline, steps 0-10 (scripts/pretaste-cli.mjs), with the same input.
 * - Both sides read the same input text (the format of describeInput in src/lib/llm/tasks.ts).
 *
 * Yardsticks
 * 3 Planted error: a publicly false belief goes in the maker's notes. A judge reads each side's report on its
 *   own (the side is not named) and grades whether it tells the maker the belief is wrong:
 *   yes = 1, partly = 0.5, no = 0.
 * 4 Stability: the same input 3 times per side. Decision signature = (top pick, set of ideas to skip).
 *   Pretaste: top pick = highest score not flagged "don't make"; skip = the flagged ideas.
 *   LLM only: its own top pick and its "skip" ideas. Score = share of runs matching the most common signature.
 * 5 Blind preference: a judge sees both reports as A and B in a random order, with "Qloo" and "Pretaste"
 *   masked, and picks the one more useful for deciding before making (A / B / tie). It is told not to reward
 *   numbers, length or a confident tone by themselves.
 * 1 Real-entity rate: Pretaste's found ratio (comparables the Qloo search found). Not measured for the LLM-only
 *   side in v0 (that needs the same search check on both sides).
 * 2 Evidence-backed rate: share of Pretaste's shown claims that point at a recorded Qloo call. The LLM-only side
 *   has no data source, so it is 0 by construction.
 *
 * Judge: claude-opus-5-5 in the same clean mode. v0 limit: the judge comes from the same vendor as both sides;
 * the final run should add a judge from another vendor.
 * Inputs: generic ideas a judge might type. Not our 3 case studies, not the prepared scenarios.
 * Size (v0): 4 inputs; 2 carry a planted error (1 run each), 2 run 3 times (stability) = 8 runs per side.
 * Holdout (--set holdout, sealed 2026-10-23): 8 inputs; 4 planted errors, 2 stability (3 runs), 2 preference
 *   only = 12 runs per side. It is run once, after the fixes, and never used to tune. Reported apart from dev.
 *
 * Output: .cache/eval/<JST stamp>/ (git-ignored: Pretaste's saved states hold Qloo-derived data).
 * Only the numbers in summary.md / summary.json are meant to leave that folder.
 * If the CLI reports a usage limit, the run stops, keeps what it has, and --resume <dir> continues later
 * (only failed or missing items run again).
 *
 *   node scripts/evaluate.mjs                     # v0 against https://pretaste.vercel.app
 *   node scripts/evaluate.mjs --only y2k-planner  # one input
 *   node scripts/evaluate.mjs --resume .cache/eval/20261022-0650
 *   node scripts/evaluate.mjs --summary .cache/eval/20261022-0650   # recount only, calls nothing
 *   node scripts/evaluate.mjs --dry               # print the plan, call nothing
 *   node scripts/evaluate.mjs --set holdout       # the sealed holdout set (once)
 *   node scripts/evaluate.mjs --set fresh         # the sealed fresh set on the current version (once)
 *   node scripts/evaluate.mjs --set fresh2        # the second sealed fresh set, after the fixes (once)
 *   node scripts/evaluate.mjs --set cases --only C1  # our own decision cases: one run per side, no score
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertInsideCache, runPipeline } from "./pretaste-cli.mjs";

const METHOD_VERSION = "v0-2026-10-22";
const JUDGE_MODEL = "claude-opus-5-5";
const LABELS = {
  age: "Age",
  gender: "Gender",
  lifeStage: "Life stage",
  aesthetic: "Aesthetic",
  likes: "Also likes",
  trendDirection: "Trend",
  region: "Region (US)",
};

const INPUTS = [
  {
    id: "y2k-planner",
    input: {
      ideas: ["Y2K-style digital planner for college students (GoodNotes PDF)", "Minimalist monthly budget tracker printable"],
      marketplace: "etsy",
      priceUsd: 8,
      ownAssumptions: "My buyers are mostly men aged 55 and older.",
    },
    planted: {
      fact: "Y2K-style and digital planners are bought mainly by young women (teens to early 30s); men aged 55 and older are a small minority.",
    },
    reps: 1,
  },
  {
    id: "rpg-journal",
    input: {
      ideas: ["Fantasy tabletop RPG character journal (D&D-style)", "Board game night score sheet book"],
      marketplace: "kdp",
      priceUsd: 9.99,
      ownAssumptions: "Tabletop RPG players are mostly women over 55.",
    },
    planted: {
      fact: "Tabletop RPG (D&D) players skew male and young; most are under 35, and women over 55 are a small minority.",
    },
    reps: 1,
  },
  {
    id: "kdp-coloring",
    input: {
      ideas: ["Dinosaur coloring book for kids ages 4-8", "Mandala coloring book for adults (stress relief)", "Cozy autumn coloring book for adults"],
      marketplace: "kdp",
      priceUsd: 7.99,
    },
    reps: 3,
  },
  {
    id: "etsy-gifts",
    input: {
      ideas: ["Book-scented candle for book lovers", "Custom pet portrait mug", "Phone case with a pressed-flower design"],
      marketplace: "etsy",
      priceUsd: 24,
    },
    reps: 3,
  },
];

// Holdout (sealed 2026-10-23): 4 planted errors, 2 stability, 2 preference only. Not used to tune anything;
// run once with --set holdout. Do not edit these after the sealing commit.
const HOLDOUT_INPUTS = [
  {
    id: "h-knitting",
    input: {
      ideas: ["Beginner chunky scarf knitting pattern (PDF)", "Crochet amigurumi bunny pattern (PDF)"],
      marketplace: "etsy",
      priceUsd: 6,
      ownAssumptions: "Knitting and crochet patterns are bought mostly by men.",
    },
    planted: { fact: "Knitting and crochet hobbyists, and buyers of their patterns, are overwhelmingly women." },
    reps: 1,
  },
  {
    id: "h-anime-stickers",
    input: {
      ideas: ["Anime-style vinyl sticker pack", "Kawaii washi tape set"],
      marketplace: "etsy",
      priceUsd: 7,
      ownAssumptions: "Anime merchandise is bought mostly by people over 65.",
    },
    planted: { fact: "Anime merchandise buyers skew young (teens to mid-30s); people over 65 are a small minority." },
    reps: 1,
  },
  {
    id: "h-large-print",
    input: {
      ideas: ["Large-print sudoku puzzle book", "Large-print word search book"],
      marketplace: "kdp",
      priceUsd: 8.99,
      ownAssumptions: "Large-print puzzle books sell mostly to teenagers.",
    },
    planted: { fact: "Large-print puzzle books are made for and bought mainly by older adults (and relatives buying for them), not teenagers." },
    reps: 1,
  },
  {
    id: "h-baby-milestone",
    input: {
      ideas: ["Baby milestone cards for the first year", "Personalized nursery name sign"],
      marketplace: "etsy",
      priceUsd: 18,
      ownAssumptions: "My buyers are mostly retired men without children or grandchildren.",
    },
    planted: { fact: "Baby milestone cards and nursery signs are bought mainly by expecting or new parents (mostly mothers aged about 25-40) and by gift givers for them." },
    reps: 1,
  },
  {
    id: "h-fitness-logs",
    input: {
      ideas: ["90-day workout log book", "Weekly meal prep planner notebook", "Running training journal"],
      marketplace: "kdp",
      priceUsd: 7.99,
    },
    reps: 3,
  },
  {
    id: "h-wedding",
    input: {
      ideas: ["Editable wedding seating chart template", "Bridal shower game cards", "Wedding guest book puzzle"],
      marketplace: "etsy",
      priceUsd: 12,
    },
    reps: 3,
  },
  {
    id: "h-garden",
    input: {
      ideas: ["Vegetable garden planner and log book", "Houseplant care journal"],
      marketplace: "kdp",
      priceUsd: 8.99,
    },
    reps: 1,
  },
  {
    id: "h-cricut",
    input: {
      ideas: ["Halloween SVG cut files for Cricut", "Christmas ornament SVG bundle"],
      marketplace: "etsy",
      priceUsd: 5,
    },
    reps: 1,
  },
];

// Fresh set (--set fresh, sealed 2026-10-29): written before the run on the current version, never used to
// tune, reported as-is. 6 inputs: 3 planted errors, 1 stability (3 runs), 2 preference only = 8 runs per side.
const FRESH_INPUTS = [
  {
    id: "f-golf",
    input: {
      ideas: ["Golf course scorecard and stats log book", "Fly fishing trip journal"],
      marketplace: "kdp",
      priceUsd: 9.99,
      ownAssumptions: "Golf log books are bought mostly by teenage girls.",
    },
    planted: { fact: "Golf players and buyers of golf log books skew heavily male and older (about 40+); teenage girls are a small minority." },
    reps: 1,
  },
  {
    id: "f-kpop",
    input: {
      ideas: ["K-pop photocard binder stickers", "K-pop concert countdown printable"],
      marketplace: "etsy",
      priceUsd: 6,
      ownAssumptions: "K-pop fan merchandise is bought mostly by men over 55.",
    },
    planted: { fact: "K-pop fan merchandise buyers skew young and female (teens to early 30s); men over 55 are a small minority." },
    reps: 1,
  },
  {
    id: "f-true-crime",
    input: {
      ideas: ["True crime podcast fan sticker pack", "Murder mystery party game kit (printable)"],
      marketplace: "etsy",
      priceUsd: 8,
      ownAssumptions: "True crime fans are overwhelmingly men.",
    },
    planted: { fact: "True crime audiences (podcasts, books, documentaries) skew female; most surveys put women at well over half." },
    reps: 1,
  },
  {
    id: "f-teacher",
    input: {
      ideas: ["Teacher lesson planner 2027", "Classroom reward coupon printables", "Back-to-school bulletin board kit"],
      marketplace: "etsy",
      priceUsd: 10,
    },
    reps: 3,
  },
  {
    id: "f-cocktail",
    input: {
      ideas: ["Home cocktail recipe journal", "Wine tasting notes log book"],
      marketplace: "kdp",
      priceUsd: 8.99,
    },
    reps: 1,
  },
  {
    id: "f-birdwatch",
    input: {
      ideas: ["Backyard bird watching log book", "Nature journal for kids ages 6-10"],
      marketplace: "kdp",
      priceUsd: 7.99,
    },
    reps: 1,
  },
];

// Second fresh set (--set fresh2, sealed 2026-10-29 evening): written after the fixes to what the first fresh
// set exposed and before any run on them; never used to tune, reported as-is. Same shape as the fresh set.
const FRESH2_INPUTS = [
  {
    id: "g-yoga",
    input: {
      ideas: ["Yoga practice journal", "Meditation affirmation cards (printable)"],
      marketplace: "etsy",
      priceUsd: 9,
      ownAssumptions: "Yoga journals are bought mostly by men.",
    },
    planted: { fact: "Yoga practitioners and buyers of yoga journals skew strongly female; men are a minority." },
    reps: 1,
  },
  {
    id: "g-gaming",
    input: {
      ideas: ["Video game achievement tracker notebook", "Retro arcade pixel art sticker sheet"],
      marketplace: "etsy",
      priceUsd: 7,
      ownAssumptions: "Video game notebooks are bought mostly by women over 55.",
    },
    planted: { fact: "Buyers of video game merchandise skew young (teens to 30s) and male; women over 55 are a small minority." },
    reps: 1,
  },
  {
    id: "g-knitting",
    input: {
      ideas: ["Knitting project planner", "Crochet pattern notebook"],
      marketplace: "kdp",
      priceUsd: 8.99,
      ownAssumptions: "Knitting planners are bought mostly by young men.",
    },
    planted: { fact: "Knitting and crochet buyers skew strongly female and older; young men are a small minority." },
    reps: 1,
  },
  {
    id: "g-wedding",
    input: {
      ideas: ["Wedding planner binder (printable)", "Bridal shower game cards", "Save the date card templates"],
      marketplace: "etsy",
      priceUsd: 12,
    },
    reps: 3,
  },
  {
    id: "g-hiking",
    input: {
      ideas: ["National park hiking log book", "Camping recipe journal"],
      marketplace: "kdp",
      priceUsd: 8.99,
    },
    reps: 1,
  },
  {
    id: "g-baby",
    input: {
      ideas: ["Baby's first year memory book", "Pregnancy journal week by week"],
      marketplace: "kdp",
      priceUsd: 10.99,
    },
    reps: 1,
  },
];

// Third sealed set (written 10/29 evening, after the fixes from fresh2; not run before it is scored).
const FRESH3_INPUTS = [
  {
    id: "h-garden",
    input: { ideas: ["Vegetable garden planner", "Houseplant care log"], marketplace: "kdp", priceUsd: 7.99, ownAssumptions: "Garden planners are bought mostly by men under 25." },
    planted: { fact: "Home gardeners skew older (35+) and somewhat female; men under 25 are a small minority of buyers." },
    reps: 1,
  },
  {
    id: "h-fishing",
    input: { ideas: ["Fishing log book", "Fly tying pattern notebook"], marketplace: "kdp", priceUsd: 8.99, ownAssumptions: "Fishing log books are bought mostly by women." },
    planted: { fact: "US recreational anglers are mostly male (about two thirds); women are a minority." },
    reps: 1,
  },
  {
    id: "h-horror",
    input: { ideas: ["Horror movie watch log", "Gothic creepy sticker set"], marketplace: "etsy", priceUsd: 8, ownAssumptions: "Horror movie fans are mostly people over 65." },
    planted: { fact: "Horror film audiences skew young, mostly under 35; people over 65 are a small minority." },
    reps: 1,
  },
  {
    id: "h-tea",
    input: { ideas: ["Tea tasting journal (printable)", "Matcha lover sticker pack", "Afternoon tea party invitation templates"], marketplace: "etsy", priceUsd: 6 },
    reps: 3,
  },
  {
    id: "h-running",
    input: { ideas: ["Marathon training log book", "Beginner 5K running journal"], marketplace: "kdp", priceUsd: 9.99 },
    reps: 1,
  },
  {
    id: "h-cat",
    input: { ideas: ["Cat lover birthday card set (printable)", "Cat breed coloring book for kids"], marketplace: "etsy", priceUsd: 5 },
    reps: 1,
  },
];

// Our own decisions (plan §5, docs/cases/C1-C3.md): one run per side, saved for the case record.
// No judge and no score: the "after" is written by the decision owner from these outputs.
const CASE_INPUTS = [
  {
    id: "C1",
    reps: 1,
    case: true,
    input: {
      ideas: [
        "Adult coloring book of calm Japan-themed everyday scenes, 8.5x11 paperback (current book, kept as is)",
        "The same Japan-scenes adult coloring book with a higher page count",
        "A new title and expanded new edition of the Japan-scenes adult coloring book",
      ],
      marketplace: "kdp",
      priceUsd: 9.99,
      ownAssumptions: "Buyers are adult coloring buyers looking for calm, Japan-themed scenes.",
    },
  },
  {
    id: "C2",
    reps: 1,
    case: true,
    input: {
      ideas: [
        "Printable family handover binder, 12 pages, for household paperwork (current listing, kept as is)",
        "Printable pet care handover sheet for sitters and family (same family-paperwork niche)",
        "A printable outside the family-paperwork niche that follows a current Etsy search trend",
      ],
      marketplace: "etsy",
      priceUsd: 9,
      ownAssumptions: "Buyers keep household paperwork and want family members to find accounts, contacts and next steps.",
    },
  },
  {
    // The tool only covers US Etsy and KDP. Japan LINE stickers go in as the nearest form (Etsy digital
    // stickers); the case record says the US signal cannot prove Japanese LINE demand.
    id: "C3",
    reps: 1,
    case: true,
    input: {
      ideas: [
        "Black cat sticker set: polite winter and New Year messages to your part-time job manager",
        "Black cat sticker set: polite messages for a club or school parents' group",
        "No new set: promote the two existing black cat sticker sets",
      ],
      marketplace: "etsy",
      ownAssumptions: "Senders need polite messages to a manager at their part-time job.",
    },
  },
];

const SETS = { dev: INPUTS, holdout: HOLDOUT_INPUTS, fresh: FRESH_INPUTS, fresh2: FRESH2_INPUTS, fresh3: FRESH3_INPUTS, cases: CASE_INPUTS };

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------
function describeInput(input) {
  const lines = input.ideas.map((idea, i) => `Idea ${i + 1}: ${idea}`);
  lines.push(`Marketplace: ${input.marketplace}`);
  if (input.priceUsd) lines.push(`Price: $${input.priceUsd}`);
  if (input.ownAssumptions) lines.push(`Maker's own notes: ${input.ownAssumptions}`);
  return lines.join("\n");
}
const tagCount = (input) => (input.marketplace === "kdp" ? 7 : 13);

const LLM_SYSTEM = [
  "You are an experienced product strategist for small online sellers (Etsy shops and Amazon KDP publishers).",
  "Before anything is made, you decide which idea to make first, who will buy it, and how to list it.",
  "You have no internet access and no market database: use what you know, be concrete, and say how sure you are.",
  "If the maker's notes contain a belief that is likely wrong, say so plainly and explain why.",
].join(" ");

function llmUser(input) {
  return `${describeInput(input)}

Do the whole pre-launch check for these ideas. Return only one JSON object, no prose, in this shape:
{
  "ideas": [ { "idea": <idea number as listed>, "decision": "make" | "fix" | "skip", "reason": "<why>", "risks": ["..."] } ],
  "topPick": <number of the one idea to make first, or null if none should be made>,
  "buyer": { "ageBands": ["24_and_younger" | "25_to_29" | "30_to_34" | "35_to_44" | "45_to_54" | "55_and_older"],
             "genderLean": "female" | "male" | "neutral", "lifeStage": "...", "aesthetic": ["..."],
             "alsoLikes": ["<concrete titles, brands or shows>"], "trend": "rising" | "flat" | "falling",
             "regionsUS": ["<US states>"] },
  "comparables": [ { "idea": <idea number as listed>, "name": "<a real, findable work or brand>", "kind": "book" | "movie" | "tv_show" | "brand" | "videogame" | "artist" | "podcast" } ],
  "makerNotesCheck": [ { "belief": "...", "assessment": "likely right" | "likely wrong" | "unsure", "why": "..." } ],
  "listing": { "title": "...", "tags": [<exactly ${tagCount(input)} tags>], "description": "...", "coverDirection": "..." },
  "confidence": <0-10>
}
"buyer" and "listing" are about idea 1. Give 2-3 comparables per idea.`;
}

const JUDGE_SYSTEM =
  "You are a careful, impartial reviewer of pre-launch reports for small online sellers. Answer only with one JSON object.";

function plantedUser(x, report) {
  return `A maker wrote this in their notes: "${x.input.ownAssumptions}"
This belief is false. Public fact: ${x.planted.fact}

Below is a report written for this maker.
--- REPORT ---
${report}
--- END ---

Does the report tell the maker that this belief is wrong, or clearly contradict it with a reason? Count only what the report says, not what it leaves out.
Return JSON: {"flagged": "yes" | "partly" | "no", "quote": "<the sentence of the report that does it, or empty>"}`;
}

function prefUser(x, a, b) {
  return `A maker is deciding, before making anything, which product idea to make first and how to list it.
${describeInput(x.input)}

Two reports were written for this maker.
--- REPORT A ---
${a}
--- END A ---
--- REPORT B ---
${b}
--- END B ---

Which report would help the maker more to make a good decision before spending time making the product? Judge on: whether the claims are likely true, whether they are supported, whether wrong beliefs are caught, whether the decision is clear and justified, and honesty about uncertainty. Do not reward numbers, length or a confident tone by themselves.
Return JSON: {"winner": "A" | "B" | "tie", "reasons": ["..."], "biggestFlawA": "...", "biggestFlawB": "..."}`;
}

// ---------------------------------------------------------------------------
// reports (what the judge reads; product names masked)
// ---------------------------------------------------------------------------
const mask = (text) => text.replace(/qloo/gi, "the data source").replace(/pretaste/gi, "the tool");

function pretasteTop(state) {
  const r = [...(state.ranking || [])].sort((a, b) => b.score - a.score);
  return r.find((x) => !x.dontMake) ?? null;
}

// The words the app shows for each call (screens.tsx CALL_LABELS).
const CALL_WORDS = { make: "Research first", fix: "Revise, then research", skip: "Lower research priority", hold: "Hold, more evidence needed" };

function renderPretaste(state) {
  // Mirrors the app (screens.tsx): ideas are numbered from 1 and scores are out of 100, the same as the
  // product's own sentences, so the judge does not see two numbering schemes in one report.
  const ideas = state.input.ideas;
  const n = (i) => `Idea ${i + 1}`;
  const L = ["Ideas, in the app's order (research priority from Qloo taste data, not a sales forecast):"];
  for (const r of state.ranking || []) {
    let line = `- ${n(r.idea)} (${ideas[r.idea]}): ${r.unranked ? "not ranked (no taste signal)" : `${Math.round(r.score * 1000) / 10} / 100`}`;
    if (r.call) line += ` — ${CALL_WORDS[r.call]}: ${r.callReason ?? ""}`;
    else if (r.dontMake) line += ` — don't make (yet): ${r.dontMakeReason ?? ""}`;
    if (r.missing?.length && !r.unranked) line += ` — no signal for: ${r.missing.join(", ")}`;
    L.push(line);
  }
  const top = pretasteTop(state);
  const p = state.practical;
  const held = (state.ranking || []).filter((r) => r.call === "hold" && !r.unranked && !r.onHold).map((r) => r.idea);
  if (held.length >= 2) {
    L.push(`Suggested first: the data cannot separate ${held.map(n).join(" and ")} (scores under 5 points apart).`);
    if (p?.tieBreak) L.push(`Where to start anyway (general knowledge, not checked against data): ${n(p.tieBreak.idea)} — ${p.tieBreak.why}`);
  } else L.push(`Suggested first: ${top ? n(top.idea) : "none"}`);
  // Same content as the app's "Outside the data" section (screens.tsx practicalLines).
  if (p?.ideas?.length) {
    L.push("", "Outside the data (general knowledge from the model, not checked against data):");
    for (const it of p.ideas) L.push(`- ${n(it.idea)}${it.priceFit ? ` — price: ${it.priceFit}` : ""}${it.risks.length ? ` — risks: ${it.risks.join("; ")}` : ""}`);
  }
  // Same content as the app's "Your assumptions" section (screens.tsx summary export).
  if (state.input.ownAssumptions) {
    L.push("", "The maker's own notes, checked against data:", state.input.ownAssumptions);
    for (const a of state.makerAssumptionChecks ?? []) {
      L.push(`- ${a.status}${a.idea === null ? "" : ` (${n(a.idea)})`}: ${a.text} ${a.reason}`);
      if (a.signals?.length) L.push(`  signals: ${a.signals.map((s) => `${s.field} = ${s.value}`).join(", ")}`);
    }
  }
  if (state.verdicts?.length) {
    L.push("", `Buyer assumptions for ${n(state.focusIdea)}, checked against data:`);
    for (const v of state.verdicts) L.push(`- ${LABELS[v.field] ?? v.field}: assumed "${v.assumed}" → ${v.verdict}: ${v.reason}`);
  }
  if (state.resolved?.length) {
    L.push("", "Comparables: " + state.resolved.map((c) => `${c.resolvedName ?? c.name} (${n(c.idea)}${c.entityId ? "" : ", not found"})`).join(", "));
  }
  const g = state.groundedListing;
  if (g) L.push("", `Listing for ${n(state.focusIdea)}:`, `Title: ${g.title}`, `Tags: ${g.tags.join(", ")}`, `Description: ${g.description}`, `Cover: ${g.coverDirection}`);
  if (state.errors?.length) L.push("", "Problems during the run: " + state.errors.map((e) => `step ${e.step}: ${e.message}`).join("; "));
  return mask(L.join("\n"));
}

function renderLlm(ans, input) {
  const ideas = input.ideas;
  const L = ["Ideas:"];
  for (const it of ans.ideas || []) {
    L.push(`- Idea ${it.idea} (${ideas[it.idea - 1] ?? "?"}): ${String(it.decision).toUpperCase()} — ${it.reason}${it.risks?.length ? ` Risks: ${it.risks.join("; ")}` : ""}`);
  }
  L.push(`Suggested first: ${ans.topPick === null || ans.topPick === undefined ? "none" : `Idea ${ans.topPick}`}`);
  const b = ans.buyer || {};
  L.push(
    "",
    "Buyer for idea 1 (estimate):",
    `- Age: ${(b.ageBands || []).join(", ")}`,
    `- Gender: ${b.genderLean}`,
    `- Life stage: ${b.lifeStage}`,
    `- Aesthetic: ${(b.aesthetic || []).join(", ")}`,
    `- Also likes: ${(b.alsoLikes || []).join(", ")}`,
    `- Trend: ${b.trend}`,
    `- Region (US): ${(b.regionsUS || []).join(", ")}`,
  );
  if (ans.makerNotesCheck?.length) {
    L.push("", "Check of the maker's notes:");
    for (const m of ans.makerNotesCheck) L.push(`- "${m.belief}" → ${m.assessment}: ${m.why}`);
  }
  if (ans.comparables?.length) L.push("", "Comparables: " + ans.comparables.map((c) => `${c.name} (idea ${c.idea})`).join(", "));
  const g = ans.listing;
  if (g) L.push("", "Listing for idea 1:", `Title: ${g.title}`, `Tags: ${(g.tags || []).join(", ")}`, `Description: ${g.description}`, `Cover: ${g.coverDirection}`);
  if (ans.confidence !== undefined) L.push("", `Confidence: ${ans.confidence}/10`);
  return mask(L.join("\n"));
}

// ---------------------------------------------------------------------------
// yardsticks
// ---------------------------------------------------------------------------
function sigPretaste(state) {
  if (!state?.ranking?.length) return "error";
  const top = pretasteTop(state);
  const skip = state.ranking.filter((x) => x.dontMake).map((x) => x.idea).sort();
  return `top=${top ? top.idea : "none"};skip=${skip.join(",")}`;
}

function sigLlm(ans) {
  if (!Array.isArray(ans?.ideas)) return "error";
  const skip = ans.ideas.filter((x) => x.decision === "skip").map((x) => x.idea).sort();
  return `top=${ans.topPick ?? "none"};skip=${skip.join(",")}`;
}

function stability(sigs) {
  if (!sigs.length || sigs.every((s) => s === "error")) return null;
  const counts = {};
  for (const s of sigs) if (s !== "error") counts[s] = (counts[s] || 0) + 1;
  return Math.max(...Object.values(counts)) / sigs.length;
}

const FLAG_SCORE = { yes: 1, partly: 0.5, no: 0 };

/** Share of shown claims (verdicts + listing) that point at a recorded call. */
function evidenceRate(state) {
  const claims = [...(state.verdicts || []).flatMap((v) => v.claims || []), ...(state.groundedClaims || [])];
  if (!claims.length) return null;
  const callIds = new Set((state.calls || []).map((c) => c.callId));
  const backed = claims.filter((c) => c.kind === "qloo" && c.evidence?.some((e) => callIds.has(e.callId)));
  return backed.length / claims.length;
}

// ---------------------------------------------------------------------------
// the clean Claude CLI
// ---------------------------------------------------------------------------
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32" && process.env.APPDATA) {
    const exe = join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return exe;
  }
  return "claude";
}

class UsageLimitError extends Error {}

function callClaude({ model, system, user, effort, cwd, timeoutMs = 600_000 }) {
  return new Promise((done, fail) => {
    const args = ["-p", "--safe-mode", "--model", model, "--system-prompt", system, "--tools", "", "--no-session-persistence", "--output-format", "json", "--effort", effort];
    const child = spawn(claudeBin(), args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("claude CLI timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {
        /* not JSON */
      }
      if (!j || j.is_error || code !== 0) {
        const msg = String(j?.result || out || err).slice(0, 400);
        if (/usage limit|rate limit|quota|limit reached|credit balance|out of (extra )?usage/i.test(msg)) return fail(new UsageLimitError(msg));
        return fail(new Error(`claude CLI failed (code ${code}): ${msg}`));
      }
      const u = j.usage || {};
      done({
        text: j.result ?? "",
        ms: j.duration_ms,
        costUsd: j.total_cost_usd,
        ctxTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        outTokens: u.output_tokens,
        models: Object.keys(j.modelUsage || {}),
        promptChars: system.length + user.length,
      });
    });
    child.stdin.end(user);
  });
}

function parseJson(text) {
  const s = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in the answer");
  return JSON.parse(s.slice(a, b + 1));
}

async function askJson(opts) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callClaude(attempt ? { ...opts, user: `${opts.user}\n\nReturn only valid JSON.` } : opts);
    try {
      return { ...r, json: parseJson(r.text) };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const isDone = (f) => readJson(f)?.ok === true;

function jstStamp() {
  const iso = new Date(Date.now() + 9 * 3600e3).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const base = (flag("--base") || "https://pretaste.vercel.app").replace(/\/$/, "");
  const only = flag("--only")?.split(",");
  const reuse = flag("--summary") || flag("--resume");
  const set = (reuse && readJson(join(resolve(reuse), "meta.json"))?.set) || flag("--set") || "dev";
  if (!SETS[set]) throw new Error(`unknown --set ${set} (dev, holdout, fresh, fresh2 or cases)`);
  const inputs = SETS[set].filter((x) => !only || only.includes(x.id));
  const tasks = inputs.flatMap((x) => Array.from({ length: x.reps }, (_, rep) => ({ x, rep })));

  if (args.includes("--dry")) {
    console.log(`inputs ${inputs.length}, runs per side ${tasks.length}, judge calls ${inputs.filter((x) => x.planted).length * 2 + inputs.length}`);
    for (const t of tasks) console.log(`- ${t.x.id} #${t.rep}\n${describeInput(t.x.input).replace(/^/gm, "    ")}`);
    return;
  }

  const summaryOnly = flag("--summary");
  const dir = resolve(summaryOnly || flag("--resume") || join(".cache", "eval", `${jstStamp()}${set === "dev" ? "" : `-${set}`}`));
  assertInsideCache(join(dir, "x"));
  mkdirSync(dir, { recursive: true });
  const log = (m) => {
    const line = `${new Date().toISOString()} ${m}`;
    console.log(line);
    appendFileSync(join(dir, "log.txt"), `${line}\n`);
  };

  if (!summaryOnly) {
    const status = await (await fetch(`${base}/api/status`)).json();
    const model = status?.models?.planner;
    if (status.llm !== "online" || !model) throw new Error(`the server LLM is not online: ${JSON.stringify(status).slice(0, 300)}`);
    let commit = null;
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      /* not a checkout */
    }
    const prev = readJson(join(dir, "meta.json"));
    if (prev && (prev.base !== base || prev.model !== model)) throw new Error(`--resume with a different base or model (${prev.base} ${prev.model})`);
    const ids = [...new Set([...(prev?.inputs || []), ...inputs.map((x) => x.id)])];
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify(
        prev
          ? { ...prev, inputs: ids, resumedAt: [...(prev.resumedAt || []), new Date().toISOString()] }
          : { method: METHOD_VERSION, set, base, model, models: status.models, qloo: status.qloo, judgeModel: JUDGE_MODEL, localCommit: commit, startedAt: new Date().toISOString(), inputs: ids },
        null,
        2,
      ),
    );
    const cwd = join(tmpdir(), "pretaste-eval-empty");
    mkdirSync(cwd, { recursive: true });
    if (readdirSync(cwd).length) throw new Error(`the CLI folder must be empty: ${cwd}`);
    log(`start ${METHOD_VERSION} base=${base} model=${model} judge=${JUDGE_MODEL} dir=${dir}`);

    let stopped = null;
    const pretasteQueue = (async () => {
      for (const t of tasks) {
        if (stopped) return;
        const f = join(dir, `pretaste_${t.x.id}_${t.rep}.json`);
        if (isDone(f)) continue;
        const started = Date.now();
        // The server replays an identical start request sent within 10 minutes (B2), which would make
        // the 3 stability runs one run. A per-run tag the server ignores keeps each run independent.
        const res = await runPipeline(base, { input: t.x.input, evalRun: `${basename(dir)}-${t.x.id}-${t.rep}` });
        writeFileSync(f, JSON.stringify({ ...res, ms: Date.now() - started, at: new Date().toISOString() }, null, 2));
        log(`pretaste ${t.x.id} #${t.rep} ${res.ok ? "ok" : `FAILED ${res.fail}`} ${Math.round((Date.now() - started) / 1000)}s`);
      }
    })();
    const llmQueue = (async () => {
      for (const t of tasks) {
        if (stopped) return;
        const f = join(dir, `llm_${t.x.id}_${t.rep}.json`);
        if (isDone(f)) continue;
        try {
          const r = await askJson({ model, system: LLM_SYSTEM, user: llmUser(t.x.input), effort: "medium", cwd });
          writeFileSync(f, JSON.stringify({ ok: true, answer: r.json, ms: r.ms, ctxTokens: r.ctxTokens, promptChars: r.promptChars, outTokens: r.outTokens, costUsd: r.costUsd, models: r.models, at: new Date().toISOString() }, null, 2));
          log(`llm ${t.x.id} #${t.rep} ok ${Math.round(r.ms / 1000)}s ctx=${r.ctxTokens}`);
        } catch (e) {
          if (e instanceof UsageLimitError) {
            stopped = e.message;
            log(`STOP (usage limit): ${e.message}`);
            return;
          }
          writeFileSync(f, JSON.stringify({ ok: false, fail: String(e.message || e), at: new Date().toISOString() }, null, 2));
          log(`llm ${t.x.id} #${t.rep} FAILED ${e.message}`);
        }
      }
    })();
    await Promise.all([pretasteQueue, llmQueue]);

    // judges (rep 0 of each input)
    for (const x of inputs) {
      if (stopped) break;
      if (x.case) continue;
      const p = readJson(join(dir, `pretaste_${x.id}_0.json`));
      const l = readJson(join(dir, `llm_${x.id}_0.json`));
      if (!p?.ok || !l?.ok) continue;
      const reports = { pretaste: renderPretaste(p.state), llm: renderLlm(l.answer, x.input) };
      const jobs = [];
      if (x.planted) for (const side of ["pretaste", "llm"]) jobs.push({ f: join(dir, `judge_planted_${x.id}_${side}.json`), side, user: plantedUser(x, reports[side]) });
      const pretasteIsA = createHash("sha256").update(`${basename(dir)}:${x.id}`).digest()[0] % 2 === 0;
      const [a, b] = pretasteIsA ? [reports.pretaste, reports.llm] : [reports.llm, reports.pretaste];
      jobs.push({ f: join(dir, `judge_pref_${x.id}.json`), pretasteIsA, user: prefUser(x, a, b) });
      for (const job of jobs) {
        if (stopped) break;
        if (isDone(job.f)) continue;
        try {
          const r = await askJson({ model: JUDGE_MODEL, system: JUDGE_SYSTEM, user: job.user, effort: "medium", cwd });
          writeFileSync(job.f, JSON.stringify({ ok: true, side: job.side, pretasteIsA: job.pretasteIsA, verdict: r.json, ctxTokens: r.ctxTokens, promptChars: r.promptChars, models: r.models, at: new Date().toISOString() }, null, 2));
          log(`judge ${basename(job.f)} ok ${JSON.stringify(r.json.flagged ?? r.json.winner)}`);
        } catch (e) {
          if (e instanceof UsageLimitError) {
            stopped = e.message;
            log(`STOP (usage limit): ${e.message}`);
            break;
          }
          writeFileSync(job.f, JSON.stringify({ ok: false, fail: String(e.message || e) }, null, 2));
          log(`judge ${basename(job.f)} FAILED ${e.message}`);
        }
      }
    }
    if (stopped) log("stopped early; continue with --resume");
  }

  if (set === "cases") {
    console.log(`case outputs saved in ${dir} (pretaste_<id>_0.json, llm_<id>_0.json); no score for cases`);
    return;
  }
  const summary = summarize(dir, inputs);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(dir, "summary.md"), summaryMd(summary));
  console.log(summaryMd(summary));
}

function summarize(dir, inputs) {
  const meta = readJson(join(dir, "meta.json")) || {};
  const winner = (p, l) => (p === null || l === null ? "not measured" : p > l ? "pretaste" : l > p ? "llm" : "tie");
  const files = readdirSync(dir);

  // 3 planted error
  const planted = inputs
    .filter((x) => x.planted)
    .map((x) => {
      const g = (side) => {
        const j = readJson(join(dir, `judge_planted_${x.id}_${side}.json`));
        return j?.ok ? (FLAG_SCORE[j.verdict.flagged] ?? 0) : null;
      };
      return { id: x.id, pretaste: g("pretaste"), llm: g("llm") };
    });
  const sum = (rows, k) => (rows.some((r) => r[k] === null) || !rows.length ? null : rows.reduce((s, r) => s + r[k], 0));

  // 4 stability
  const stab = inputs
    .filter((x) => x.reps >= 3)
    .map((x) => {
      const ps = [];
      const ls = [];
      for (let rep = 0; rep < x.reps; rep++) {
        const p = readJson(join(dir, `pretaste_${x.id}_${rep}.json`));
        const l = readJson(join(dir, `llm_${x.id}_${rep}.json`));
        if (p) ps.push(p.ok ? sigPretaste(p.state) : "error");
        if (l) ls.push(l.ok ? sigLlm(l.answer) : "error");
      }
      return { id: x.id, pretaste: ps.length === x.reps ? stability(ps) : null, llm: ls.length === x.reps ? stability(ls) : null, pretasteSigs: ps, llmSigs: ls };
    });
  const mean = (rows, k) => (rows.some((r) => r[k] === null) || !rows.length ? null : rows.reduce((s, r) => s + r[k], 0) / rows.length);

  // 5 blind preference
  const pref = inputs.map((x) => {
    const j = readJson(join(dir, `judge_pref_${x.id}.json`));
    if (!j?.ok) return { id: x.id, winner: null };
    const w = j.verdict.winner;
    return { id: x.id, winner: w === "tie" ? "tie" : (w === "A") === j.pretasteIsA ? "pretaste" : "llm", reasons: j.verdict.reasons };
  });
  const prefCount = (side) => pref.filter((r) => r.winner === side).length;
  const prefMeasured = pref.every((r) => r.winner !== null) && pref.length > 0;

  // 1, 2 and run health (Pretaste)
  const runs = files.filter((f) => /^pretaste_.*\.json$/.test(f)).map((f) => ({ f, j: readJson(join(dir, f)) }));
  const okRuns = runs.filter((r) => r.j.ok);
  const found = okRuns.map((r) => r.j.state.foundRatio).filter((v) => typeof v === "number");
  const evid = okRuns.map((r) => evidenceRate(r.j.state)).filter((v) => v !== null);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const liveLlmSteps = okRuns.map((r) => Object.entries(r.j.state.sources || {}).filter(([, s]) => s === "llm").map(([k]) => Number(k)));
  const llmRuns = files.filter((f) => /^llm_.*\.json$/.test(f)).map((f) => readJson(join(dir, f)));
  const cliCalls = files.filter((f) => /^(llm|judge)_.*\.json$/.test(f)).map((f) => readJson(join(dir, f))).filter((j) => j?.ok);
  const leak = cliCalls.filter((j) => j.ctxTokens > j.promptChars / 3 + 2500).length;

  const results = {
    planted: { rows: planted, pretaste: sum(planted, "pretaste"), llm: sum(planted, "llm"), max: planted.length, winner: winner(sum(planted, "pretaste"), sum(planted, "llm")) },
    stability: { rows: stab, pretaste: mean(stab, "pretaste"), llm: mean(stab, "llm"), winner: winner(mean(stab, "pretaste"), mean(stab, "llm")) },
    preference: { rows: pref, pretaste: prefCount("pretaste"), llm: prefCount("llm"), tie: prefCount("tie"), winner: prefMeasured ? winner(prefCount("pretaste"), prefCount("llm")) : "not measured" },
  };
  const wins = ["planted", "stability", "preference"].filter((k) => results[k].winner === "pretaste").length;
  return {
    method: meta.method,
    dir: basename(dir),
    base: meta.base,
    model: meta.model,
    judgeModel: meta.judgeModel,
    localCommit: meta.localCommit,
    startedAt: meta.startedAt,
    results,
    g2EarlyRead: { pretasteWins: wins, of: 3, pass: wins >= 2 },
    supporting: {
      realEntityRatePretaste: avg(found),
      realEntityRateLlm: "not measured (v0)",
      evidenceBackedRatePretaste: avg(evid),
      evidenceBackedRateLlm: "0 by construction",
    },
    health: {
      pretasteRuns: runs.length,
      pretasteOk: okRuns.length,
      pretasteFailures: runs.filter((r) => !r.j.ok).map((r) => `${r.f}: ${r.j.fail}`),
      pretasteRunsWithErrors: okRuns.filter((r) => r.j.state.errors?.length).length,
      liveLlmStepsPerRun: liveLlmSteps,
      pretasteMedianSec: okRuns.length ? Math.round([...okRuns.map((r) => r.j.ms)].sort((a, b) => a - b)[Math.floor(okRuns.length / 2)] / 1000) : null,
      llmRuns: llmRuns.length,
      llmOk: llmRuns.filter((j) => j?.ok).length,
      cliCallsWithContextLeak: leak,
      cliMaxContextTokens: cliCalls.length ? Math.max(...cliCalls.map((j) => j.ctxTokens)) : null,
    },
  };
}

function summaryMd(s) {
  const n = (v, d = 2) => (v === null || v === undefined ? "n/a" : typeof v === "number" ? v.toFixed(d) : String(v));
  const r = s.results;
  return `# Evaluation ${s.dir} (${s.method})
Base ${s.base} · model ${s.model} (both sides) · judge ${s.judgeModel} · local commit ${s.localCommit}

| Yardstick | Pretaste | LLM only | Winner |
|---|---|---|---|
| 3 Planted error caught (of ${r.planted.max}) | ${n(r.planted.pretaste, 1)} | ${n(r.planted.llm, 1)} | ${r.planted.winner} |
| 4 Same decision over 3 runs (mean share) | ${n(r.stability.pretaste)} | ${n(r.stability.llm)} | ${r.stability.winner} |
| 5 Blind preference (wins; ties ${r.preference.tie}) | ${r.preference.pretaste} | ${r.preference.llm} | ${r.preference.winner} |
| 1 Real-entity rate | ${n(s.supporting.realEntityRatePretaste)} | ${s.supporting.realEntityRateLlm} | (supporting) |
| 2 Evidence-backed claims | ${n(s.supporting.evidenceBackedRatePretaste)} | ${s.supporting.evidenceBackedRateLlm} | (supporting) |

G2 early read: Pretaste wins ${s.g2EarlyRead.pretasteWins} of 3 → ${s.g2EarlyRead.pass ? "PASS" : "not yet"} (v0: small sample, same-vendor judge).

Planted: ${r.planted.rows.map((x) => `${x.id} P=${n(x.pretaste, 1)} L=${n(x.llm, 1)}`).join(" · ")}
Stability: ${r.stability.rows.map((x) => `${x.id} P=[${x.pretasteSigs.join(" | ")}] L=[${x.llmSigs.join(" | ")}]`).join(" · ")}
Preference: ${r.preference.rows.map((x) => `${x.id}=${x.winner}`).join(" · ")}

Health: Pretaste ${s.health.pretasteOk}/${s.health.pretasteRuns} ok (median ${s.health.pretasteMedianSec}s, runs with step errors ${s.health.pretasteRunsWithErrors}; live LLM steps per run ${JSON.stringify(s.health.liveLlmStepsPerRun)}) · LLM only ${s.health.llmOk}/${s.health.llmRuns} ok · CLI calls with a context leak ${s.health.cliCallsWithContextLeak} (max context ${s.health.cliMaxContextTokens} tokens)
${s.health.pretasteFailures.length ? `Failures: ${s.health.pretasteFailures.join("; ")}\n` : ""}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
