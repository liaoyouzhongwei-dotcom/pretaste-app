"use client";

import { useEffect, useState } from "react";
import { ChangeSummary, Claims, readable, MakerAssumptionChecks, Notice, ReceiptsScreen, summaryMarkdown, WhatToMakeScreen, WhoTheyAreScreen } from "./screens";
import {
  ASSUMPTION_LABELS,
  type AssumptionVerdict,
  type ListingDraft,
  type Marketplace,
  type ProductInput,
  type RunState,
  type Verdict,
} from "@/lib/types";

interface Status {
  qloo: "live" | "mock";
  syntheticLabel: string | null;
  llm: "online" | "offline";
  models: { planner: string; writer: string };
  scenarios: { id: string; label: string; note: string; input: ProductInput }[];
}

const LAST_STEP = 10;
const STEP_LABELS = [
  "Blind guess",
  "Pick comparables",
  "Find them in Qloo",
  "Queue audience check",
  "Taste neighbours",
  "Audience overlap",
  "Trend velocity",
  "Select idea and check audience",
  "Verdicts",
  "Rank ideas",
  "Grounded listing",
];

type Tab = "verdicts" | "compare" | "make" | "who" | "receipts";
const TABS: { id: Tab; label: string }[] = [
  { id: "verdicts", label: "1 · Verdicts" },
  { id: "compare", label: "2 · Blind vs Grounded" },
  { id: "make", label: "3 · What to make" },
  { id: "who", label: "4 · Who they are" },
  { id: "receipts", label: "5 · Receipts" },
];

const VERDICT_STYLE: Record<Verdict, string> = {
  supported: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  refuted: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  unverifiable: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
};

/** The server signs each state; the browser sends back the exact text and token it received. */
interface Signed {
  stateText: string;
  token: string;
  state: RunState;
}

