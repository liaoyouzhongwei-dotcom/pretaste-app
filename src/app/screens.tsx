"use client";

import type { ReactNode } from "react";
import type { Claim } from "@/lib/claims";
import { provenanceLines } from "@/lib/provenance";
import { joinRisks } from "@/lib/practical";
import { readable } from "@/lib/readable";
export { readable };
import { RANK_FORMULA } from "@/lib/rules";
import { AGE_BANDS, ASSUMPTION_LABELS, type IdeaScore, type RunState } from "@/lib/types";

/** Opens the Receipts tab at this call (the app listens for "pretaste:receipt"). */
function CallChip({ callId, label }: { callId: string; label?: string }) {
  return (
    <a
      href={`#call-${callId}`}
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("pretaste:receipt", { detail: callId }));
      }}
      className="rounded bg-stone-200 px-1 font-mono text-[10px] hover:underline dark:bg-stone-800"
    >
      {label ?? callId}
    </a>
  );
}

export function Claims({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) return null;
  return (
    <ul className="space-y-1">
      {claims.map((c) => (
        <li key={c.id} className="text-sm">
          <span className={c.kind === "qloo" ? "" : "italic text-violet-700 dark:text-violet-300"}>
            {c.kind === "interpretation" ? "Interpretation: " : ""}
            {readable(c.text)}
          </span>
          <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
            {c.evidence.map((e, i) => (
              <CallChip key={i} callId={e.callId} label={`${e.callId} · ${e.field} = ${String(e.value)}`} />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Bar({ value, max = 1, tone = "bg-emerald-500" }: { value: number; max?: number; tone?: string }) {
  const w = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
      <div className={`h-full ${tone}`} style={{ width: `${w}%` }} />
    </div>
  );
}

/** Bar centred on 0 for signed values in -1..1. */
function SignedBar({ value }: { value: number }) {
  const w = Math.min(1, Math.abs(value)) * 50;
  return (
    <div className="relative h-2 w-full rounded bg-stone-200 dark:bg-stone-800">
      <div className="absolute inset-y-0 left-1/2 w-px bg-stone-400" />
      <div
        className={`absolute inset-y-0 ${value >= 0 ? "bg-emerald-500" : "bg-rose-500"}`}
        style={value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </div>
  );
}

const CALL_LABELS = { make: "Make", fix: "Fix, then make", skip: "Skip", hold: "Hold" } as const;

const PART_LABELS: Record<string, string> = {
  affinity: "Taste affinity",
  trend: "Trend momentum",
  found: "Found in Qloo",
  overlap: "Taste-tag similarity with your other ideas",
};

function strongestWeakest(r: IdeaScore): string {
  const missing = new Set(r.missing ?? []);
  const pos = Object.entries(r.parts).filter(([k]) => k !== "overlap" && !missing.has(k));
  pos.sort((a, b) => b[1] - a[1]);
  const [best, worst] = [pos[0], pos[pos.length - 1]];
  if (!best || !worst) return "";
  return `Strongest: ${PART_LABELS[best[0]] ?? best[0]} (${best[1]}). Weakest: ${PART_LABELS[worst[0]] ?? worst[0]} (${worst[1]}).`;
}

const NOTICE_STYLE = {
  synthetic: "border-2 border-amber-500 bg-amber-50 font-mono font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  info: "border border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  error: "border border-rose-500 bg-rose-50 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
} as const;

/** One look for every data-source and failure notice, so each screen states it the same way. */
export function Notice({ tone, label, children }: { tone: keyof typeof NOTICE_STYLE; label: string; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`break-words rounded-md px-4 py-2 text-sm ${NOTICE_STYLE[tone]}`}>
      <span className="font-semibold uppercase tracking-wide">{label}:</span> {children}
    </div>
  );
}

/** The before → after for the same product, and why it changed. Shown above every tab. */
export function changeSummary(run: RunState) {
  const before = run.blindListing;
  const after = run.groundedListing;
  if (!before || !after) return null;
  const refuted = (run.verdicts ?? []).filter((v) => v.verdict === "refuted");
  const receipts = (run.groundedClaims ?? []).filter((c) => c.kind === "qloo" && c.evidence.length > 0).length;
  const rank = (run.ranking ?? []).find((r) => r.idea === run.focusIdea);
  const why = refuted.length
    ? refuted.slice(0, 2).map((v) => `${ASSUMPTION_LABELS[v.field]}: guessed ${readable(v.assumed)}. ${readable(v.reason)}`)
    : [`No guess was refuted. The rewrite cites ${receipts} Qloo ${receipts === 1 ? "receipt" : "receipts"}.`];
  const call = rank?.call ? `${CALL_LABELS[rank.call]}: ${readable(rank.callReason ?? "")}` : null;
  return { before, after, why, more: Math.max(0, refuted.length - 2), call, noModel: run.sources[0] === "rules" };
}

export function ChangeSummary({ run }: { run: RunState }) {
  const s = changeSummary(run);
  if (!s) return null;
  return (
    <section aria-label="What changed" className="space-y-3 rounded-lg border-2 border-foreground/30 p-4">
      <h2 className="break-words font-semibold">
        What changed for idea {run.focusIdea + 1}: {run.input.ideas[run.focusIdea]}
      </h2>
      <div className="grid items-start gap-2 md:grid-cols-[1fr_auto_1fr]">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide opacity-60">{s.noModel ? "Before (your words, no model)" : "Before (LLM only)"}</p>
          <p className="break-words">{s.before.title || <span className="italic opacity-70">(title withheld: it named a comparable or brand)</span>}</p>
        </div>
        <span aria-hidden className="hidden text-xl opacity-60 md:block">→</span>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide opacity-60">After (with Qloo)</p>
          <p className="break-words font-semibold">{s.after.title || <span className="italic font-normal opacity-70">(title withheld: it named a comparable or brand)</span>}</p>
        </div>
      </div>
      <div className="space-y-1 text-sm">
        <p className="font-semibold">Why</p>
        <ul className="list-disc space-y-1 pl-5">
          {s.why.map((w, i) => (
            <li key={i} className="break-words">{w}</li>
          ))}
        </ul>
        {s.more > 0 && <p className="text-xs opacity-70">{s.more} more refuted guesses in Verdicts.</p>}
        {s.call && <p className="break-words font-semibold">{s.call}</p>}
      </div>
    </section>
  );
}

export function practicalLines(run: RunState): string[] {
  const p = run.practical;
  if (!p || (!p.ideas.length && !p.tieBreak)) return [];
  const out = ["", "## Outside the data", "", "General knowledge from the model, not checked against Qloo or any data.", ""];
  if (p.tieBreak) out.push(`- Too close to call on the data. Where to start: Idea ${p.tieBreak.idea + 1} — ${p.tieBreak.why}`);
  for (const it of p.ideas) {
    out.push(`- Idea ${it.idea + 1}${it.priceFit ? ` — price: ${it.priceFit}` : ""}${it.risks.length ? ` — risks: ${joinRisks(it.risks)}` : ""}`);
  }
  return out;
}

export function WhatToMakeScreen({ run }: { run: RunState }) {
  const ranking = run.ranking ?? [];
  const resolved = run.resolved ?? [];
  return (
    <section className="space-y-4">
      <p className="text-sm opacity-70">
        Score = {run.ranking?.[0]?.formula ?? RANK_FORMULA}. Fixed rules, no model in the loop: the same calls always give the same order.
      </p>
      <ol className="space-y-3">
        {ranking.map((r, i) => {
          const ids = new Set(resolved.filter((x) => x.idea === r.idea).map((x) => x.entityId).filter(Boolean));
          const vel = (run.trends ?? []).filter((t) => ids.has(t.entityId));
          return (
            <li key={r.idea} className={`space-y-3 rounded-lg border p-4 ${r.dontMake ? "border-rose-400" : r.idea === run.focusIdea ? "border-emerald-500" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">
                  #{i + 1} · {run.input.ideas[r.idea]}
                </h3>
                <span className="font-mono text-lg">{r.score}</span>
              </div>
              {r.call ? (
                <p className={`text-sm font-semibold ${r.call === "make" ? "text-emerald-700 dark:text-emerald-300" : r.call === "skip" ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"}`}>
                  {CALL_LABELS[r.call]}: {readable(r.callReason ?? "")}
                </p>
              ) : r.dontMake ? (
                <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">{r.onHold ? r.dontMakeReason : <>Don&apos;t make (yet): {r.dontMakeReason}</>}</p>
              ) : (
                r.idea === run.focusIdea && <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Make this one first.</p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(r.parts).map(([k, v]) => {
                  const missing = (r.missing ?? []).includes(k);
                  return (
                    <div key={k} className="space-y-0.5">
                      <div className="flex justify-between text-xs">
                        <span>{PART_LABELS[k] ?? k}</span>
                        <span className="font-mono">{missing ? "no data" : v}</span>
                      </div>
                      <Bar value={missing ? 0 : v} tone={k === "overlap" ? "bg-amber-500" : "bg-emerald-500"} />
                    </div>
                  );
                })}
              </div>
              {vel.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs opacity-70">Trend velocity of its comparables, week over week (up = rising, down = falling)</p>
                  <div className="flex gap-1" aria-label="trend velocities">
                    {vel.map((t, j) => {
                      const h = `${Math.max(8, Math.min(1, Math.abs(t.velocity) * 4) * 100)}%`;
                      return (
                        <div key={j} className="flex w-4 flex-col" title={`${t.name}: ${t.velocity} (${t.callId})`}>
                          <div className="flex h-5 items-end border-b border-stone-400">{t.velocity >= 0 && <div className="w-full bg-emerald-500" style={{ height: h }} />}</div>
                          <div className="flex h-5 items-start">{t.velocity < 0 && <div className="w-full bg-rose-500" style={{ height: h }} />}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="text-xs opacity-70">{strongestWeakest(r)}</p>
            </li>
          );
        })}
      </ol>
      {(run.compare ?? []).length > 0 && (
        <div className="space-y-1 text-sm">
          <h3 className="font-semibold">Taste-tag similarity between your ideas</h3>
          <ul className="space-y-1">
            {(run.compare ?? []).map((c) => (
              <li key={`${c.ideaA}-${c.ideaB}`} className="flex flex-wrap items-center gap-2">
                <span>
                  Idea {c.ideaA + 1} ↔ Idea {c.ideaB + 1}: {Math.round(c.overlap * 100)}% of taste tags shared
                </span>
                <CallChip callId={c.callId} />
              </li>
            ))}
          </ul>
          <p className="text-xs opacity-60">
            Compares the Qloo taste tags of each idea&apos;s comparables, not buyer lists. High similarity suggests the two ideas
            appeal to the same taste, so they may compete.
          </p>
        </div>
      )}
      <PracticalBox run={run} />
    </section>
  );
}

/** Step 10's notes on what the taste data cannot see. Labelled as unchecked general knowledge. */
function PracticalBox({ run }: { run: RunState }) {
  const p = run.practical;
  if (!p || (!p.ideas.length && !p.tieBreak)) return null;
  return (
    <div className="min-w-0 space-y-2 break-words rounded-lg border border-dashed p-4 text-sm">
      <h3 className="font-semibold">Outside the data</h3>
      <p className="text-xs opacity-70">General knowledge from the model, not checked against Qloo or any data. Use it to plan, not as evidence.</p>
      {p.tieBreak && (
        <p>
          <span className="font-semibold">Too close to call on the data. Where to start:</span> Idea {p.tieBreak.idea + 1} — {p.tieBreak.why}
        </p>
      )}
      <ul className="space-y-1">
        {p.ideas.map((it) => (
          <li key={it.idea}>
            <span className="font-semibold">Idea {it.idea + 1}</span>
            {it.priceFit && <> · Price: {it.priceFit}</>}
            {it.risks.length > 0 && <> · Risks: {joinRisks(it.risks)}</>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WhoTheyAreScreen({ run }: { run: RunState }) {
  const neighbors = [...(run.neighbors ?? [])].sort((a, b) => b.affinity - a.affinity).slice(0, 8);
  const demo = run.demographics;
  const regions = [...(run.heatmap ?? [])].sort((a, b) => b.score - a.score).slice(0, 5);
  const aesthetic = (run.verdicts ?? []).find((v) => v.field === "aesthetic");
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <p className="text-xs opacity-70 md:col-span-2">
        Audience of idea {run.focusIdea + 1}: {run.input.ideas[run.focusIdea]}
      </p>
      <div className="space-y-2 rounded-lg border p-4">
        <h3 className="font-semibold">Buyers like this also like</h3>
        {neighbors.length === 0 && <p className="text-sm opacity-70">No taste neighbours came back.</p>}
        <ul className="space-y-2">
          {neighbors.map((n) => (
            <li key={n.entityId} className="space-y-0.5 text-sm">
              <div className="flex justify-between gap-2">
                <span>
                  {n.name}{n.kind.startsWith("urn:entity:") && <span className="text-xs opacity-60"> ({n.kind.slice("urn:entity:".length)})</span>}
                </span>
                <span className="font-mono text-xs">{n.affinity.toFixed(2)}</span>
              </div>
              <Bar value={n.affinity} />
              <p className="text-[11px] opacity-60">
                driven by: {n.drivenBy.join(", ") || "—"} · <CallChip callId={n.callId} />
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-4">
        {demo && (
          <div className="space-y-2 rounded-lg border p-4">
            <h3 className="font-semibold">Age and gender skew</h3>
            <p className="text-xs opacity-60">0 = average audience; right = over-represented.</p>
            <ul className="space-y-1">
              {AGE_BANDS.filter((b) => demo.age[b] !== undefined).map((b) => (
                <li key={b} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-xs">
                  <span>{b.replaceAll("_", " ")}</span>
                  <SignedBar value={demo.age[b] ?? 0} />
                  <span className="text-right font-mono">{demo.age[b]}</span>
                </li>
              ))}
              {demo.gender.female !== undefined && (
                <li className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-xs">
                  <span>female</span>
                  <SignedBar value={demo.gender.female} />
                  <span className="text-right font-mono">{demo.gender.female}</span>
                </li>
              )}
            </ul>
            <CallChip callId={demo.callId} />
          </div>
        )}
        {regions.length > 0 && (
          <div className="space-y-2 rounded-lg border p-4">
            <h3 className="font-semibold">Where to reach them (US)</h3>
            <ul className="space-y-1">
              {regions.map((r) => (
                <li key={r.region} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-xs">
                  <span>{r.region}</span>
                  <Bar value={r.score} tone="bg-sky-500" />
                  <span className="text-right font-mono">{r.score}</span>
                </li>
              ))}
            </ul>
            <CallChip callId={regions[0].callId} />
          </div>
        )}
      </div>

      {run.groundedListing && (
        <div className="space-y-2 rounded-lg border p-4 md:col-span-2">
          <h3 className="font-semibold">Cover direction</h3>
          <p className="italic text-violet-700 dark:text-violet-300">Interpretation: {run.groundedListing.coverDirection}</p>
          <p className="text-xs opacity-60">
            Written by the agent from the neighbours above. {ASSUMPTION_LABELS.aesthetic}: {aesthetic?.verdict ?? "—"}
            {aesthetic?.verdict === "unverifiable" ? " (Qloo tag signal not wired yet, so the look is a reading, not a measurement)." : "."}
          </p>
        </div>
      )}
    </section>
  );
}

export function MakerAssumptionChecks({ run }: { run: RunState }) {
  if (!run.input.ownAssumptions) return null;
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <h3 className="font-semibold">Your assumptions: idea {run.focusIdea + 1}</h3>
      <p className="text-xs opacity-70">Qloo measures affinity for comparable audiences, not sales or buyer shares.</p>
      <ul className="space-y-3 text-sm">
        {(run.makerAssumptionChecks ?? []).map((a, i) => (
          <li key={i}>
            <p><strong>{a.status}</strong>: {readable(a.text)}</p>
            <p className="text-xs opacity-70">{a.reason}</p>
            <div className="flex flex-wrap gap-1">
              {a.signals.map((s, j) => <CallChip key={j} callId={s.callId} label={`${s.field} = ${s.value}`} />)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReceiptsScreen({ run }: { run: RunState }) {
  const verdictClaims = (run.verdicts ?? []).flatMap((v) => v.claims.map((c) => ({ c, where: ASSUMPTION_LABELS[v.field] })));
  const listingClaims = (run.groundedClaims ?? []).map((c) => ({ c, where: "Grounded listing" }));
  const all = [...verdictClaims, ...listingClaims];
  const qloo = all.filter((x) => x.c.kind === "qloo").length;
  const cached = run.calls.filter((c) => c.cached).length;
  return (
    <section className="space-y-4 text-sm">
      <MakerAssumptionChecks run={run} />
      <p>
        {all.length} claims · {qloo} backed by a recorded Qloo call · {all.length - qloo} marked as interpretation · {run.calls.length} calls ({cached} from cache)
      </p>
      {run.checker && (
        <div className="rounded-lg border p-3">
          <p className="font-semibold">
            Claim checker: {run.checker.downgraded} downgraded, {run.checker.dropped} dropped, {run.checker.listingFixes ?? 0} listing
            fixes
          </p>
          <p className="text-xs opacity-70">
            A Qloo claim must cite a value the server recorded and name what it is about, or it becomes an interpretation; a
            claim whose numbers are not in its evidence is removed. In the listing, a sentence stating a measurement that is not
            in the evidence is removed, and tags are cut to the marketplace limits.
          </p>
          {run.checker.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {run.checker.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <details open>
        <summary className="cursor-pointer font-semibold">Claims → evidence ({all.length})</summary>
        <ul className="mt-2 space-y-2">
          {all.map(({ c, where }) => (
            <li key={`${where}-${c.id}`}>
              <span className="mr-1 rounded border px-1 text-[10px] uppercase opacity-70">{where}</span>
              <Claims claims={[c]} />
            </li>
          ))}
        </ul>
      </details>
      {run.decisions.length > 0 && (
        <details open>
          <summary className="cursor-pointer font-semibold">Agent decisions ({run.decisions.length})</summary>
          <ul className="mt-2 list-disc pl-5">
            {run.decisions.map((d, i) => (
              <li key={i}>
                step {d.step} · {d.kind}: {d.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details open>
        <summary className="cursor-pointer font-semibold">Calls ({run.calls.length})</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left opacity-60">
                <th className="pr-2">id</th>
                <th className="pr-2">step</th>
                <th className="pr-2">path</th>
                <th className="pr-2">params (redacted)</th>
                <th className="pr-2">status</th>
                <th className="pr-2">ms</th>
                <th>warnings</th>
              </tr>
            </thead>
            <tbody>
              {run.calls.map((c) => (
                <tr key={c.callId} id={`call-${c.callId}`} className="border-t align-top target:bg-amber-100 dark:target:bg-amber-900/40">
                  <td className="pr-2 font-mono">{c.callId}</td>
                  <td className="pr-2">{c.step}</td>
                  <td className="pr-2 font-mono">{c.path}</td>
                  <td className="pr-2 font-mono break-all">
                    {Object.entries(c.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}
                  </td>
                  <td className="pr-2">
                    {String(c.status)}
                    {c.cached ? " · cache" : ""}
                  </td>
                  <td className="pr-2">{c.durationMs}</td>
                  <td>{c.warnings.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
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
  lines.push(`Verdicts, audience and listing are about idea ${run.focusIdea + 1}.`, "");
  const change = changeSummary(run);
  if (change) {
    lines.push("## What changed", "", `- Before${change.noModel ? " (your words, no model)" : " (LLM only)"}: ${change.before.title}`, `- After (with Qloo): ${change.after.title}`);
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
  lines.push("", "## What to make", "", `Score = ${run.ranking?.[0]?.formula ?? RANK_FORMULA}`, "");
  for (const r of run.ranking ?? []) {
    const parts = Object.entries(r.parts)
      .map(([k, v]) => `${PART_LABELS[k] ?? k} ${(r.missing ?? []).includes(k) ? "no data" : v}`)
      .join(", ");
    lines.push(
      `- ${r.score} — ${run.input.ideas[r.idea]}${r.call ? ` — ${CALL_LABELS[r.call]}: ${readable(r.callReason ?? "")}` : r.dontMake ? ` — don't make (yet): ${r.dontMakeReason}` : ""}`,
      `  - ${parts}`,
    );
  }
  for (const c of run.compare ?? []) {
    lines.push(`- Idea ${c.ideaA + 1} ↔ Idea ${c.ideaB + 1}: ${Math.round(c.overlap * 100)}% of taste tags shared (${c.callId})`);
  }
  lines.push(...practicalLines(run));
  const neighbors = [...(run.neighbors ?? [])].sort((a, b) => b.affinity - a.affinity).slice(0, 8);
  if (neighbors.length) {
    lines.push("", "## Buyers like this also like", "");
    for (const n of neighbors) lines.push(`- ${n.name} — affinity ${n.affinity} (${n.callId})`);
  }
  const regions = [...(run.heatmap ?? [])].sort((a, b) => b.score - a.score).slice(0, 5);
  if (regions.length) {
    lines.push("", "## Where to reach them (US, approximate)", "");
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
