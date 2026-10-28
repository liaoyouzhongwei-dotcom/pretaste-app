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

/** The app opens Receipts; its target row is expanded before keyboard focus moves to it. */
function CallChip({ callId, label }: { callId: string; label?: string }) {
  return <a href={`#call-${callId}`} className="p-chip inline-flex max-w-full items-center gap-1 break-all rounded-md px-2 py-1 text-xs underline decoration-current/30 underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2"
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
    }}>↗ {label ?? `Evidence ${callId}`}</a>;
}

export function Claims({ claims }: { claims: Claim[] }) {
  if (!claims.length) return null;
  return <ul className="space-y-3">{claims.map(c => <li key={c.id} className="space-y-1.5 text-sm leading-relaxed">
    <p><span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${c.kind === "qloo" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>{c.kind === "qloo" ? "Recorded signal" : "Interpretation"}</span>{readable(c.text)}</p>
    {!!c.evidence.length && <div className="flex flex-wrap gap-1">{c.evidence.map((e, i) => <CallChip key={i} callId={e.callId} label={`${readable(e.field)}: ${shown(e.value)}`} />)}</div>}
  </li>)}</ul>;
}
function Bar({ value, max = 1, tone = "bg-emerald-700" }: { value: number; max?: number; tone?: string }) {
  const width = Number.isFinite(value) && max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-stone-200"><div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} /></div>;
}
function SignedBar({ value }: { value: number }) {
  const width = Number.isFinite(value) ? Math.min(1, Math.abs(value)) * 50 : 0;
  return <div aria-hidden="true" className="relative h-2 rounded-full bg-stone-200"><div className="absolute inset-y-0 left-1/2 w-px bg-stone-500" /><div className={`absolute inset-y-0 rounded-full ${value >= 0 ? "bg-emerald-700" : "bg-orange-700"}`} style={value >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }} /></div>;
}
const CALL_LABELS = { make: "Research first", fix: "Revise, then research", skip: "Lower research priority", hold: "Hold · more evidence needed" } as const;
const PART_LABELS: Record<string, string> = { affinity: "Taste affinity", trend: "Trend momentum", found: "Comparable coverage", overlap: "Similarity to your other ideas" };
const VERDICT_LABELS = { supported: "✓ Supported", refuted: "↺ Challenged", unverifiable: "— Not established" } as const;
const VERDICT_TONE = { supported: "bg-emerald-50 text-emerald-900", refuted: "bg-orange-50 text-orange-900", unverifiable: "bg-stone-100 text-stone-600" } as const;
function strongestWeakest(r: IdeaScore): string {
  const parts = Object.entries(r.parts).filter(([k]) => k !== "overlap" && !r.missing?.includes(k)).sort((a, b) => b[1] - a[1]);
  if (!parts.length) return "No comparable signal available to rank this idea.";
  return `Strongest signal: ${PART_LABELS[parts[0][0]] ?? parts[0][0]} (${number(parts[0][1])}).${parts.length > 1 ? ` Weakest: ${PART_LABELS[parts.at(-1)![0]] ?? parts.at(-1)![0]} (${number(parts.at(-1)![1])}).` : ""}`;
}
const NOTICE_STYLE = { synthetic: "border border-amber-400 bg-amber-50 text-amber-950", info: "border border-stone-300 bg-stone-50 text-stone-800", error: "border border-red-300 bg-red-50 text-red-950" } as const;
export function Notice({ tone, label, children }: { tone: keyof typeof NOTICE_STYLE; label: string; children: ReactNode }) {
  return <div role={tone === "error" ? "alert" : "status"} className={`break-words rounded-xl px-4 py-3 text-sm leading-relaxed ${NOTICE_STYLE[tone]}`}><span className="font-semibold">{label}.</span> {children}</div>;
}
/** One plain sentence a first-time visitor can read: what was guessed, what the signal said instead. */
export function plainWhy(v: AssumptionVerdict): string {
  const guessed = readable(v.assumed);
  const ev = v.claims.flatMap(c => c.evidence);
  if (v.field === "age") {
    const top = ev.filter(e => e.field.startsWith("age.") && typeof e.value === "number").sort((a, b) => (b.value as number) - (a.value as number))[0];
    const band = top ? readable(top.field.slice(4)) : null;
    if (band && !guessed.includes(band)) return `You guessed ${guessed}. Qloo's comparable audience leans away from those ages; its strongest age group is ${band}.`;
    return `You guessed ${guessed}. Qloo's comparable audience leans away from those ages.`;
  }
  if (v.field === "gender") {
    const f = ev.find(e => e.field === "gender.female")?.value;
    if (typeof f === "number") return `You guessed ${v.assumed === "neutral" ? "no gender lean" : `mostly ${guessed === "female" ? "women" : guessed === "male" ? "men" : guessed}`}. Qloo's comparable audience leans toward ${f < 0 ? "men" : "women"}.`;
  }
  return `${ASSUMPTION_LABELS[v.field]}: guessed ${guessed}. ${readable(v.reason)}`;
}
export function changeSummary(run: RunState) {
  const before = run.blindListing, after = run.groundedListing;
  if (!before || !after) return null;
  const verdicts = run.verdicts ?? [];
  const refuted = verdicts.filter(v => v.verdict === "refuted");
  const receipts = (run.groundedClaims ?? []).filter(c => c.kind === "qloo" && c.evidence.length).length;
  const rank = run.ranking?.find(r => r.idea === run.focusIdea);
  const why = refuted.length ? refuted.slice(0, 2).map(plainWhy) : [`No guess was challenged by the available signal. ${verdicts.filter(v => v.verdict === "unverifiable").length} assumptions remain unestablished. The rewrite cites ${receipts} recorded Qloo ${receipts === 1 ? "claim" : "claims"}.`];
  return { before, after, why, more: Math.max(0, refuted.length - 2), call: rank?.call ? `${CALL_LABELS[rank.call]}: ${readable(rank.callReason ?? "")}` : null, noModel: run.sources[0] === "rules", hasEvidence: receipts > 0 };
}
export function ChangeSummary({ run }: { run: RunState }) {
  const s = changeSummary(run);
  if (!s) return null;
  const checked = (run.verdicts ?? []).filter(v => v.verdict !== "unverifiable");
  const challenged = checked.filter(v => v.verdict === "refuted");
  const primaryEvidence = challenged[0]?.claims.filter(c => c.kind === "qloo").flatMap(c => c.evidence).find(e => run.calls.some(c => c.callId === e.callId));
  return <section aria-label="Your taste research, at a glance" className="p-result-hero space-y-6 rounded-3xl p-5 sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-2xl"><p className="text-xs font-semibold uppercase tracking-[.16em] opacity-70">The taste check · idea {run.focusIdea + 1}</p><h2 className="mt-2 font-serif text-3xl leading-tight sm:text-4xl">{challenged.length ? "A useful reason to rethink." : checked.length ? "A clearer direction to explore." : "A starting point, with open questions."}</h2><p className="mt-3 text-sm leading-relaxed opacity-80">{challenged.length ? `${challenged.length} ${challenged.length === 1 ? "assumption was" : "assumptions were"} challenged by comparable-audience signals.` : checked.length ? `${checked.length} ${checked.length === 1 ? "assumption has" : "assumptions have"} a checkable signal.` : "The available data cannot establish your audience assumptions yet."} Taste signals guide your next experiment; they do not predict purchases.</p></div><span className="rounded-full border border-current/25 px-3 py-1.5 text-xs">{checked.length} / {(run.verdicts ?? []).length} assumptions checkable</span></div>
    <div className="p-panel min-w-0 space-y-3 rounded-2xl p-4 sm:p-5"><p className="p-eyebrow text-xs font-semibold uppercase tracking-wide">{challenged.length ? "The reason to rethink" : "What the check established"}</p><p className="break-words text-sm leading-relaxed">{s.why[0]}</p>{primaryEvidence && <CallChip callId={primaryEvidence.callId} label={`${readable(primaryEvidence.field)}: ${shown(primaryEvidence.value)}`} />}</div>
    <div className="grid gap-3 md:grid-cols-2">{[{ label: s.noModel ? "Before · your original words" : "Before · model assumptions", draft: s.before }, { label: s.hasEvidence ? "After · informed by taste signals" : "After · draft awaiting evidence", draft: s.after }].map((item, i) => <div key={i} className="p-panel min-w-0 rounded-2xl p-4 sm:p-5"><p className="p-eyebrow text-xs font-semibold uppercase tracking-wide">{item.label}</p><p className={`mt-2 break-words text-lg leading-snug ${i ? "font-semibold" : "opacity-70"}`}>{item.draft.title || "Title withheld · generic wording needed"}</p></div>)}</div>
    {(s.why.length > 1 || s.more > 0 || s.call) && <details className="p-detail text-sm"><summary className="cursor-pointer font-semibold">More context and next step</summary>{s.why.length > 1 && <ul className="mt-3 space-y-2">{s.why.slice(1).map((w, i) => <li key={i} className="break-words leading-relaxed">{w}</li>)}</ul>}{s.more > 0 && <p className="mt-2 opacity-70">{s.more} more challenged assumptions in the findings below.</p>}{s.call && <p className="mt-3 break-words font-semibold">{s.call}</p>}</details>}
  </section>;
}
export function VerdictScreen({ run }: { run: RunState }) {
  const verdicts = run.verdicts ?? [];
  const checked = verdicts.filter(v => v.verdict !== "unverifiable"), open = verdicts.filter(v => v.verdict === "unverifiable");
  return <section className="space-y-6"><MakerAssumptionChecks run={run} /><div className="section-heading"><div><p className="eyebrow">01 / Findings</p><h2 className="mt-1 font-serif text-3xl">What the evidence changes</h2></div><p className="muted max-w-xl text-sm">Checks concern the audience of this idea’s comparables. Supported assumptions are consistent with a signal; unestablished ones remain open.</p></div>
    <div className="grid grid-cols-3 gap-2">{[{ label: "Challenged", count: checked.filter(v => v.verdict === "refuted").length }, { label: "Supported", count: checked.filter(v => v.verdict === "supported").length }, { label: "Not established", count: open.length }].map(item => <div key={item.label} className="p-panel rounded-2xl border p-3 sm:p-5"><p className="font-serif text-3xl">{item.count}</p><p className="p-muted mt-1 text-xs sm:text-sm">{item.label}</p></div>)}</div>
    {checked.length > 0 ? <div className="grid items-start gap-4 md:grid-cols-2">{[...checked].sort((a,b) => Number(b.verdict === "refuted") - Number(a.verdict === "refuted")).map(v => <VerdictCard key={v.field} v={v} />)}</div> : <div className="p-panel rounded-2xl border p-5"><h3 className="font-semibold">There is not enough signal for a finding yet.</h3><p className="p-muted mt-2 text-sm">Review comparable coverage in Research priority, then try more specific comparable references.</p></div>}
    {!!open.length && <details className="p-panel p-detail rounded-2xl border p-4 sm:p-5"><summary className="cursor-pointer font-semibold">Open questions <span className="p-muted font-normal">· {open.length} assumptions not established</span></summary><p className="p-muted mt-2 text-sm">Missing evidence is not a contradiction. Expand each field to see what could and could not be checked.</p><div className="mt-4 space-y-2">{open.map(v => <details key={v.field} className="rounded-xl border p-3"><summary className="cursor-pointer text-sm font-semibold">{ASSUMPTION_LABELS[v.field]} <span className="p-muted font-normal">· not established</span></summary><div className="mt-3 space-y-3"><p className="text-sm"><span className="p-muted">Initial assumption: </span>{readable(v.assumed)}</p><p className="p-muted text-sm">{readable(v.reason)}</p><Claims claims={v.claims} /></div></details>)}</div></details>}
  </section>;
}
function VerdictCard({ v }: { v: AssumptionVerdict }) {
  return <article className="p-panel space-y-4 rounded-2xl border p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{ASSUMPTION_LABELS[v.field]}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${VERDICT_TONE[v.verdict]}`}>{VERDICT_LABELS[v.verdict]}</span></div><p className="text-sm leading-relaxed"><span className="p-muted">Initial assumption: </span>{readable(v.assumed)}</p><p className="text-sm leading-relaxed">{readable(v.reason)}</p><details className="p-detail border-t pt-3"><summary className="cursor-pointer text-xs font-semibold">Inspect evidence · {v.claims.length} claims</summary><div className="mt-3"><Claims claims={v.claims} /></div></details></article>;
}
function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState("Copy listing");
  return <button type="button" className="button-secondary mt-3 rounded-lg border px-3 py-2 text-xs" aria-live="polite" onClick={() => { navigator.clipboard.writeText(text).then(() => { setStatus("✓ Copied"); window.setTimeout(() => setStatus("Copy listing"), 1800); }).catch(() => setStatus("Copy unavailable · select the text")); }}>{status}</button>;
}
function Listing({ title, l }: { title: string; l?: ListingDraft }) {
  if (!l) return <p className="p-muted text-sm">No draft is available for this selected idea.</p>;
  return <article className="min-w-0"><p className="p-eyebrow text-xs font-semibold uppercase tracking-wide">{title}</p><h3 className="mt-3 break-words font-serif text-2xl leading-snug">{l.title || "Title withheld · generic wording needed"}</h3><p className="mt-4 whitespace-pre-line text-sm leading-7">{l.description || "Description withheld · generic wording needed"}</p><div className="mt-4 flex flex-wrap gap-1.5">{l.tags.map((t, i) => <span key={`${t}-${i}`} className="rounded-full border px-2.5 py-1 text-xs">{t}</span>)}</div>{l.coverDirection && <details className="p-detail mt-4 border-t pt-3"><summary className="cursor-pointer text-xs font-semibold">Cover direction · interpretation</summary><p className="p-muted mt-2 text-sm leading-relaxed">{l.coverDirection}</p></details>}{l.title && l.description ? <CopyButton text={[l.title, "", l.description, "", l.tags.join(", ")].join("\n")} /> : <p className="mt-3 text-xs text-orange-900">Complete the withheld fields with generic wording before publishing.</p>}</article>;
}
export function CompareScreen({ run, qlooOff, setQlooOff }: { run: RunState; qlooOff: boolean; setQlooOff: (b: boolean) => void }) {
  const claims = qlooOff ? [] : run.groundedClaims ?? [], count = claims.filter(c => c.kind === "qloo" && c.evidence.length).length;
  return <section className="space-y-5"><div className="section-heading"><div><p className="eyebrow">02 / The rewrite</p><h2 className="mt-1 font-serif text-3xl">From a guess to a direction</h2></div><p className="muted max-w-lg text-sm">Two drafts of the same product, idea {run.focusIdea + 1}. Taste-informed copy still needs a real customer test.</p></div><label className="p-panel flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm"><input className="mt-0.5 h-4 w-4 accent-emerald-800" type="checkbox" checked={qlooOff} onChange={e => setQlooOff(e.target.checked)} /><span><strong>Show the counterfactual: Qloo off</strong><span className="p-muted mt-1 block text-xs">Replace the after draft with the original, without taste signals.</span></span></label>
    <div className="grid items-start gap-4 lg:grid-cols-2"><div className="p-panel rounded-2xl border p-5 sm:p-6"><Listing title={run.sources[0] === "rules" ? "Before · your words" : "Before · model only"} l={run.blindListing} /></div><div className={`p-panel rounded-2xl border p-5 sm:p-6 ${qlooOff ? "" : "border-emerald-700/50"}`}><Listing title={qlooOff ? "After · Qloo off, original draft" : count ? "After · taste-informed" : "After · draft awaiting evidence"} l={qlooOff ? run.blindListing : run.groundedListing} /><div className="mt-5 border-t pt-4"><p className="text-sm font-semibold">{count} recorded {count === 1 ? "claim" : "claims"} behind this draft</p><p className="p-muted mt-1 text-xs">A recorded taste signal is not proof of product demand.</p>{!!claims.length && <details className="p-detail mt-3"><summary className="cursor-pointer text-xs font-semibold">Read claims and sources</summary><div className="mt-3"><Claims claims={claims} /></div></details>}</div></div></div>
    {!qlooOff && run.checker && <details className="p-panel p-detail rounded-xl border p-4 text-xs"><summary className="cursor-pointer font-semibold">Evidence checker · {run.checker.downgraded} downgraded, {run.checker.dropped} removed, {run.checker.listingFixes ?? 0} copy fixes</summary><ul className="mt-3 list-disc space-y-2 pl-4">{run.checker.notes.map((n,i) => <li key={i}>{n}</li>)}</ul></details>}
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
  return <section className="space-y-5"><div className="section-heading"><div><p className="eyebrow">03 / Compare ideas</p><h2 className="mt-1 font-serif text-3xl">Where to research next</h2></div><p className="muted max-w-lg text-sm">Research priority from comparable taste signals. These scores do not estimate sales, demand, or the chance of success.</p></div><ol className={`grid items-start gap-4 ${ranking.length > 1 ? "lg:grid-cols-2" : ""} ${ranking.length > 2 ? "xl:grid-cols-3" : ""}`}>{ranking.map((r,i) => {
    const resolved = (run.resolved ?? []).filter(x => x.idea === r.idea), found = resolved.filter(x => x.entityId).length;
    const ids = new Set(resolved.map(x => x.entityId)), trends = (run.trends ?? []).filter(t => ids.has(t.entityId));
    return <li key={r.idea} className={`p-panel min-w-0 space-y-4 rounded-2xl border p-5 ${r.idea === run.focusIdea ? "border-emerald-700/60" : ""}`}><div className="flex items-start justify-between gap-3"><span className="p-eyebrow text-xs font-semibold uppercase tracking-wide">Idea {r.idea + 1} · rank {i + 1}</span>{r.idea === run.focusIdea && <span className="p-chip rounded-full px-2 py-1 text-[10px] font-semibold">Selected for deeper checks</span>}</div><h3 className="break-words font-serif text-2xl leading-snug">{run.input.ideas[r.idea]}</h3><div className="flex items-baseline gap-2"><span className="font-serif text-4xl tabular-nums">{number(r.score * 100, 1)}</span><span className="p-muted text-xs">/ 100 research priority</span></div><div className={`rounded-xl p-3 text-sm ${r.call === "make" ? "bg-emerald-50 text-emerald-950" : "bg-stone-100 text-stone-800"}`}><p className="font-semibold">{r.call ? CALL_LABELS[r.call] : r.onHold ? "Hold · incomplete evidence" : r.dontMake ? "Lower research priority" : "Explore this direction"}</p><p className="mt-1 text-xs leading-relaxed">{readable(r.callReason ?? r.dontMakeReason ?? "Use these signals to design your next customer experiment.")}</p></div><p className="p-muted text-xs">{found} / {resolved.length} planned comparables found{r.onHold ? " · coverage incomplete" : ""}</p><details className="p-detail border-t pt-3"><summary className="cursor-pointer text-xs font-semibold">Score breakdown and sources</summary><div className="mt-4 space-y-3">{Object.entries(r.parts).map(([k,v]) => <div key={k}><div className="mb-1 flex justify-between gap-2 text-xs"><span>{PART_LABELS[k] ?? k}</span><span>{r.missing?.includes(k) ? "No signal" : number(v)}</span></div><Bar value={r.missing?.includes(k) ? 0 : v} tone={k === "overlap" ? "bg-orange-600" : "bg-emerald-700"} /></div>)}<p className="p-muted text-xs">{strongestWeakest(r)}</p><ul className="space-y-2">{resolved.map((c,j) => <li key={j} className="text-xs"><span>{c.resolvedName ?? c.name} · {c.entityId ? "found" : c.status?.replaceAll("_", " ") ?? "not found"}</span>{c.callId && <div className="mt-1"><CallChip callId={c.callId} /></div>}</li>)}</ul>{!!trends.length && <ul className="space-y-2 border-t pt-2">{trends.map(t => <li key={t.entityId} className="text-xs">{t.name}: {t.velocity > 0 ? "+" : ""}{number(t.velocity)} weekly percentile change <CallChip callId={t.callId} /></li>)}</ul>}</div></details></li>;
  })}</ol><details className="p-panel p-detail rounded-xl border p-4 text-xs"><summary className="cursor-pointer font-semibold">How research priority is calculated</summary><p className="mt-3 break-words font-mono">{ranking[0]?.formula ?? RANK_FORMULA}</p><p className="p-muted mt-2">Fixed rules, with no model in the ranking loop. Missing signals contribute zero; missing evidence can lower the score. The display rescales the raw score by 100.</p></details>
    {!!run.compare?.length && <div className="p-panel space-y-3 rounded-2xl border p-5"><h3 className="font-semibold">How distinct are your ideas?</h3><p className="p-muted text-xs">Shared taste tags across comparables, not shared customers or buyer lists.</p><ul className="space-y-3">{run.compare.map(c => <li key={`${c.ideaA}-${c.ideaB}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Idea {c.ideaA+1} ↔ Idea {c.ideaB+1} <strong className="ml-2">{number(c.overlap*100, 0)}% tag similarity</strong></span><CallChip callId={c.callId} /></li>)}</ul></div>}<PracticalBox run={run} /></section>;
}
function PracticalBox({ run }: { run: RunState }) {
  const p = run.practical;
  if (!p || (!p.ideas.length && !p.tieBreak)) return null;
  return <details className="p-panel p-detail rounded-2xl border border-dashed p-5"><summary className="cursor-pointer font-semibold">Practical considerations <span className="p-muted text-xs font-normal">· model interpretation</span></summary><p className="p-muted mt-3 text-xs">General knowledge, not checked against Qloo or other data. Use these as questions for your research.</p>{p.tieBreak && <p className="mt-3 text-sm">Signals are too close to call. A practical starting point: idea {p.tieBreak.idea+1} — {p.tieBreak.why}</p>}<ul className="mt-3 space-y-3 text-sm">{p.ideas.map(it => <li key={it.idea}><strong>Idea {it.idea+1}</strong>{it.priceFit && <p className="mt-1">Price consideration: {it.priceFit}</p>}{!!it.risks.length && <p className="p-muted mt-1">Questions / risks: {joinRisks(it.risks)}</p>}</li>)}</ul></details>;
}
export function WhoTheyAreScreen({ run }: { run: RunState }) {
  const neighbors = [...(run.neighbors ?? [])].sort((a,b) => b.affinity-a.affinity).slice(0,8), demo=run.demographics, regions=[...(run.heatmap ?? [])].sort((a,b)=>b.score-a.score).slice(0,5);
  return <section className="space-y-5"><div className="section-heading"><div><p className="eyebrow">04 / Audience signals</p><h2 className="mt-1 font-serif text-3xl">A taste constellation</h2></div><p className="muted max-w-lg text-sm">Audience signals for idea {run.focusIdea+1}: {run.input.ideas[run.focusIdea]}. These describe comparable audiences, not verified buyers of your product.</p></div><div className="grid items-start gap-4 lg:grid-cols-2"><div className="p-panel rounded-2xl border p-5"><h3 className="text-lg font-semibold">Connected by taste</h3><p className="p-muted mt-1 text-xs">Top affinity results, strongest first. Scores are relative affinities, not percentages of people.</p>{!neighbors.length && <p className="p-muted mt-5 text-sm">No taste neighbors returned. More specific comparables may help.</p>}<ol className="mt-5 space-y-4">{neighbors.map((n,i) => <li key={n.entityId}><div className="mb-2 flex justify-between gap-3 text-sm"><span><span className="p-muted mr-2 text-xs">{String(i+1).padStart(2,"0")}</span><strong>{n.name}</strong><span className="p-muted ml-2 text-xs">{n.kind.replace("urn:entity:","").replaceAll("_"," ")}</span></span><span className="tabular-nums">{number(n.affinity,3)}</span></div><Bar value={n.affinity} /><details className="p-detail mt-1.5 text-xs"><summary className="p-muted cursor-pointer">Why this connection?</summary><p className="my-2">Driven by: {n.drivenBy.join(", ") || "No explanation returned"}</p><CallChip callId={n.callId} /></details></li>)}</ol></div><div className="space-y-4">{demo ? <div className="p-panel rounded-2xl border p-5"><h3 className="text-lg font-semibold">Demographic affinity</h3><p className="p-muted mt-1 text-xs">Relative skew: −1 to +1. Zero is average affinity, not zero people.</p><ul className="my-5 space-y-3">{AGE_BANDS.filter(b => demo.age[b] !== undefined).map(b => <li key={b} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2 text-xs"><span>{b.replaceAll("_"," ")}</span><SignedBar value={demo.age[b] ?? 0} /><span className="text-right tabular-nums">{(demo.age[b] ?? 0)>0 ? "+" : ""}{number(demo.age[b] ?? 0)}</span></li>)}{Object.entries(demo.gender).map(([gender,v]) => <li key={gender} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2 text-xs"><span>{gender}</span><SignedBar value={v ?? 0} /><span className="text-right tabular-nums">{v>0 ? "+" : ""}{number(v)}</span></li>)}</ul><CallChip callId={demo.callId} /></div> : <div className="p-panel rounded-2xl border p-5"><h3 className="font-semibold">Demographics remain open</h3><p className="p-muted mt-2 text-sm">No demographic signal was returned for these comparables.</p></div>}{!!regions.length && <div className="p-panel rounded-2xl border p-5"><h3 className="text-lg font-semibold">Regional affinity · US</h3><p className="p-muted mt-1 text-xs">Relative regional signal, not customer counts or a targeting guarantee.</p><ul className="my-4 space-y-3">{regions.map(r => <li key={r.region} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-2 text-xs"><span>{r.region}</span><Bar value={r.score} max={Math.max(1,...regions.map(x=>x.score))} /><span className="text-right tabular-nums">{number(r.score,3)}</span></li>)}</ul><CallChip callId={regions[0].callId} /></div>}</div></div>{run.groundedListing?.coverDirection && <details className="p-panel p-detail rounded-2xl border border-dashed p-5"><summary className="cursor-pointer font-semibold">Creative direction <span className="p-muted text-xs font-normal">· interpretation, not a measured aesthetic</span></summary><p className="mt-3 text-sm leading-relaxed">{run.groundedListing.coverDirection}</p><p className="p-muted mt-2 text-xs">The writer’s reading of the connections above. Validate the visual direction with people before production.</p></details>}</section>;
}
export function MakerAssumptionChecks({ run }: { run: RunState }) {
  if (!run.input.ownAssumptions) return null;
  return <details className="p-panel p-detail rounded-2xl border p-5"><summary className="cursor-pointer font-semibold">Your own assumptions <span className="p-muted text-xs font-normal">· idea {run.focusIdea+1}</span></summary><blockquote className="p-muted my-3 border-l-2 pl-3 text-sm">{run.input.ownAssumptions}</blockquote><ul className="space-y-4">{(run.makerAssumptionChecks ?? []).map((a,i) => <li key={i} className="space-y-2 text-sm"><p><strong className="mr-2">{a.status === "cannot check" ? "— Not established" : a.status === "contradicts" ? "↺ Challenged" : "✓ Matches signal"}</strong>{readable(a.text)}</p><p className="p-muted text-xs">{a.reason}</p><div className="flex flex-wrap gap-1">{a.signals.map((s,j) => <CallChip key={j} callId={s.callId} label={`${readable(s.field)}: ${shown(s.value)}`} />)}</div></li>)}</ul></details>;
}
export function ReceiptsScreen({ run }: { run: RunState }) {
  const all = [...(run.verdicts ?? []).flatMap(v => v.claims.map(c => ({ c, where: ASSUMPTION_LABELS[v.field] }))), ...(run.groundedClaims ?? []).map(c => ({ c, where: "Taste-informed draft" }))];
  const qloo = all.filter(x => x.c.kind === "qloo").length, cached = run.calls.filter(c=>c.cached).length;
  return <section className="space-y-5"><div className="section-heading"><div><p className="eyebrow">05 / Evidence trail</p><h2 className="mt-1 font-serif text-3xl">Nothing hidden in the footnotes.</h2></div><p className="muted max-w-lg text-sm">Inspect the recorded calls behind each claim. Evidence links throughout the report open the matching call below.</p></div><div className="grid grid-cols-3 gap-2">{[{ n:qloo, label:"Recorded claims" },{ n:all.length-qloo,label:"Interpretations" },{n:run.calls.length,label:"API calls"}].map(x=><div key={x.label} className="p-panel rounded-xl border p-4"><p className="font-serif text-3xl">{x.n}</p><p className="p-muted mt-1 text-xs">{x.label}</p></div>)}</div>
    {run.checker && <details className="p-panel p-detail rounded-2xl border p-5"><summary className="cursor-pointer font-semibold">Claim quality checks <span className="p-muted text-xs font-normal">· {run.checker.downgraded} downgraded / {run.checker.dropped} removed / {run.checker.listingFixes ?? 0} copy fixes</span></summary><p className="p-muted mt-3 text-sm">Measured claims must cite a recorded value and identify its subject. Unsupported claims become interpretation; unbacked numbers are removed. Marketplace tag limits and listing measurements are checked too.</p><ul className="mt-3 list-disc space-y-1 pl-4 text-xs">{run.checker.notes.map((n,i)=><li key={i}>{n}</li>)}</ul></details>}
    <details className="p-panel p-detail rounded-2xl border p-5"><summary className="cursor-pointer font-semibold">Claims and their sources <span className="p-muted text-xs font-normal">· {all.length}</span></summary><ul className="mt-4 space-y-4">{all.map(({c,where},i)=><li key={`${where}-${c.id}-${i}`} className="border-t pt-3"><p className="p-muted mb-2 text-xs font-semibold">{where}</p><Claims claims={[c]} /></li>)}</ul></details>
    <div className="p-panel rounded-2xl border p-5"><h3 className="font-semibold">Recorded calls <span className="p-muted text-xs font-normal">· {cached} from cache</span></h3><p className="p-muted mt-1 text-xs">Parameters are redacted. Expand a call to inspect its request metadata.</p><div className="mt-4 space-y-2">{run.calls.map(c=><details id={`call-${c.callId}`} tabIndex={-1} key={c.callId} className="p-detail scroll-mt-24 rounded-xl border p-3 focus:outline-2 focus:outline-offset-2 focus:outline-emerald-700 target:bg-amber-50"><summary className="cursor-pointer text-xs"><span className="mr-2 font-mono font-semibold">{c.callId}</span><span className="break-all">{c.path}</span><span className="p-muted ml-2">{c.status === "error" || (typeof c.status === "number" && c.status >= 400) ? "⚠ " : "✓ "}{c.status}{c.cached ? " · cached" : ""} · {number(c.durationMs,0)} ms</span></summary><dl className="mt-3 space-y-2 break-words text-xs"><div><dt className="p-muted">Pipeline step / source</dt><dd>{c.step} / {c.source}</dd></div><div><dt className="p-muted">Request parameters (redacted)</dt><dd className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-100 p-3 font-mono">{JSON.stringify(c.params,null,2)}</dd></div>{!!c.warnings.length && <div><dt className="font-semibold text-orange-900">Warnings</dt><dd>{c.warnings.join("; ")}</dd></div>}</dl></details>)}</div></div>
    {!!run.decisions.length && <details className="p-panel p-detail rounded-2xl border p-5"><summary className="cursor-pointer font-semibold">Agent decisions <span className="p-muted text-xs font-normal">· {run.decisions.length}</span></summary><ol className="mt-3 space-y-2 text-xs">{run.decisions.map((d,i)=><li key={i}><span className="font-semibold">Step {d.step} · {d.kind.replaceAll("_"," ")}</span><p className="p-muted mt-1">{d.detail}</p></li>)}</ol></details>}
  </section>;
}

/** Plain-text summary for "Download summary (.md)": everything a reader needs to re-check the run. */
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
      `- ${number(r.score * 100, 1)} / 100 research priority — ${run.input.ideas[r.idea]}${r.call ? ` — ${CALL_LABELS[r.call]}: ${readable(r.callReason ?? "")}` : r.dontMake ? ` — lower research priority: ${r.dontMakeReason}` : ""}`,
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