async function postStep(step: number, body: unknown): Promise<Signed> {
  const res = await fetch(`/api/pipeline/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { stateText?: string; token?: string; error?: string };
  if (!res.ok || !json.stateText || !json.token) throw new Error(json.error ?? `step ${step} failed (${res.status})`);
  return { stateText: json.stateText, token: json.token, state: JSON.parse(json.stateText) as RunState };
}

export default function PretasteApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [qlooOff, setQlooOff] = useState(false);
  const [tab, setTab] = useState<Tab>("verdicts");

  const [ideas, setIdeas] = useState(["", "", ""]);
  const [market, setMarket] = useState<Marketplace>("etsy");
  const [price, setPrice] = useState("");

  useEffect(() => {
    const openReceipt = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setTab("receipts");
      // Wait for the receipts tab to render, then jump to the call. Setting the hash also
      // highlights the row (CSS :target).
      let tries = 0;
      const jump = () => {
        const el = document.getElementById(`call-${id}`);
        if (!el) {
          if (tries++ < 20) setTimeout(jump, 50);
          return;
        }
        if (location.hash === `#call-${id}`) history.replaceState(null, "", " ");
        location.hash = `call-${id}`;
        el.scrollIntoView({ block: "center" });
      };
      setTimeout(jump, 0);
    };
    window.addEventListener("pretaste:receipt", openReceipt);
    return () => window.removeEventListener("pretaste:receipt", openReceipt);
  }, []);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setFatal("Could not load /api/status"));
  }, []);

  async function start(body: { scenarioId: string } | { input: ProductInput }) {
    setFatal(null);
    setRun(null);
    setQlooOff(false);
    try {
      setStep(0);
      let s = await postStep(0, body);
      setRun(s.state);
      for (let i = 1; i <= LAST_STEP; i++) {
        setStep(i);
        s = await postStep(i, { stateText: s.stateText, token: s.token });
        setRun(s.state);
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "run failed");
    } finally {
      setStep(null);
    }
  }

  function startCustom() {
    const list = ideas.map((x) => x.trim()).filter(Boolean);
    if (list.length === 0) {
      setFatal("Enter at least one idea.");
      return;
    }
    const p = Number(price);
    void start({ input: { ideas: list, marketplace: market, priceUsd: p > 0 ? p : undefined } });
  }

  const busy = step !== null;
  const customOff = status?.llm === "offline";
  const usedFixture = run
    ? Object.values(run.sources).includes("fixture") || (!run.scenarioId && run.sources[10] === "rules")
    : false;
  const noModelDraft = run ? run.sources[0] === "rules" : false;
  // Steps 8 and 9 are fixed rules by design; any other step on "rules" means the live model fell back.
  const ruleSteps = run
    ? Object.entries(run.sources)
        .filter(([k, v]) => v === "rules" && k !== "8" && k !== "9")
        .map(([k]) => Number(k))
    : [];
  const usedMock = run ? Object.values(run.sources).includes("mock") : status?.qloo === "mock";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Pretaste</h1>
        <p className="text-lg">Your agent guessed. Qloo checked.</p>
        <p className="text-sm opacity-80">Compare product ideas before making them: see which audience guesses the taste data challenges, and what to test next.</p>
        <div className="flex flex-wrap gap-2 text-xs">
          {status && (
            <>
              <span className="rounded-full border px-2 py-0.5">Qloo: {status.qloo}</span>
              <span className="rounded-full border px-2 py-0.5">
                LLM: {status.llm} {status.llm === "online" ? `(${status.models.planner})` : ""}
              </span>
            </>
          )}
        </div>
      </header>

      {usedMock && (
        <Notice tone="synthetic" label="Synthetic data">
          {status?.syntheticLabel ?? "SYNTHETIC — not Qloo data"} · all numbers, names and ids below are generated locally
        </Notice>
      )}
      {noModelDraft && (
        <Notice tone="info" label="Live model unavailable">
          The blind draft is your idea as written with no guessed audience, and only the titles you quoted were looked up. The
          Qloo checks, verdicts and receipts are computed live.
        </Notice>
      )}
      {usedFixture && !noModelDraft && (
        <Notice tone="info" label={run?.scenarioId ? "Prepared example" : "Live model unavailable"}>
          {run?.scenarioId
            ? "The agent's text in this run comes from the prepared example for this scenario, not a live model. The Qloo checks, verdicts and receipts are computed live."
            : "The model was unavailable for the rewrite; the selected idea uses its blind draft when available. Check the receipts and review the draft before use."}
        </Notice>
      )}
      {run && !usedFixture && !noModelDraft && ruleSteps.length > 0 && (
        <Notice tone="info" label="Live model unavailable">
          {ruleSteps.map((s) => `step ${s} (${STEP_LABELS[s] ?? "step"})`).join(", ")} fell back to fixed rules instead of the live
          model. The Qloo checks, verdicts and receipts are computed live.
        </Notice>
      )}
      {run && !usedMock && !usedFixture && !noModelDraft && ruleSteps.length === 0 && (
        <Notice tone="info" label="Live run">
          The agent&apos;s text comes from the live model{status?.llm === "online" ? ` (${status.models.planner})` : ""}; the Qloo checks, verdicts and receipts are computed live.
        </Notice>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">Try a prepared scenario</h2>
        <div className="flex flex-wrap gap-2">
          {status?.scenarios.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onClick={() => void start({ scenarioId: s.id })}
              title={s.note}
              className="rounded-md border px-3 py-2 text-sm hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
            >
              {s.label}
            </button>
          ))}
        </div>

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm">Or try your own idea</summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs opacity-70">Describe products only. Do not enter personal data (names, emails, phone numbers).</p>
            {customOff && (
              <Notice tone="info" label="Live model unavailable">
                Your idea still runs on Qloo with a plain draft: no guessed audience, and only titles you put in quotes (for
                example the book &quot;Little Women&quot;) are looked up.
              </Notice>
            )}
            {ideas.map((v, i) => (
              <input
                key={i}
                value={v}
                maxLength={200}
                onChange={(e) => setIdeas(ideas.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={`Idea ${i + 1}${i === 0 ? "" : " (optional)"}`}
                className="w-full rounded border bg-transparent px-2 py-1 text-sm"
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value as Marketplace)}
                className="rounded border bg-transparent px-2 py-1 text-sm"
              >
                <option value="etsy">Etsy</option>
                <option value="kdp">Amazon KDP</option>
                <option value="other">Other</option>
              </select>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price USD"
                inputMode="decimal"
                className="w-28 rounded border bg-transparent px-2 py-1 text-sm"
              />
              <button
                disabled={busy}
                onClick={startCustom}
                className="rounded-md bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50"
              >
                Check it
              </button>
            </div>
          </div>
        </details>
      </section>

      {busy && (
        <ol className="flex flex-wrap gap-1 text-xs" aria-label="progress">
          {STEP_LABELS.map((label, i) => (
            <li
              key={label}
              className={`rounded px-2 py-0.5 ${i < step! ? "bg-emerald-200 dark:bg-emerald-900" : i === step ? "animate-pulse bg-amber-200 dark:bg-amber-800" : "bg-stone-200 dark:bg-stone-800"}`}
            >
              {i}. {label}
            </li>
          ))}
        </ol>
      )}

      {fatal && (
        <Notice tone="error" label="Run stopped">
          {fatal}
        </Notice>
      )}
      {run && run.errors.length > 0 && (
        <Notice tone="error" label={`API error${run.errors.length === 1 ? "" : "s"}`}>
          <ul className="mt-1 list-disc pl-5">
            {run.errors.map((e, i) => (
              <li key={i}>
                Step {e.step} ({STEP_LABELS[e.step] ?? "step"}): {e.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {run?.verdicts && (
        <>
          <ChangeSummary run={run} />
          <nav className="flex gap-1 overflow-x-auto border-b">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t.id ? "border-foreground font-semibold" : "border-transparent opacity-60"}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {tab === "verdicts" && <VerdictScreen run={run} />}
          {tab === "compare" && <CompareScreen run={run} qlooOff={qlooOff} setQlooOff={setQlooOff} />}
          {tab === "make" && <WhatToMakeScreen run={run} />}
          {tab === "who" && <WhoTheyAreScreen run={run} />}
          {tab === "receipts" && <ReceiptsScreen run={run} />}
          {!busy && (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <button onClick={() => downloadSummary(run, usedMock)} className="rounded-md border px-3 py-1 text-sm hover:bg-black/5 dark:hover:bg-white/10">
                Download summary (.md)
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function VerdictScreen({ run }: { run: RunState }) {
  const v = run.verdicts ?? [];
  const refuted = v.filter((x) => x.verdict === "refuted").length;
  const supported = v.filter((x) => x.verdict === "supported").length;
  return (
    <section className="space-y-4">
      <MakerAssumptionChecks run={run} />
      <div>
        <p className="text-xl font-semibold">
          {refuted} of {v.length} guesses refuted
        </p>
        <div className="mt-2 flex h-3 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
          <div className="bg-rose-500" style={{ width: `${(refuted / Math.max(1, v.length)) * 100}%` }} />
          <div className="bg-emerald-500" style={{ width: `${(supported / Math.max(1, v.length)) * 100}%` }} />
        </div>
        <p className="mt-1 text-xs opacity-60">red = refuted · green = supported · grey = can&apos;t be checked</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {v.map((x) => (
          <VerdictCard key={x.field} v={x} />
        ))}
      </div>
    </section>
  );
}

function VerdictCard({ v }: { v: AssumptionVerdict }) {
  return (
    <article className="space-y-2 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{ASSUMPTION_LABELS[v.field]}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${VERDICT_STYLE[v.verdict]}`}>{v.verdict}</span>
      </div>
      <p className="text-sm">
        <span className="opacity-60">Agent guessed: </span>
        {readable(v.assumed)}
      </p>
      <p className="text-xs opacity-70">{readable(v.reason)}</p>
      <Claims claims={v.claims} />
    </article>
  );
}


function Listing({ title, l }: { title: string; l: ListingDraft | undefined }) {
  if (!l) return <p className="text-sm opacity-70">No prepared draft is available for this selected idea.</p>;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide opacity-70">{title}</h3>
      <p className="font-semibold">{l.title}</p>
      <p className="text-sm">{l.description}</p>
      <div className="flex flex-wrap gap-1">
        {l.tags.map((t) => (
          <span key={t} className="rounded border px-1.5 text-xs">
            {t}
          </span>
        ))}
      </div>
      {l.coverDirection && <p className="text-xs opacity-70">Cover: {l.coverDirection}</p>}
      {l.title && l.description ? (
        <CopyButton text={[l.title, "", l.description, "", l.tags.join(", ")].join("\n")} />
      ) : (
        <p className="text-sm text-amber-700 dark:text-amber-300">Listing withheld: rewrite the empty fields with generic wording before use.</p>
      )}
    </div>
  );
}

function CompareScreen({ run, qlooOff, setQlooOff }: { run: RunState; qlooOff: boolean; setQlooOff: (b: boolean) => void }) {
  const claims = qlooOff ? [] : run.groundedClaims ?? [];
  const receipts = claims.filter((c) => c.kind === "qloo" && c.evidence.length > 0).length;
  const noModelDraft = run.sources[0] === "rules";
  const verdicts = (run.verdicts ?? []).map((v) => (qlooOff ? { ...v, verdict: "unverifiable" as Verdict } : v));
  return (
    <section className="space-y-4">
      <p className="text-xs opacity-70">
        Both sides describe the same product (idea {run.focusIdea + 1}: {run.input.ideas[run.focusIdea]}).
      </p>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={qlooOff} onChange={(e) => setQlooOff(e.target.checked)} />
        Qloo off (what the agent would ship without taste data)
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <Listing title={noModelDraft ? "Blind (your words, no model)" : "Blind (LLM only)"} l={run.blindListing} />
        </div>
        <div className="rounded-lg border p-4">
          <Listing title={qlooOff ? "Grounded — Qloo off (= blind)" : "Grounded (with Qloo)"} l={qlooOff ? run.blindListing : run.groundedListing} />
          <p className="mt-3 text-sm font-semibold">Receipts: {receipts}</p>
          <Claims claims={claims} />
          {!qlooOff && run.checker && run.checker.notes.length > 0 && (
            <details className="mt-2 text-xs">
              <summary>
                Checker: {run.checker.downgraded} claims downgraded, {run.checker.dropped} dropped, {run.checker.listingFixes ?? 0}{" "}
                listing fixes
              </summary>
              <ul>
                {run.checker.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {verdicts.map((v) => (
          <span key={v.field} className={`rounded-full px-2 py-0.5 ${VERDICT_STYLE[v.verdict]}`}>
            {ASSUMPTION_LABELS[v.field]}: {v.verdict}
          </span>
        ))}
      </div>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => setDone(false));
      }}
      className="rounded border px-2 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
    >
      {done ? "Copied" : "Copy listing"}
    </button>
  );
}

function downloadSummary(run: RunState, synthetic: boolean) {
  const blob = new Blob([summaryMarkdown(run, synthetic)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pretaste-${run.runId}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
