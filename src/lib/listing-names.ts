/** Deterministic protection for listing text; comparable names belong only in analysis. */
import type { ListingDraft, RunState } from "./types";

/** Include common abbreviations that cannot be derived reliably from canonical names. */
const ALIASES = [
  ["Dungeons & Dragons", "Dungeons and Dragons", "D&D", "DnD"],
  ["The Legend of Vox Machina", "Vox Machina"],
  ["Jurassic Park", "Jurassic World"],
];

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function contains(text: string, name: string): boolean {
  const haystack = words(text).join(" ");
  const needle = words(name).join(" ");
  return !!needle && (` ${haystack} `.includes(` ${needle} `) ||
    (needle.includes(" ") && words(text).some((w) => w === words(name).join(""))));
}

/** The maker's own idea text with quoted titles removed: words the maker wrote are not borrowed names. */
function makerWords(state: RunState): string {
  return (state.input?.ideas ?? []).join(" \n ").replace(/["“”][^"“”]*["“”]/g, " ");
}

export function listingNames(state: RunState): string[] {
  const names = [...(state.resolved ?? []).flatMap((r) => [r.name, r.resolvedName ?? ""]),
    ...(state.neighbors ?? []).map((n) => n.name)].filter(Boolean);
  names.push(...ALIASES.flat());
  // A comparable that happens to be a plain word the maker used (e.g. "Calm") must not blank the
  // maker's own listing. Quoted titles and multi-word names stay blocked: they are named works or
  // brands, not plain words.
  const own = makerWords(state);
  return [...new Set(names)].filter((name) => words(name).length > 1 || !contains(own, name));
}

function sentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [];
}

/**
 * Remove borrowed names from listing text without leaving the listing empty:
 * - title: replaced by the fallback (normally the idea as the maker wrote it) when it names a comparable;
 * - description: only the sentences that name a comparable are removed;
 * - tags: tags that name a comparable are dropped.
 * Every change leaves a note so the screen can say what was withheld and why.
 */
export function checkListingNames(
  listing: ListingDraft,
  names: string[],
  fallbackTitle = "",
): { listing: ListingDraft; notes: string[] } {
  const notes: string[] = [];
  const unsafe = (text: string) => names.some((name) => contains(text, name));
  let title = listing.title;
  if (unsafe(title)) {
    title = fallbackTitle && !unsafe(fallbackTitle) ? fallbackTitle : "";
    notes.push(`listing: title contained a comparable or brand name; ${title ? "replaced with the idea as you wrote it" : "withheld"}`);
  }
  let description = listing.description;
  if (unsafe(description)) {
    const parts = sentences(description);
    const kept = parts.filter((p) => !unsafe(p));
    description = kept.join("").trim();
    notes.push(`listing: ${parts.length - kept.length} description sentence(s) withheld because they named a comparable or brand`);
  }
  const tags = listing.tags.filter((tag) => {
    if (!unsafe(tag)) return true;
    notes.push("listing: tag withheld because it contains a comparable or brand name");
    return false;
  });
  return { listing: { ...listing, title, description, tags }, notes };
}
