"use client";

import { useState, type ReactNode } from "react";
import type { Claim } from "@/lib/claims";
import { provenanceLines } from "@/lib/provenance";
import { joinRisks } from "@/lib/practical";
import { readable } from "@/lib/readable";
export { readable };
import { RANK_FORMULA } from "@/lib/rules";
import { AGE_BANDS, ASSUMPTION_LABELS, type AssumptionVerdict, type IdeaScore, type ListingDraft, type RunState } from "@/lib/types";

function number(value: number, digits = 2) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value) : "—";
}
function shown(value: unknown): string {
  return typeof value === "number" ? number(value, 3) : readable(String(value ?? "—"));
}
/** Display only: readable text that starts with a capital letter and uses US spelling. */
function say(text: string): string {
  const t = readable(text).replace(/neighbour\(s\)/g, "neighbors").replace(/neighbour/g, "neighbor");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function plural(n: number, one: string, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

function signed(v: number) { return `${v > 0 ? "+" : v < 0 ? "−" : ""}${number(Math.abs(v), 3)}`; }
function bandName(b: string) { return b.replace(/^(\d+)_to_(\d+)$/, "$1–$2").replace(/^(\d+)_and_older$/, "$1+").replace(/_/g, " "); }
/** Display only: a stored evidence field reads as a short phrase; the stored field and value are unchanged. */
export function evidenceParts(field: string, value: unknown): { name: string; value: string; skew?: number } {
  const n = typeof value === "number" ? value : undefined;
  const [head, ...rest] = field.split("."); const tail = rest.join(".");
  if (head === "age" && tail && n !== undefined) return { name: `Ages ${bandName(tail)}`, value: `${signed(n)} vs avg`, skew: n };
  if (head === "gender" && (tail === "female" || tail === "male") && n !== undefined) return { name: tail === "female" ? "Women" : "Men", value: `${signed(n)} vs avg`, skew: n };
  if (field === "query.affinity") return { name: "Taste affinity", value: shown(value) };
  if (field === "query.velocity" && n !== undefined) return { name: "Trend velocity", value: signed(n) };
  if (head === "heatmap" && tail) return { name: `Region · ${tail}`, value: shown(value) };
  if (field === "results.tags.name") return { name: "Qloo style tag", value: shown(value) };
  if (field === "tags.style.total") return { name: "Style tags for these fans", value: shown(value) };
  const tagName = (t: string) => t.replace(/[\s,.;:]+$/, "");
  if (head === "tags" && tail.endsWith(".rank")) return { name: `Rank · ${tagName(tail.slice(0, -5))}`, value: `#${shown(value)}` };
  if (head === "tags" && tail) return { name: `Taste tag · ${tagName(tail.replace(/\.affinity$/, ""))}`, value: shown(value) };
  if ((head === "affinity" || head === "velocity") && tail) return { name: `${head === "affinity" ? "Affinity" : "Trend"} · ${tail}`, value: n !== undefined && head === "velocity" ? signed(n) : shown(value) };
  return { name: say(field), value: shown(value) };
}
function EvidenceChip({ callId, field, value }: { callId: string; field: string; value: unknown }) {
  const e = evidenceParts(field, value);
  return <CallChip callId={callId} label={`${e.name}: ${e.value}`}><span className="ev-name">{e.name}</span>{e.skew !== undefined && Math.abs(e.skew) <= 1 && <span className="ev-bar" aria-hidden="true"><span className={e.skew < 0 ? "is-neg" : "is-pos"} style={e.skew < 0 ? { right: "50%", width: `${Math.abs(e.skew) * 50}%` } : { left: "50%", width: `${e.skew * 50}%` }} /></span>}<span className="ev-value">{e.value}</span></CallChip>;
}
/** The app opens Evidence; its target row is expanded before keyboard focus moves to it. */
function CallChip({ callId, label, children }: { callId: string; label?: string; children?: ReactNode }) {
  return <a href={`#call-${callId}`} className="evidence-link"
    aria-label={`View evidence ${callId}${label ? `: ${label}` : ""}`}
    onClick={(e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("pretaste:receipt", { detail: callId }));
      let attempts = 0;
      const reveal = () => {
        const target = document.getElementById(`call-${callId}`);
        if (!target) {
          if (attempts++ < 20) window.setTimeout(reveal, 50);
          return;
        }
        if (target instanceof HTMLDetailsElement) target.open = true;
        let parent = target.parentElement;
        while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus({ preventScroll: true });
      };
      window.setTimeout(reveal, 50);
    }}>{children ? <>{children}<span className="ev-call">call ›</span></> : <span className="ev-call ev-only">View call ›</span>}</a>;
}

export function Claims({ claims }: { claims: Claim[] }) {
  if (!claims.length) return null;
  return <ul className="claim-list">{claims.map(c => <li key={c.id}>
    <p><span className={`claim-kind claim-${c.kind === "qloo" ? "qloo" : "interpretation"}`}>{c.kind === "qloo" ? "Recorded signal" : "Interpretation"}</span>{say(c.text)}</p>
    {!!c.evidence.length && <div className="chip-row">{c.evidence.map((e, i) => <EvidenceChip key={i} callId={e.callId} field={e.field} value={e.value} />)}</div>}
  </li>)}</ul>;
}
function Bar({ value, max = 1, tone = "bar-accent" }: { value: number; max?: number; tone?: string }) {
  const width = Number.isFinite(value) && max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return <div aria-hidden="true" className="bar-track"><div className={`bar-fill ${tone}`} style={{ width: `${width}%` }} /></div>;
}
function SignedBar({ value }: { value: number }) {
  const width = Number.isFinite(value) ? Math.min(1, Math.abs(value)) * 50 : 0;
  return <div aria-hidden="true" className="bar-track bar-signed"><div className="bar-zero" /><div className={`bar-fill ${value >= 0 ? "bar-pos" : "bar-neg"}`} style={value >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }} /></div>;
}
const CALL_LABELS = { make: "Research first", fix: "Revise, then research", skip: "Lower research priority", hold: "Hold · more evidence needed" } as const;
const PART_LABELS: Record<string, string> = { affinity: "Taste affinity", trend: "Trend momentum", found: "Comparable coverage", overlap: "Similarity to your other ideas" };
export const VERDICT_WORD = { supported: "Supported", refuted: "Challenged", unverifiable: "Not established" } as const;
function Verdict({ v }: { v: keyof typeof VERDICT_WORD }) {
  return <span className={`verdict-chip verdict-${v}`}>{VERDICT_WORD[v]}</span>;
}
function strongestWeakest(r: IdeaScore): string {
  const parts = Object.entries(r.parts).filter(([k]) => k !== "overlap" && !r.missing?.includes(k)).sort((a, b) => b[1] - a[1]);
  if (!parts.length) return "No comparable signal available to rank this idea.";
  return `Strongest signal: ${PART_LABELS[parts[0][0]] ?? parts[0][0]} (${number(parts[0][1])}).${parts.length > 1 ? ` Weakest: ${PART_LABELS[parts.at(-1)![0]] ?? parts.at(-1)![0]} (${number(parts.at(-1)![1])}).` : ""}`;
}
export function Notice({ tone, label, children }: { tone: "synthetic" | "info" | "error"; label: string; children: ReactNode }) {
  return <div role={tone === "error" ? "alert" : "status"} className={`notice notice-${tone}`}><span className="notice-label">{label}.</span> {children}</div>;
}
function ScreenHead({ title, children }: { title: string; children: ReactNode }) {
  return <div className="screen-head"><h2>{title}</h2><p>{children}</p></div>;
}
/** One plain sentence a first-time visitor can read: what was guessed, what the signal said instead. */
export function plainWhy(v: AssumptionVerdict): string {
  const guessed = readable(v.assumed);
  const ev = v.claims.flatMap(c => c.evidence);
  const held = v.stability?.held ? ` This holds with any one of the ${v.stability.comparables} comparables left out.` : "";
  if (v.field === "age") {
    const [mine, rest] = v.claims.filter(c => c.kind === "qloo").map(c => c.evidence.filter(e => e.field.startsWith("age.") && typeof e.value === "number"));
    const mean = (xs?: typeof ev) => xs?.length ? xs.reduce((s, e) => s + (e.value as number), 0) / xs.length : undefined;
    const gap = mean(mine) !== undefined && mean(rest) !== undefined ? Math.round((mean(mine)! - mean(rest)!) * 100) / 100 : undefined;
    const top = ev.filter(e => e.field.startsWith("age.") && typeof e.value === "number").sort((a, b) => (b.value as number) - (a.value as number))[0];
    const band = top ? readable(top.field.slice(4)) : null;
    const side = (gap ?? 0) < 0 ? "lower" : "higher";
    const lead = gap !== undefined ? `Fans of the comparables score ${Math.abs(gap)} ${side} in those ages than in the other age groups` : `Fans of the comparables score ${side} in those ages than in the other age groups`;
    return `You guessed ${guessed}. ${lead}${band && !guessed.includes(band) ? `; the highest-scoring group is ${band}` : ""}.${held}`;
  }
  if (v.field === "gender") {
    const f = ev.find(e => e.field === "gender.female")?.value;
    if (typeof f === "number") return `You guessed ${v.assumed === "neutral" ? "no gender lean" : `mostly ${guessed === "female" ? "women" : guessed === "male" ? "men" : guessed}`}. Qloo's comparable audience leans toward ${f < 0 ? "men" : "women"}.${held}`;
  }
  const reason = readable(v.reason);
  if (v.field === "aesthetic") return /guessed/i.test(reason) ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : `You guessed a ${guessed} look. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
  return `${ASSUMPTION_LABELS[v.field]}: guessed ${guessed}. ${reason}`;
}
export function changeSummary(run: RunState) {
  const before = run.blindListing, after = run.groundedListing;
  if (!before || !after) return null;
  const verdicts = run.verdicts ?? [];
  const refuted = verdicts.filter(v => v.verdict === "refuted");
  const receipts = (run.groundedClaims ?? []).filter(c => c.kind === "qloo" && c.evidence.length).length;
  const rank = run.ranking?.find(r => r.idea === run.focusIdea);
  const why = refuted.length ? refuted.slice(0, 3).map(plainWhy) : [`No guess was challenged by the available signal. ${verdicts.filter(v => v.verdict === "unverifiable").length} assumptions remain not established. The rewrite cites ${receipts} recorded Qloo ${receipts === 1 ? "claim" : "claims"}.`];
  return { before, after, why, more: Math.max(0, refuted.length - 3), call: rank?.call ? `${CALL_LABELS[rank.call]}: ${readable(rank.callReason ?? "")}` : null, noModel: run.sources[0] === "rules", hasEvidence: receipts > 0 };
}
function firstEvidence(run: RunState, v?: AssumptionVerdict) {
  const ev = v?.claims.filter(c => c.kind === "qloo").flatMap(c => c.evidence).filter(e => run.calls.some(c => c.callId === e.callId)) ?? [];
  // For age the verdict rests on the mean of the guessed bands; show the guessed band that leans furthest
  // in the verdict's direction, never the strongest-band aside or a band that points the other way.
  if (v?.field === "age" && v.verdict !== "unverifiable") {
    const guessed = v.claims.find(c => c.kind === "qloo")?.evidence ?? [];
    const bands = guessed.filter(e => typeof e.value === "number" && run.calls.some(c => c.callId === e.callId));
    const pick = [...bands].sort((a, b) => (v.verdict === "refuted" ? 1 : -1) * ((a.value as number) - (b.value as number)))[0];
    if (pick) return pick;
  }
  return ev[0];
}
// Small words are never highlighted on their own.
const MINOR = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "to", "with", "at", "by", "from"]);
/** Display only: words in the after title that the before title does not use. */
function MarkedTitle({ before, after }: { before: string; after: string }) {
  const key = (w: string) => { const k = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); return k.length > 3 && k.endsWith("s") && !k.endsWith("ss") ? k.slice(0, -1) : k; };
  const seen = new Set(before.split(/\s+/).map(key).filter(Boolean));
  // Consecutive new words share one highlight.
  const out: ReactNode[] = []; let run: string[] = [];
  const flush = () => { if (!run.length) return; const ws = run[run.length - 1].trim() ? "" : run.pop()!; out.push(<mark key={out.length}>{run.join("")}</mark>); if (ws) out.push(ws); run = []; };
  for (const w of after.split(/(\s+)/)) {
    if (!w.trim()) { if (run.length) run.push(w); else out.push(w); }
    else if (key(w) && !seen.has(key(w)) && !MINOR.has(key(w))) run.push(w);
    else { flush(); out.push(w); }
  }
  flush();
  return <>{out}</>;
}
export function ChangeSummary({ run }: { run: RunState }) {
  const s = changeSummary(run);
  if (!s) return null;
  const verdicts = run.verdicts ?? [];
  const checked = verdicts.filter(v => v.verdict !== "unverifiable");
  const challenged = checked.filter(v => v.verdict === "refuted");
  const supported = checked.filter(v => v.verdict === "supported");
  const rows = challenged.length ? challenged.slice(0, 3).map(v => ({ key: v.field, field: ASSUMPTION_LABELS[v.field], text: plainWhy(v), ev: firstEvidence(run, v) })) : [{ key: "none", field: checked.length ? "Checked" : "Open", text: s.why[0], ev: undefined }];
  const alsoLiked = [...(run.neighbors ?? [])].filter(n => n.affinity > 0).sort((a, b) => b.affinity - a.affinity).slice(0, 3);
  const open = verdicts.length - checked.length;
  const openText = open ? `; ${open} could not be checked` : "";
  const headline = challenged.length
    ? `${challenged.length === checked.length ? `All ${checked.length} checkable` : `${challenged.length} of ${checked.length} checkable`} audience guesses challenged by Qloo${openText}`
    : checked.length ? `${checked.length} of ${verdicts.length} audience guesses have a Qloo signal${openText}` : "No audience guess could be checked yet";
  const styleTags = (run.tasteTags?.tags ?? []).filter(t => t.kind === "style");
  const afterWords = [s.after.title, ...(s.after.tags ?? [])].join(" ");
  // A style tag counts as the source of a new word only when the whole tag name appears in the after draft and not in the before.
  const words = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const beforeWords = words([s.before.title, ...(s.before.tags ?? [])].join(" "));
  const backed = styleTags.filter(t => { const k = words(t.name); return k.trim().length > 2 && words(afterWords).includes(k) && !beforeWords.includes(k); }).slice(0, 4);
  return <section aria-label="Your taste research, at a glance" className="summary">
    <div className="summary-head"><div className="summary-title"><p className="summary-idea">Idea {run.focusIdea + 1} · {run.input.ideas[run.focusIdea]}</p><h2>{headline}</h2><p className="summary-sub">Taste signals guide your next experiment; they do not predict purchases.</p></div>
</div>
    <ol className="guess-strip" aria-label={`All ${verdicts.length} guesses: ${challenged.length} challenged, ${supported.length} supported, ${verdicts.length - checked.length} not established`}>{verdicts.map(v => <li key={v.field} className={`guess guess-${v.verdict}`}><span className="guess-field">{ASSUMPTION_LABELS[v.field]}</span><span className="guess-word">{VERDICT_WORD[v.verdict]}</span></li>)}</ol>
    <div className="summary-finding"><p className="summary-label">{challenged.length ? "The reason to rethink" : "What the check established"}</p><ul>{rows.map(r => <li key={r.key}><span className="summary-field">{r.field}</span><p>{r.text}</p>{r.ev && <EvidenceChip callId={r.ev.callId} field={r.ev.field} value={r.ev.value} />}</li>)}</ul></div>
    {alsoLiked.length > 0 && <div className="summary-also"><p className="summary-label">Fans also like</p><p>Titles Qloo ties most strongly to fans of these comparables: {alsoLiked.map((n, i) => <span key={n.entityId}>{i ? ", " : ""}<strong>{n.name.replace(/\s*\([^()]*#\s*\d[^()]*\)\s*$/, "")}</strong> <span className="p-muted">({n.kind.replace("urn:entity:", "").replaceAll("_", " ")})</span></span>)}. Candidates for ad targeting and comparison keywords, not proof of buyers.</p><CallChip callId={alsoLiked[0].callId} /></div>}
    <div className="summary-drafts">{[{ label: s.noModel ? "Before · your original words" : "Before · model assumptions", draft: s.before }, { label: s.hasEvidence ? "After · informed by taste signals" : "After · draft awaiting evidence", draft: s.after }].map((item, i) => <div key={i} className={i ? "draft-after" : "draft-before"}><p className="summary-label">{item.label}</p><p className="draft-title">{i && item.draft.title && s.before.title ? <MarkedTitle before={s.before.title} after={item.draft.title} /> : item.draft.title || "Title withheld · generic wording needed"}</p>{!!item.draft.tags?.length && <p className="draft-tags">{item.draft.tags.slice(0, 7).map((t, k) => i && !s.before.tags.some(b => b.toLowerCase() === t.toLowerCase()) ? <mark key={k}>{t}</mark> : <span key={k}>{t}</span>)}</p>}{i === 1 && s.hasEvidence && challenged.length > 0 && <p className="draft-why">Rewritten after Qloo challenged: {challenged.map(v => ASSUMPTION_LABELS[v.field]).join(", ")}.{backed.length ? <> New words taken from Qloo style tags for these fans: {backed.map((t, k) => <span key={t.name}>{k ? ", " : ""}<span className="tag-cite">{t.name}</span></span>)}. The rest is the writer&apos;s wording.</> : " The new words are the writer's wording, not Qloo tags."}</p>}</div>)}</div>
    {(s.more > 0 || s.call) && <div className="summary-next">{s.call && <p><span className="summary-label">Next step</span><span className="summary-call">{s.call}</span></p>}{s.more > 0 && <p className="summary-label">{plural(s.more, "more challenged assumption")} in the Assumptions tab.</p>}</div>}
  </section>;
}
export function VerdictScreen({ run }: { run: RunState }) {
  const verdicts = run.verdicts ?? [];
  const checked = verdicts.filter(v => v.verdict !== "unverifiable"), open = verdicts.filter(v => v.verdict === "unverifiable");
  return <section className="screen"><MakerAssumptionChecks run={run} /><ScreenHead title="What the evidence changes">Checks concern the audience of this idea’s comparables. Supported means consistent with a signal; not established means the data could not decide.</ScreenHead>
    {checked.length > 0 ? <div className="card-grid">{[...checked].sort((a,b) => Number(b.verdict === "refuted") - Number(a.verdict === "refuted")).map(v => <VerdictCard key={v.field} v={v} />)}</div> : <div className="p-panel"><h3>There is not enough signal for a finding yet.</h3><p className="p-muted">Review comparable coverage in Ideas ranked, then try more specific comparable references.</p></div>}
    {!!open.length && <details className="p-panel p-detail"><summary>Open questions <span className="p-muted">· {plural(open.length, "assumption")} not established</span></summary><p className="p-muted">Missing evidence is not a contradiction. Expand each field to see what could and could not be checked.</p><div className="open-list">{open.map(v => <details key={v.field} className="open-item"><summary>{ASSUMPTION_LABELS[v.field]} <span className="p-muted">· not established</span></summary><div className="stack"><p><span className="p-muted">Initial assumption: </span>{readable(v.assumed)}</p><p className="p-muted">{say(v.reason)}</p><Claims claims={v.claims} /></div></details>)}</div></details>}
  </section>;
}
function VerdictCard({ v }: { v: AssumptionVerdict }) {
  return <article className={`p-panel verdict-card card-${v.verdict}`}><div className="card-top"><h3>{ASSUMPTION_LABELS[v.field]}</h3><Verdict v={v.verdict} /></div><p className="assumed"><span className="p-muted">LLM guessed </span>{readable(v.assumed)}</p><p>{say(v.reason)}</p><details className="p-detail inline-detail"><summary>Inspect evidence · {plural(v.claims.length, "claim")}</summary><Claims claims={v.claims} /></details></article>;
}
function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState("Copy listing");
  return <button type="button" className="button-secondary button-small" aria-live="polite" onClick={() => { navigator.clipboard.writeText(text).then(() => { setStatus("Copied"); window.setTimeout(() => setStatus("Copy listing"), 1800); }).catch(() => setStatus("Copy unavailable · select the text")); }}>{status}</button>;
}
function Listing({ title, l }: { title: string; l?: ListingDraft }) {
  if (!l) return <p className="p-muted">No draft is available for this selected idea.</p>;
  return <article className="listing"><p className="card-meta">{title}</p><h3 className="listing-title">{l.title || "Title withheld · generic wording needed"}</h3><p className="listing-body">{l.description || "Description withheld · generic wording needed"}</p><div className="tag-row">{l.tags.map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}</div>{l.coverDirection && <details className="p-detail inline-detail"><summary>Cover direction · interpretation</summary><p className="p-muted">{l.coverDirection}</p></details>}{l.title && l.description ? <CopyButton text={[l.title, "", l.description, "", l.tags.join(", ")].join("\n")} /> : <p className="warn-text">Complete the withheld fields with generic wording before publishing.</p>}</article>;
}
export function CompareScreen({ run, qlooOff, setQlooOff }: { run: RunState; qlooOff: boolean; setQlooOff: (b: boolean) => void }) {
  const claims = qlooOff ? [] : run.groundedClaims ?? [], count = claims.filter(c => c.kind === "qloo" && c.evidence.length).length;
  return <section className="screen"><ScreenHead title="From a guess to a direction">Two drafts of the same product, idea {run.focusIdea + 1}. Taste-informed copy still needs a real customer test.</ScreenHead><label className="toggle-row"><input type="checkbox" checked={qlooOff} onChange={e => setQlooOff(e.target.checked)} /><span><strong>Hide the Qloo version</strong><span className="p-muted">Show the before draft in both columns, to compare without taste signals.</span></span></label>
    <div className="card-grid"><div className="p-panel"><Listing title={run.sources[0] === "rules" ? "Before · your words" : "Before · model only"} l={run.blindListing} /></div><div className={`p-panel ${qlooOff ? "" : "panel-accent"}`}><Listing title={qlooOff ? "After · Qloo off, original draft" : count ? "After · taste-informed" : "After · draft awaiting evidence"} l={qlooOff ? run.blindListing : run.groundedListing} /><div className="panel-foot"><p><strong>{count} recorded {count === 1 ? "claim" : "claims"} behind this draft</strong></p><p className="p-muted">A recorded taste signal is not proof of product demand.</p>{!!claims.length && <details className="p-detail inline-detail"><summary>Read claims and sources</summary><Claims claims={claims} /></details>}</div></div></div>
    {!qlooOff && run.checker && <details className="p-panel p-detail"><summary>Evidence checker · {run.checker.downgraded} downgraded, {run.checker.dropped} removed, {run.checker.listingFixes ?? 0} copy fixes</summary><ul className="note-list">{run.checker.notes.map((n,i) => <li key={i}>{n}</li>)}</ul></details>}
  </section>;
}
export function practicalLines(run: RunState): string[] {
  const p = run.practical;
  if (!p || (!p.ideas.length && !p.tieBreak)) return [];
  const out = ["", "## Outside the data", "", "General knowledge from the model, not checked against Qloo or any data.", ""];
  if (p.tieBreak) out.push(`- Too close to call on the data. Where to start: Idea ${p.tieBreak.idea + 1} — ${p.tieBreak.why}`);
  for (const it of p.ideas) out.push(`- Idea ${it.idea + 1}${it.priceFit ? ` — price: ${it.priceFit}` : ""}${it.risks.length ? ` — risks: ${joinRisks(it.risks)}` : ""}`);
  return out;
}
export function WhatToMakeScreen({ run }: { run: RunState }) {
  const ranking = run.ranking ?? [];
  return <section className="screen"><ScreenHead title="Where to research next">Research priority from comparable taste signals. These scores do not estimate sales, demand, or the chance of success.</ScreenHead><ol className={`rank-grid rank-${Math.min(3, ranking.length)}`}>{ranking.map((r,i) => {
    const resolved = (run.resolved ?? []).filter(x => x.idea === r.idea), found = resolved.filter(x => x.entityId).length;
    const ids = new Set(resolved.map(x => x.entityId)), trends = (run.trends ?? []).filter(t => ids.has(t.entityId));
    return <li key={r.idea} className={`p-panel rank-card ${r.idea === run.focusIdea ? "panel-accent" : ""}`}><div className="card-top"><span className="card-meta">{r.unranked ? "Not ranked" : `Rank ${i + 1}`} · idea {r.idea + 1}</span>{r.idea === run.focusIdea && <span className="tag-soft">Selected for deeper checks</span>}</div><h3 className="rank-title">{run.input.ideas[r.idea]}</h3>{r.unranked ? <div className="score"><span className="score-num">–</span><span className="p-muted">no taste signal to score</span></div> : <div className="score"><span className="score-num">{number(r.score * 100, 1)}</span><span className="p-muted">/ 100 research priority</span></div>}<div className={`call-box call-${r.call ?? "none"}`}><p className="call-word">{r.call ? CALL_LABELS[r.call] : r.onHold ? "Hold · incomplete evidence" : r.dontMake ? "Lower research priority" : "Explore this direction"}</p><p>{say(r.callReason ?? r.dontMakeReason ?? "Use these signals to design your next customer experiment.")}</p></div><p className="p-muted small">{found} / {resolved.length} planned comparables found{r.onHold ? " · coverage incomplete" : ""}</p>{r.robust && r.call !== "hold" && <p className="p-muted small robust-line">Stays first in {r.robust.held} of {r.robust.of} nearby weightings (each weight moved by 0.1)</p>}<details className="p-detail inline-detail"><summary>Score breakdown and sources</summary><div className="stack">{Object.entries(r.parts).map(([k,v]) => <div key={k}><div className="bar-label"><span>{PART_LABELS[k] ?? k}</span><span className="num">{r.missing?.includes(k) ? "No signal" : number(v)}</span></div><Bar value={r.missing?.includes(k) ? 0 : v} tone={k === "overlap" ? "bar-warn" : "bar-accent"} /></div>)}<p className="p-muted small">{strongestWeakest(r)}</p><ul className="source-list">{resolved.map((c,j) => <li key={j}><span>{c.resolvedName ?? c.name} · {c.entityId ? "found" : c.status?.replaceAll("_", " ") ?? "not found"}</span>{c.callId && <CallChip callId={c.callId} />}</li>)}</ul>{!!trends.length && <ul className="source-list">{trends.map(t => <li key={t.entityId}><span>{t.name}: {t.velocity > 0 ? "+" : ""}{number(t.velocity)} weekly percentile change</span><CallChip callId={t.callId} /></li>)}</ul>}</div></details></li>;
  })}</ol><details className="p-panel p-detail"><summary>How research priority is calculated</summary><p className="formula">{ranking[0]?.formula ?? RANK_FORMULA}</p><p className="p-muted small">Fixed rules, with no model in the ranking loop. Missing signals contribute zero; missing evidence can lower the score. The display rescales the raw score by 100.</p></details>
    {!!run.compare?.length && <div className="p-panel"><h3>How distinct are your ideas?</h3><p className="p-muted small">Shared taste tags across comparables, not shared customers or buyer lists.</p><ul className="pair-list">{run.compare.map(c => <li key={`${c.ideaA}-${c.ideaB}`}><span>Idea {c.ideaA+1} and idea {c.ideaB+1} <strong>{number(c.overlap*100, 0)}% tag similarity</strong></span><CallChip callId={c.callId} /></li>)}</ul></div>}<PracticalBox run={run} /></section>;
}
function PracticalBox({ run }: { run: RunState }) {
  const p = run.practical;
  if (!p || (!p.ideas.length && !p.tieBreak)) return null;
  return <details className="p-panel p-detail panel-dashed"><summary>Practical considerations <span className="p-muted">· model interpretation</span></summary><p className="p-muted small">General knowledge, not checked against Qloo or other data. Use these as questions for your research.</p>{p.tieBreak && <p>Signals are too close to call. A practical starting point: idea {p.tieBreak.idea+1} — {p.tieBreak.why}</p>}<ul className="stack">{p.ideas.map(it => <li key={it.idea}><strong>Idea {it.idea+1}</strong>{it.priceFit && <p>Price consideration: {it.priceFit}</p>}{!!it.risks.length && <p className="p-muted">Questions / risks: {joinRisks(it.risks)}</p>}</li>)}</ul></details>;
}
export function WhoTheyAreScreen({ run }: { run: RunState }) {
  const neighbors = [...(run.neighbors ?? [])].sort((a,b) => b.affinity-a.affinity).slice(0,8), demo=run.demographics, regions=[...(run.heatmap ?? [])].sort((a,b)=>b.score-a.score).slice(0,5);
  return <section className="screen"><ScreenHead title="Who shares this taste">Audience signals for idea {run.focusIdea+1}: {run.input.ideas[run.focusIdea]}. These describe comparable audiences, not verified buyers of your product.</ScreenHead><div className="card-grid"><div className="p-panel"><h3>Connected by taste</h3><p className="p-muted small">Top affinity results, strongest first. Scores are relative affinities, not percentages of people.</p>{!neighbors.length && <p className="p-muted">No taste neighbors returned. More specific comparables may help.</p>}<ol className="neighbor-list">{neighbors.map((n,i) => <li key={n.entityId}><div className="bar-label"><span><span className="rank-num">{i+1}</span><strong>{n.name}</strong><span className="p-muted kind">{n.kind.replace("urn:entity:","").replaceAll("_"," ")}</span></span><span className="num">{number(n.affinity,3)}</span></div><Bar value={n.affinity} /><details className="inline-detail plain"><summary className="p-muted">Why this connection?</summary><p>Driven by: {n.drivenBy.join(", ") || "No explanation returned"}</p><CallChip callId={n.callId} /></details></li>)}</ol></div><div className="stack">{demo ? <div className="p-panel"><h3>Demographic affinity</h3><p className="p-muted small">Relative skew: −1 to +1. Zero is average affinity, not zero people.</p><ul className="bar-rows">{AGE_BANDS.filter(b => demo.age[b] !== undefined).map(b => <li key={b}><span>{b.replaceAll("_"," ")}</span><SignedBar value={demo.age[b] ?? 0} /><span className="num">{(demo.age[b] ?? 0)>0 ? "+" : ""}{number(demo.age[b] ?? 0)}</span></li>)}{Object.entries(demo.gender).map(([gender,v]) => <li key={gender}><span>{gender}</span><SignedBar value={v ?? 0} /><span className="num">{v>0 ? "+" : ""}{number(v)}</span></li>)}</ul><CallChip callId={demo.callId} /></div> : <div className="p-panel"><h3>Demographics remain open</h3><p className="p-muted">No demographic signal was returned for these comparables.</p></div>}{!!run.tasteTags?.tags.length && <div className="p-panel"><h3>Taste tags these fans share</h3><p className="p-muted small">Tags Qloo most ties to fans of the comparables across books, film, TV and music, strongest first. The aesthetic guess is checked against them.</p>{(["style", "topic"] as const).map(set => { const list = run.tasteTags!.tags.filter(t => (t.kind === "style") === (set === "style")).slice(0, 8); return !!list.length && <div key={set}><p className="summary-label">{set === "style" ? "Look and mood" : "What they watch and read about"}</p><ul className="tag-cloud">{list.map(t => <li key={t.name}><span>{t.name}</span></li>)}</ul><CallChip callId={list[0].callId} /></div>; })}</div>}{!!regions.length && <div className="p-panel"><h3>Regional affinity · US</h3><p className="p-muted small">Relative regional signal, not customer counts or a targeting guarantee.</p><ul className="bar-rows">{regions.map(r => <li key={r.region}><span>{r.region}</span><Bar value={r.score} max={Math.max(1,...regions.map(x=>x.score))} /><span className="num">{number(r.score,3)}</span></li>)}</ul><CallChip callId={regions[0].callId} /></div>}</div></div>{run.groundedListing?.coverDirection && <details className="p-panel p-detail panel-dashed"><summary>Creative direction <span className="p-muted">· the writer’s interpretation</span></summary><p>{run.groundedListing.coverDirection}</p><p className="p-muted small">The writer’s reading of the taste tags and connections above. Validate the visual direction with people before production.</p></details>}</section>;
}
export function MakerAssumptionChecks({ run }: { run: RunState }) {
  if (!run.input.ownAssumptions) return null;
  return <details className="p-panel p-detail"><summary>Your own assumptions <span className="p-muted">· idea {run.focusIdea+1}</span></summary><blockquote className="quote">{run.input.ownAssumptions}</blockquote><ul className="stack">{(run.makerAssumptionChecks ?? []).map((a,i) => <li key={i} className="stack-tight"><p><Verdict v={a.status === "cannot check" ? "unverifiable" : a.status === "contradicts" ? "refuted" : "supported"} /> {readable(a.text)}</p><p className="p-muted small">{a.reason}</p><div className="chip-row">{a.signals.map((s,j) => <EvidenceChip key={j} callId={s.callId} field={s.field} value={s.value} />)}</div></li>)}</ul></details>;
}
export function ReceiptsScreen({ run }: { run: RunState }) {
  const all = [...(run.verdicts ?? []).flatMap(v => v.claims.map(c => ({ c, where: ASSUMPTION_LABELS[v.field] }))), ...(run.groundedClaims ?? []).map(c => ({ c, where: "Taste-informed draft" }))];
  const qloo = all.filter(x => x.c.kind === "qloo").length, cached = run.calls.filter(c=>c.cached).length;
  return <section className="screen"><ScreenHead title="Every claim, with the call behind it">Inspect the recorded calls behind each claim. Evidence links throughout the report open the matching call below.</ScreenHead><dl className="stat-row">{[{ n:qloo, label:"Recorded claims" },{ n:all.length-qloo,label:"Interpretations" },{n:run.calls.length,label:"API calls"}].map(x=><div key={x.label}><dt>{x.label}</dt><dd>{x.n}</dd></div>)}</dl>
    {run.checker && <details className="p-panel p-detail"><summary>Claim quality checks <span className="p-muted">· {run.checker.downgraded} downgraded / {run.checker.dropped} removed / {run.checker.listingFixes ?? 0} copy fixes</span></summary><p className="p-muted small">Measured claims must cite a recorded value and identify its subject. Unsupported claims become interpretation; unbacked numbers are removed. Marketplace tag limits and listing measurements are checked too.</p><ul className="note-list">{run.checker.notes.map((n,i)=><li key={i}>{n}</li>)}</ul></details>}
    <details className="p-panel p-detail"><summary>Claims and their sources <span className="p-muted">· {qloo} recorded{all.length - qloo > 0 ? ` + ${all.length - qloo} ${all.length - qloo === 1 ? "interpretation" : "interpretations"}` : ""}</span></summary><ul className="claims-by-source">{all.map(({c,where},i)=><li key={`${where}-${c.id}-${i}`}><p className="card-meta">{where}</p><Claims claims={[c]} /></li>)}</ul></details>
    <div className="p-panel"><h3>Recorded calls <span className="p-muted">· {cached} from cache</span></h3><p className="p-muted small">Parameters are redacted. Expand a call to inspect its request metadata. “Cached” means this server already sent the identical request to Qloo in the last 7 days and reuses that live answer (kept in memory only); a new request always goes to Qloo.</p><div className="call-list">{run.calls.map(c=>{ const bad = c.status === "error" || (typeof c.status === "number" && c.status >= 400); return <details id={`call-${c.callId}`} tabIndex={-1} key={c.callId} className="call-row"><summary><span className="call-id">{c.callId}</span><span className="call-path">{c.path}</span><span className={`call-status ${bad ? "is-bad" : ""}`}>{c.status === "cache" ? "cached" : <>{c.status}{c.cached ? " · cached" : ""}</>} · {number(c.durationMs,0)} ms</span></summary><dl className="call-meta"><div><dt>Pipeline step / source</dt><dd>{c.step} / {c.source}</dd></div><div><dt>Request parameters (redacted)</dt><dd className="code-block">{JSON.stringify(c.params,null,2)}</dd></div>{!!c.warnings.length && <div><dt className="warn-text">Warnings</dt><dd>{c.warnings.join("; ")}</dd></div>}</dl></details>; })}</div></div>
    {!!run.decisions.length && <details className="p-panel p-detail"><summary>Agent decisions <span className="p-muted">· {run.decisions.length}</span></summary><ol className="note-list">{run.decisions.map((d,i)=><li key={i}><strong>Step {d.step} · {d.kind.replaceAll("_"," ")}</strong><p className="p-muted">{d.detail}</p></li>)}</ol></details>}
  </section>;
}

export function summaryMarkdown(run: RunState, synthetic: boolean): string {
  const lines: string[] = [];
  const ev = (c: Claim) =>
    c.evidence.length ? ` [${c.evidence.map((e) => `${e.callId} ${e.field}=${String(e.value)}`).join("; ")}]` : "";
  const claim = (c: Claim) => `${c.kind === "interpretation" ? "(interpretation) " : ""}${readable(c.text)}${ev(c)}`;
  lines.push(`# Pretaste summary`, "");
  if (synthetic) lines.push("> SYNTHETIC — not Qloo data. Numbers below were generated locally.", "");
  lines.push(`Ideas: ${run.input.ideas.map((x, i) => `${i + 1}) ${x}`).join(" · ")}`, `Marketplace: ${run.input.marketplace}`);
  if (run.input.priceUsd) lines.push(`Price: $${run.input.priceUsd}`);
  lines.push(`Verdicts, audience and listing are about idea ${run.focusIdea + 1}.`, "", "> Taste signals describe comparable audiences. They do not predict purchases or establish product demand. Scores indicate research priority only.", "");
  const change = changeSummary(run);
  if (change) {
    lines.push("## What changed", "", `- Before${change.noModel ? " (your words, no model)" : " (LLM only)"}: ${change.before.title}`, `- After (${change.hasEvidence ? "with recorded taste evidence" : "draft awaiting evidence"}): ${change.after.title}`);
    for (const w of change.why) lines.push(`- Why: ${w}`);
    if (change.call) lines.push(`- ${change.call}`);
    lines.push("");
  }
  if (run.input.ownAssumptions) {
    lines.push("## Your assumptions", "", run.input.ownAssumptions, "");
    for (const a of run.makerAssumptionChecks ?? []) {
      lines.push(`- **${a.status}**: ${a.text}. ${a.reason}`);
      for (const s of a.signals) lines.push(`  - ${s.field} = ${s.value} (${s.callId})`);
    }
    lines.push("");
  }
  lines.push("## Verdicts", "");
  for (const v of run.verdicts ?? []) {
    lines.push(`- **${ASSUMPTION_LABELS[v.field]}** — ${v.verdict}. Guessed: ${readable(v.assumed)}. ${readable(v.reason)}`);
    for (const c of v.claims) lines.push(`  - ${claim(c)}`);
  }
  lines.push("", "## Research priority", "", `Raw score = ${run.ranking?.[0]?.formula ?? RANK_FORMULA}. The on-screen priority score rescales this by 100.`, "");
  for (const r of run.ranking ?? []) {
    const parts = Object.entries(r.parts)
      .map(([k, v]) => `${PART_LABELS[k] ?? k} ${(r.missing ?? []).includes(k) ? "no data" : v}`)
      .join(", ");
    lines.push(
      `- ${r.unranked ? "not ranked (no taste signal)" : `${number(r.score * 100, 1)} / 100 research priority`} — ${run.input.ideas[r.idea]}${r.call ? ` — ${CALL_LABELS[r.call]}: ${readable(r.callReason ?? "")}` : r.dontMake ? ` — lower research priority: ${r.dontMakeReason}` : ""}${r.robust && r.call !== "hold" ? ` (stays first in ${r.robust.held} of ${r.robust.of} nearby weightings)` : ""}`,
      `  - ${parts}`,
    );
  }
  for (const c of run.compare ?? []) {
    lines.push(`- Idea ${c.ideaA + 1} ↔ Idea ${c.ideaB + 1}: ${Math.round(c.overlap * 100)}% of taste tags shared (${c.callId})`);
  }
  lines.push(...practicalLines(run));
  const neighbors = [...(run.neighbors ?? [])].sort((a, b) => b.affinity - a.affinity).slice(0, 8);
  if (neighbors.length) {
    lines.push("", "## Comparable audiences: connected by taste", "");
    for (const n of neighbors) lines.push(`- ${n.name} — affinity ${n.affinity} (${n.callId})`);
  }
  const regions = [...(run.heatmap ?? [])].sort((a, b) => b.score - a.score).slice(0, 5);
  if (regions.length) {
    lines.push("", "## Regional affinity (US; not customer counts)", "");
    for (const r of regions) lines.push(`- ${r.region} — ${r.score} (${r.callId})`);
  }
  const b = run.blindListing;
  if (b) lines.push("", "## Blind listing (LLM only)", "", `**${b.title}**`, "", b.description, "", `Tags: ${b.tags.join(", ")}`);
  const l = run.groundedListing;
  if (l) {
    lines.push("", "## Grounded listing", "", `**${l.title}**`, "", l.description, "", `Tags: ${l.tags.join(", ")}`, "", `Cover: ${l.coverDirection}`);
  }
  lines.push("", "## Receipts", "");
  for (const c of run.groundedClaims ?? []) lines.push(`- ${claim(c)}`);
  if (run.checker) {
    lines.push("", `Checker: ${run.checker.downgraded} downgraded, ${run.checker.dropped} dropped, ${run.checker.listingFixes ?? 0} listing fixes`);
    for (const n of run.checker.notes) lines.push(`- ${n}`);
  }
  if (run.decisions.length) {
    lines.push("", "## Agent decisions", "");
    for (const d of run.decisions) lines.push(`- step ${d.step} · ${d.kind}: ${d.detail}`);
  }
  lines.push(...provenanceLines(run));
  return lines.join("\n") + "\n";
}
