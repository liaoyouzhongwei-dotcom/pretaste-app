/**
 * Prepared scenarios + offline LLM fixtures.
 * The fixtures stand in for model output when PRETASTE_ANTHROPIC_API_KEY is not set
 * ("offline" badge). They are hand-written examples of what an LLM-only agent tends to
 * guess — they are NOT Qloo data and NOT measured results.
 */
import type { AssumptionSheet, Comparable, ListingDraft, ProductInput } from "@/lib/types";

export interface LlmFixture {
  assumptions: AssumptionSheet;
  blindListing: ListingDraft;
  comparables: Comparable[];
  candidateTags: string[];
  /** Offline stand-in for step 10. {{top_region}} is filled from evidence (no comparable names: listings never name them). */
  groundedListing: ListingDraft;
}

export interface Scenario {
  id: string;
  label: string;
  note: string;
  input: ProductInput;
  fixture: LlmFixture;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "coloring-japan",
    label: "Everyday Japan (coloring book)",
    note: "Real product of ours (named generically).",
    input: {
      ideas: [
        "Adult coloring book of small everyday scenes in Japan (cafés, trains, corner shops)",
        "Coloring book of Japanese seasonal festivals",
        "Coloring book of cats in Japanese towns",
      ],
      marketplace: "kdp",
      priceUsd: 9.99,
    },
    fixture: {
      assumptions: {
        age: { bands: ["55_and_older", "45_to_54"], note: "Coloring for relaxation skews older." },
        gender: { lean: "female", note: "Adult coloring buyers are mostly women." },
        lifeStage: { value: "Retired or empty-nester with free time" },
        aesthetic: { tags: ["cozy", "nostalgic", "minimal"], note: "Soft, calm, travel-memory feel." },
        likes: { note: "Japan travel, Ghibli films, healing fiction, Japanese stationery." },
        trendDirection: { value: "rising" },
        region: { states: ["California", "Hawaii", "Washington"], note: "West coast, Japanese-American communities." },
      },
      blindListing: {
        title: "Japan Coloring Book for Adults: Relaxing Scenes of Temples, Cherry Blossoms and Geisha",
        tags: ["japan coloring book", "adult coloring", "cherry blossom", "geisha", "zen", "stress relief", "seniors"],
        description:
          "Escape to Japan with 50 relaxing designs of temples, cherry blossoms, geisha and Mount Fuji. Perfect for seniors and anyone who loves Japanese culture.",
        coverDirection: "Red and gold, Mount Fuji with cherry blossoms, brush-style title.",
      },
      comparables: [
        { name: "Before the Coffee Gets Cold", kind: "book", idea: 0 },
        { name: "Midnight Diner: Tokyo Stories", kind: "tv_show", idea: 0 },
        { name: "MUJI", kind: "brand", idea: 0 },
        { name: "My Neighbor Totoro", kind: "movie", idea: 1 },
        { name: "Animal Crossing: New Horizons", kind: "videogame", idea: 1 },
        { name: "Kiki's Delivery Service", kind: "movie", idea: 1 },
        { name: "The Travelling Cat Chronicles", kind: "book", idea: 2 },
        { name: "Neko Atsume: Kitty Collector", kind: "videogame", idea: 2 },
      ],
      candidateTags: ["cozy", "japan", "slow living", "cats", "stationery", "healing fiction"],
      groundedListing: {
        title: "Little Everyday Japan: A Cozy Coloring Book of Cafés, Trains and Corner Shops",
        tags: ["cozy coloring book", "slow living", "japan daily life", "cafe illustrations", "train journeys", "mindful coloring", "gift for japan lovers"],
        description:
          "Quiet, everyday Japan — small cafés, local trains and corner shops — drawn for slow evenings. Made for people who enjoy calm, lived-in scenes more than famous landmarks.",
        coverDirection: "Warm off-white paper tone, one small café front, hand-lettered title; no temples or geisha.",
      },
    },
  },
  {
    id: "family-binder",
    label: "The family handover (fillable PDF)",
    note: "Real product of ours (named generically).",
    input: {
      ideas: [
        "Fillable 'if something happens to me' family handover binder (12-page PDF)",
        "Pet-care handover binder for sitters and family",
        "Home & bills handover checklist for couples",
      ],
      marketplace: "etsy",
      priceUsd: 9,
    },
    fixture: {
      assumptions: {
        age: { bands: ["45_to_54", "55_and_older"], note: "People who think about end-of-life paperwork." },
        gender: { lean: "female", note: "Household organisers are often women." },
        lifeStage: { value: "Parents with teenage or adult children" },
        aesthetic: { tags: ["professional", "minimal", "navy"], note: "Serious document, trustworthy look." },
        likes: { note: "Personal finance, organising, planners." },
        trendDirection: { value: "flat" },
        region: { states: ["Florida", "Texas", "Ohio"], note: "Older populations." },
      },
      blindListing: {
        title: "Emergency Binder Printable – Estate Planning Organizer – Fillable PDF",
        tags: ["emergency binder", "estate planning", "end of life", "printable", "fillable pdf", "organizer", "legacy"],
        description: "A complete fillable emergency binder to organize your important information for your loved ones.",
        coverDirection: "Navy cover, white serif title, simple line icons.",
      },
      comparables: [
        { name: "The Gentle Art of Swedish Death Cleaning", kind: "book", idea: 0 },
        { name: "Tidying Up with Marie Kondo", kind: "tv_show", idea: 0 },
        { name: "Erin Condren", kind: "brand", idea: 0 },
        { name: "Marley & Me", kind: "movie", idea: 1 },
        { name: "Chewy", kind: "brand", idea: 1 },
        { name: "The Ramsey Show", kind: "podcast", idea: 2 },
        { name: "Happy Planner", kind: "brand", idea: 2 },
      ],
      candidateTags: ["organizing", "planner", "peace of mind", "family", "pets", "budget"],
      groundedListing: {
        title: "The Kind Handover: A Fillable Family Binder So the People You Love Aren't Left Guessing",
        tags: ["family binder", "fillable pdf", "peace of mind", "home organizer", "if something happens", "planner printable", "gift for parents"],
        description:
          "Twelve calm, fillable pages for the things only you know. Practical, warm, not morbid.",
        coverDirection: "Soft sage and cream, rounded type, a small house line drawing; avoid navy 'corporate' look.",
      },
    },
  },
  {
    id: "comedian-merch",
    label: "Beyond the tour tee (example)",
    note: "Illustrative example. No real comedian is the subject; public works are used only as comparables.",
    input: {
      ideas: [
        "Tour t-shirt built around an inside joke from the set",
        "Sticker pack of the comedian's catchphrases",
        "Small zine of tour-diary sketches",
      ],
      marketplace: "other",
      priceUsd: 25,
    },
    fixture: {
      assumptions: {
        age: { bands: ["24_and_younger", "25_to_29"], note: "Stand-up crowds are young." },
        gender: { lean: "male", note: "Comedy fans skew male." },
        lifeStage: { value: "Students and young professionals" },
        aesthetic: { tags: ["bold", "ironic", "streetwear"], note: "Loud graphics." },
        likes: { note: "Comedy podcasts, sitcoms, streetwear." },
        trendDirection: { value: "rising" },
        region: { states: ["New York", "California", "Illinois"], note: "Comedy cities." },
      },
      blindListing: {
        title: "Official Tour Tee – Limited Edition",
        tags: ["comedy merch", "tour shirt", "funny tee", "stand-up", "limited edition", "streetwear", "gift"],
        description: "Rep your favorite comedian with this limited tour tee.",
        coverDirection: "Black tee, big white block letters with the punchline.",
      },
      comparables: [
        { name: "Hacks", kind: "tv_show", idea: 0 },
        { name: "Threadless", kind: "brand", idea: 0 },
        { name: "SmartLess", kind: "podcast", idea: 1 },
        { name: "Only Murders in the Building", kind: "tv_show", idea: 1 },
        { name: "Comedy Bang! Bang!", kind: "podcast", idea: 2 },
        { name: "Wet Leg", kind: "artist", idea: 2 },
      ],
      candidateTags: ["comedy", "indie", "zine", "stickers", "podcast fans"],
      groundedListing: {
        title: "Inside-Joke Tour Tee – Small Run, Hand-Drawn Print",
        tags: ["comedy tee", "tour shirt", "inside joke", "hand drawn", "small run", "indie comedy", "podcast fan gift"],
        description: "The joke only the people in the room get, drawn by hand on a soft tee from a small print run. Fans wear the line they quote back, not a logo.",
        coverDirection: "Same tee, now a hand-drawn line of the joke in a small chest print instead of big block letters.",
      },
    },
  },
];

export function getScenario(id: string | null | undefined): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}
