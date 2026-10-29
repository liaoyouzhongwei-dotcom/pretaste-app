"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChangeSummary, CompareScreen, Notice, ReceiptsScreen, summaryMarkdown, VERDICT_WORD, VerdictScreen, WhatToMakeScreen, WhoTheyAreScreen } from "./screens";
import { Icon, TasteMark } from "./ui";
import type { Marketplace, ProductInput, RunState } from "@/lib/types";

interface Status {
  qloo: "live" | "mock"; syntheticLabel: string | null; llm: "online" | "offline";
  models: { planner: string; writer: string };
  scenarios: { id: string; label: string; note: string; input: ProductInput }[];
}
type StartBody = { scenarioId: string } | { input: ProductInput };
type Tab = "verdicts" | "compare" | "make" | "who" | "receipts";
const TABS: { id: Tab; label: string }[] = [{ id: "verdicts", label: "Assumptions" }, { id: "compare", label: "Before & after" }, { id: "make", label: "Ideas ranked" }, { id: "who", label: "Audience" }, { id: "receipts", label: "Evidence" }];
const STEPS = ["Write the first draft", "Choose cultural comparables", "Find comparables in Qloo", "Prepare the audience check", "Explore taste connections", "Compare audience overlap", "Check trend signals", "Check the selected audience", "Test the assumptions", "Rank your ideas", "Write the grounded draft"];
const PHASES = [{ name: "LLM draft", first: 0, last: 1 }, { name: "Qloo taste checks", first: 2, last: 7 }, { name: "Verdicts and ranking", first: 8, last: 10 }];
const SCENARIOS: Record<string, { title: string; description: string; category: string }> = {
  "coloring-japan": { title: "Everyday Japan", description: "Does the audience for Japan-themed coloring books match the one the LLM pictures?", category: "Coloring books · Amazon KDP" },
  "family-binder": { title: "The family handover", description: "Three printable binders. Which audience guess holds, and which idea deserves research first?", category: "Digital downloads · Etsy" },
  "comedian-merch": { title: "Beyond the tour tee", description: "Merch for a comedian’s fans. What do comparable audiences actually share?", category: "Creator merch · Example" },
};

/** Preserve the exact state text signed by the server. */
async function postStep(step: number, body: unknown, signal: AbortSignal, attemptId?: string) {
  const res = await fetch(`/api/pipeline/${step}`, { method: "POST", headers: { "Content-Type": "application/json", ...(attemptId ? { "Idempotency-Key": attemptId } : {}) }, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({})) as { stateText?: string; token?: string; error?: string };
  if (!res.ok || !json.stateText || !json.token) throw new Error(json.error ?? `The check stopped at step ${step + 1}. Please try again.`);
  return { stateText: json.stateText, token: json.token, state: JSON.parse(json.stateText) as RunState };
}

export default function PretasteApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [run, setRun] = useState<RunState | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fatal, setFatal] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [qlooOff, setQlooOff] = useState(false);
  const [tab, setTab] = useState<Tab>("verdicts");
  const [ideas, setIdeas] = useState(["", "", ""]);
  const [market, setMarket] = useState<Marketplace>("etsy");
  const [price, setPrice] = useState("");
  const [assumptions, setAssumptions] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [lastBody, setLastBody] = useState<StartBody | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const results = useRef<HTMLElement | null>(null);
  const progress = useRef<HTMLElement | null>(null);
  const busy = step !== null;

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/status", { signal: abort.signal }).then((r) => { if (!r.ok) throw new Error("status"); return r.json(); })
      .then((s: Status) => { setStatus(s); setStatusError(false); })
      .catch(() => { if (!abort.signal.aborted) setStatusError(true); });
    return () => abort.abort();
  }, [statusAttempt]);
  useEffect(() => () => { requestId.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const openReceipt = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setTab("receipts");
      let tries = 0;
      const jump = () => {
        const el = document.getElementById(`call-${id}`);
        if (!el) { if (tries++ < 20) timer = setTimeout(jump, 50); return; }
        let parent = el.parentElement;
        while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
        history.replaceState(null, "", `#call-${encodeURIComponent(id)}`);
        el.scrollIntoView({ block: "center", behavior: "smooth" }); el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true });
      };
      timer = setTimeout(jump, 0);
    };
    window.addEventListener("pretaste:receipt", openReceipt);
    return () => { window.removeEventListener("pretaste:receipt", openReceipt); clearTimeout(timer); };
  }, []);

  async function start(body: StartBody) {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    const id = ++requestId.current;
    setLastBody(body); setFatal(null); setCancelled(false); setRun(null); setQlooOff(false); setElapsed(0); setStep(0); setTab("verdicts");
    requestAnimationFrame(() => progress.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    try {
      const attemptId = crypto.randomUUID();
      let signed = await postStep(0, body, abort.signal, attemptId);
      if (id !== requestId.current) return;
      setRun(signed.state);
      for (let i = 1; i < STEPS.length; i++) {
        setStep(i); signed = await postStep(i, { stateText: signed.stateText, token: signed.token }, abort.signal);
        if (id !== requestId.current) return;
        setRun(signed.state);
      }
      requestAnimationFrame(() => results.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    } catch (error) {
      if (id !== requestId.current) return;
      if (abort.signal.aborted) setCancelled(true);
      else setFatal(error instanceof Error ? error.message : "Something interrupted the check. Please try again.");
    } finally { if (id === requestId.current) { controller.current = null; setStep(null); } }
  }
  function startCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const list = ideas.map((idea) => idea.trim()).filter(Boolean);
    if (!list.length) { setFatal("Describe at least one product idea to begin."); return; }
    if (list.some((idea) => idea.length < 3)) { setFatal("Give each product idea at least 3 characters, or leave an optional idea blank."); return; }
    const p = price.trim() ? Number(price) : undefined;
    if (p !== undefined && (!Number.isFinite(p) || p <= 0)) { setFatal("Enter a price above $0, or leave it blank."); return; }
    void start({ input: { ideas: list, marketplace: market, priceUsd: p, ownAssumptions: assumptions.trim() || undefined } });
  }
  function selectTab(next: Tab, focus = false) { setTab(next); if (focus) requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus()); }
  const usedMock = run ? run.provenance?.qlooMode === "mock" || Object.values(run.sources).includes("mock") : status?.qloo === "mock";
  const noModelDraft = run?.sources[0] === "rules";
  const usedFixture = run ? Object.values(run.sources).includes("fixture") || (!run.scenarioId && run.sources[10] === "rules") : false;
  const ruleSteps = run ? Object.entries(run.sources).filter(([key, value]) => value === "rules" && key !== "8" && key !== "9") : [];
  const complete = run?.lastStep === 10;

  return <div className="app-shell">
    <a className="skip-link" href="#workspace">Skip to idea checker</a>
    <header className="site-header"><a className="brand" href="#" aria-label="Pretaste home" translate="no"><TasteMark /><span>Pretaste</span></a><nav className="header-nav" aria-label="Page"><a href="#how-it-works">How it works</a><a href="#workspace" className="header-cta">Try it</a></nav></header>
    <main>
      <section className={`hero ${run || busy ? "hero-compact" : ""}`} aria-labelledby="hero-title">
        <div className="hero-copy"><h1 id="hero-title">Your AI guessed who buys it. <span><mark>Qloo checks the guess.</mark></span></h1><p className="hero-description">Pretaste asks an LLM who your product idea is for, then tests each guess against <span translate="no">Qloo</span>’s taste data on people who love comparable titles and brands — data an LLM can’t see. Keep what the evidence supports. Rethink the rest.</p><div className="hero-actions"><a href="#workspace" className="button-primary">Run a sample check <Icon name="arrow" /></a><span className="hero-note">No sign-up · up to 3 ideas per check</span></div></div>
        <figure className="specimen" aria-label="Illustration of one Pretaste finding, with made-up values">
          <figcaption className="specimen-head"><span>One finding, illustrated</span></figcaption>
          <p className="specimen-product">Idea: a houseplant care journal</p>
          <ul className="specimen-rows">{SPECIMEN.map((row) => <li key={row.field}><span className="specimen-field">{row.field}</span><span className="specimen-guess"><small>LLM guessed</small>{row.guess}</span><span className="specimen-signal"><small>Qloo taste signal</small><span className="specimen-read">{row.read}</span>{row.signal !== null && <span className="specimen-bar" aria-hidden="true"><span style={row.signal < 0 ? { right: "50%", width: `${Math.abs(row.signal) * 50}%` } : { left: "50%", width: `${row.signal * 50}%` }} /></span>}</span><span className={`verdict-chip verdict-${row.verdict}`}>{VERDICT_WORD[row.verdict]}</span></li>)}</ul>
          <p className="specimen-foot">Made-up values for illustration. In a real run, every value links to the recorded <span translate="no">Qloo</span> call.</p>
        </figure>
      </section>
      <section className="how" id="how-it-works" aria-labelledby="how-title"><h2 id="how-title" className="sr-only">How Pretaste works</h2><ol className="how-steps">{HOW.map((item, i) => <li key={item.title}><span className="how-num">{String(i + 1).padStart(2, "0")}</span><h3>{item.title}</h3><p>{item.text}</p></li>)}</ol></section>

      <section id="workspace" className="workspace" aria-labelledby="workspace-title">
        <div className="section-heading"><div><h2 id="workspace-title">Start with a sample, or bring your own idea</h2><p className="section-intro">Each sample checks three product ideas from one maker.</p></div><span className={`connection-status ${status?.qloo === "live" ? "connected" : ""}`} role="status"><span className="status-dot" />{status ? status.qloo === "live" ? "Qloo · live data mode" : "Synthetic demo mode" : statusError ? "Connection unavailable" : "Connecting to the taste graph…"}</span></div>
        {statusError && <div className="connection-error" role="alert"><span>We couldn’t load the scenarios. Try the connection again.</span><button className="button-secondary" onClick={() => { setStatusError(false); setStatusAttempt((n) => n + 1); }}>Reconnect</button></div>}
        {usedMock && !run && <div className="workspace-notice"><Notice tone="synthetic" label="Synthetic demo mode">Qloo is not connected in this environment. This demo uses locally generated signals, not real audience evidence.</Notice></div>}
        <div className="scenario-grid">{status ? status.scenarios.map((scenario) => { const copy = SCENARIOS[scenario.id]; return <button key={scenario.id} disabled={busy} onClick={() => void start({ scenarioId: scenario.id })} className="scenario-card"><span className="scenario-category">{copy?.category ?? scenario.input.marketplace}</span><strong>{copy?.title ?? scenario.label}</strong><span className="scenario-description">{copy?.description ?? scenario.note}</span><span className="scenario-ideas">{scenario.input.ideas.map((idea, i) => <span key={i}>{idea}</span>)}</span><span className="scenario-cta">Run this sample <Icon name="arrow" /></span></button>; }) : !statusError && [0, 1, 2].map((n) => <div className="scenario-skeleton" key={n} aria-hidden="true"><span /><span /><span /></div>)}</div>
        <div className={`custom-panel ${customOpen ? "is-open" : ""}`}><button className="custom-toggle" aria-expanded={customOpen} aria-controls="custom-form" onClick={() => setCustomOpen((open) => !open)}><span><strong>Check your own idea</strong><span>Up to three product ideas, one marketplace</span></span><Icon name="chevron" /></button>
          {customOpen && <form id="custom-form" className="custom-form" onSubmit={startCustom}><p className="form-intro">Be specific about the product and its theme. Use product details only; leave out personal information.</p>
            {status?.llm === "offline" && <Notice tone="info" label="Plain-draft mode">The model is unavailable. We can still check cultural titles you include in quotes, such as the book &quot;Little Women&quot;. Audience assumptions won’t be invented.</Notice>}
            <div className="idea-fields">{ideas.map((idea, i) => <label className="field" key={i}><span>Product idea {i + 1} <small>{i ? "Optional" : "Required"}</small></span><input value={idea} maxLength={200} minLength={3} required={i === 0} disabled={busy} onChange={(e) => setIdeas((previous) => previous.map((value, j) => j === i ? e.target.value : value))} placeholder={["A cozy coloring book of everyday cafés in Japan", "A coloring book of seasonal festivals", "A coloring book of cats in small Japanese towns"][i]} /></label>)}</div>
            <div className="form-bottom"><label className="field"><span>Marketplace</span><select value={market} disabled={busy} onChange={(e) => setMarket(e.target.value as Marketplace)}><option value="etsy">Etsy</option><option value="kdp">Amazon KDP</option><option value="other">Other marketplace</option></select></label><label className="field"><span>Price in USD <small>Optional</small></span><div className="price-input"><span>$</span><input value={price} disabled={busy} onChange={(e) => setPrice(e.target.value)} type="number" min="0.01" step="0.01" max="10000" placeholder="9.99" /></div></label></div>
            <label className="field"><span>What do you already believe about the audience? <small>Optional</small></span><textarea value={assumptions} maxLength={600} disabled={busy} onChange={(e) => setAssumptions(e.target.value)} placeholder="For example: I think this is mostly for women aged 45–54 in California." rows={2} /></label>
            <div className="form-submit"><span>Taste signals help choose what to test. They don’t predict sales.</span><button className="button-primary" disabled={busy || !status} type="submit">Check my ideas <Icon name="arrow" /></button></div>
          </form>}
        </div>
      </section>

      {busy && <section ref={progress} className="progress-panel" aria-labelledby="progress-title" aria-busy="true"><div className="progress-heading"><div><h2 id="progress-title">Checking the guesses against <span translate="no">Qloo</span></h2><p className="progress-sub">Each finding keeps the call it came from.</p></div><div className="progress-actions"><span className="progress-time"><Icon name="clock" /> {elapsed}s</span><button className="button-secondary" onClick={() => controller.current?.abort()}>Cancel check</button></div></div>
        <ol className="phase-list">{PHASES.map((phase) => <li key={phase.name} className={step! > phase.last ? "phase-done" : step! >= phase.first ? "phase-active" : ""}><span className="phase-bar" /><span className="phase-name">{step! > phase.last && <Icon name="check" />}{phase.name}</span></li>)}</ol>
        <div className="progress-track" role="progressbar" aria-label="Pipeline steps completed" aria-valuemin={0} aria-valuemax={11} aria-valuenow={step ?? 0} aria-valuetext={`${step} of 11 steps complete. ${STEPS[step ?? 0]}`}><span style={{ width: `${((step ?? 0) / 11) * 100}%` }} /></div><div className="progress-caption"><p role="status">{STEPS[step ?? 0]}<span>Step {(step ?? 0) + 1} of 11</span></p><span>{elapsed > 45 ? "Still working. Live data checks can take a little longer." : "Live checks can take a few minutes."}</span></div>
      </section>}
      {(fatal || cancelled) && <div className="run-feedback"><Notice tone={cancelled ? "info" : "error"} label={cancelled ? "Check cancelled" : "Check interrupted"}>{cancelled ? "The check has stopped. You can start it again whenever you’re ready." : fatal}{run && !complete ? " Any results below are incomplete." : ""}</Notice>{lastBody && <button className="button-secondary" disabled={busy} onClick={() => void start(lastBody)}>Try again <Icon name="arrow" /></button>}</div>}

      {run && !busy && <section className="results-section" ref={results} aria-label="Your taste check results"><div className="section-heading"><div><h2>{complete ? "Results" : "What we found so far"}</h2><p className="section-intro">{run.input.ideas.length} {run.input.ideas.length === 1 ? "idea" : "ideas"} checked · detailed checks on idea {run.focusIdea + 1}</p></div><span className="badge"><Icon name={complete ? "check" : "clock"} />{complete ? "Check complete" : "Partial results"}</span></div>
        <div className="source-notices">
          {usedMock && <Notice tone="synthetic" label="Synthetic demo">{status?.syntheticLabel ?? "Not Qloo data"}. All numbers, names and IDs in this run are generated locally.</Notice>}
          {noModelDraft && <Notice tone="info" label="Plain-draft mode">The first draft uses your words, with no guessed audience. Only cultural titles you quoted were looked up. The taste checks are recorded in Evidence.</Notice>}
          {usedFixture && !noModelDraft && <Notice tone="info" label={run.scenarioId ? "Prepared example" : "Draft fallback"}>{run.scenarioId ? "The agent’s draft text is a prepared example. The Qloo checks run against the connected data source; every recorded call is in Evidence." : "The live writer was unavailable. The selected idea keeps its first draft where available; review it before use."}</Notice>}
          {!usedFixture && !noModelDraft && ruleSteps.length > 0 && <Notice tone="info" label="Model fallback">Some writing steps used fixed rules. The taste checks and their sources are available in Evidence.</Notice>}
          {!usedMock && !usedFixture && !noModelDraft && ruleSteps.length === 0 && <p className="run-source"><span className="status-dot" />{complete ? "Live model draft + recorded Qloo checks" : "Model draft · evidence logged as checks complete"}<span>Affinity signals, not sales forecasts.</span></p>}
        </div>
        {run.errors.length > 0 && <Notice tone="error" label="Some checks are unavailable"><ul>{run.errors.map((error, i) => <li key={i}>{STEPS[error.step] ?? "Check"}: {error.message}</li>)}</ul></Notice>}
        {run.verdicts ? <><ChangeSummary run={run} /><div className="result-tabs" role="tablist" aria-label="Explore your results">{TABS.map((item, index) => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)} onKeyDown={(event) => { let next = index; if (event.key === "ArrowRight") next = (index + 1) % TABS.length; else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = TABS.length - 1; else return; event.preventDefault(); selectTab(TABS[next].id, true); }}>{item.label}</button>)}</div>
          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0} className="result-content">{tab === "verdicts" && <VerdictScreen run={run} />}{tab === "compare" && <CompareScreen run={run} qlooOff={qlooOff} setQlooOff={setQlooOff} />}{tab === "make" && <WhatToMakeScreen run={run} />}{tab === "who" && <WhoTheyAreScreen run={run} />}{tab === "receipts" && <ReceiptsScreen run={run} />}</div></> : <ReceiptsScreen run={run} />}
        <div className="result-footer"><p>Take the findings and their sources with you.</p><button className="button-secondary" onClick={() => downloadSummary(run, !!usedMock)}><Icon name="download" /> Download summary (.md)</button></div>
      </section>}
    </main>
    <footer className="site-footer"><a href="#" className="brand footer-brand" translate="no"><TasteMark /><span>Pretaste</span></a><p>Cultural taste signals via <span translate="no">Qloo</span>. Affinity, not sales forecasts. The decision stays yours.</p></footer>
  </div>;
}

const SPECIMEN = [
  { field: "Gender", guess: "Mostly women", signal: -0.6, read: "Leans toward men", verdict: "refuted" },
  { field: "Age", guess: "25 to 34", signal: 0.45, read: "Leans 25–34", verdict: "supported" },
  { field: "Also likes", guess: "Plant-care podcasts", signal: null, read: "Not among the top neighbors, so left open", verdict: "unverifiable" },
] as const;
const HOW = [
  { title: "The LLM guesses", text: "Drafts a listing and names the audience it imagines: age, gender, life stage, look, what else they like." },
  { title: "Qloo measures", text: "Finds comparable titles and brands in Qloo, then reads who shares that taste: demographic skew, taste neighbors, trends and regions." },
  { title: "Pretaste compares", text: "Marks each guess Supported, Challenged or Not established, ranks your ideas, and rewrites the listing with cited evidence." },
];

function downloadSummary(run: RunState, synthetic: boolean) {
  const url = URL.createObjectURL(new Blob([summaryMarkdown(run, synthetic)], { type: "text/markdown" }));
  const link = document.createElement("a"); link.href = url; link.download = `pretaste-${run.runId}.md`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
