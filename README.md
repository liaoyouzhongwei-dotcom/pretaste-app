# Pretaste

**Your agent guessed. Qloo checked.**

Pretaste lets an LLM-only agent guess who will buy a product idea (age, gender, life stage,
aesthetic, what else they like, trend, region), then checks each guess against Qloo's taste data
and rewrites the listing with a receipt (the recorded Qloo call) for every Qloo-based claim.

## Run

Requires Node.js 20+.

```bash
npm install
cp .env.example .env.local   # optional; every value may stay empty
npm run dev                  # http://localhost:3000
```

Other scripts:

```bash
npm run build        # production build
npm run lint         # ESLint
npm run typecheck    # TypeScript (generates Next route types first)
npm run check-leaks  # scan the repo for keys and Qloo-response-like data
npm test             # regression tests (src/lib/*.test.ts, Node test runner, no keys or network)
```

Run the full pipeline against a server and save the result (no keys needed in mock/offline mode):

```bash
node scripts/pretaste-cli.mjs http://localhost:3000 --scenario coloring-japan --out .cache/runs/coloring.json
node scripts/evaluate.mjs    # Pretaste vs the same model alone on the dev inputs; calls the deployed app and the claude CLI; method in the file header
```

Run files and evaluation results contain Qloo response values, so they stay in `.cache/` (git-ignored) and are not published.

Enable the pre-commit guard once per clone:

```bash
git config core.hooksPath .githooks
```

## Environment variables

Put these in `.env.local` (git-ignored). Never commit keys.

| Name | Purpose |
| --- | --- |
| `QLOO_API_KEY` | Qloo hackathon API key. Sent only as the `X-Api-Key` header, only to `https://hackathon.api.qloo.com`, GET only. Empty = mock mode. |
| `QLOO_MODE` | Set to `mock` to force mock mode even when a key is present. |
| `PRETASTE_ANTHROPIC_API_KEY` | Anthropic key for Pretaste. `ANTHROPIC_API_KEY` is intentionally **not** read. Empty = offline mode. |
| `PRETASTE_MODEL` | Model for every LLM step (default `claude-sonnet-5-5`). `PRETASTE_MODEL_PLANNER` / `PRETASTE_MODEL_WRITER` override per role. |
| `PRETASTE_CACHE` | `file` stores live Qloo responses in `.cache/qloo` (git-ignored). Default: in-memory. |
| `PRETASTE_LLM_CALLS_PER_DAY` | Daily budget of live LLM calls (default `400`, `0` = none), counted by each server instance on its own, not shared across instances; the monthly spend cap on the Anthropic account is the hard ceiling. Past it, the prepared scenarios use their prepared text and say so, while the Qloo checks keep running; a custom idea still runs: its draft is the idea as written (no guessed audience, so every verdict says it cannot be checked), and only titles the maker put in double quotes are looked up in Qloo. Re-sending the same step of a run returns the saved answer and uses no new calls. |

## Mock and offline modes

Pretaste runs end to end with no keys at all.

- **Mock (no `QLOO_API_KEY`, or `QLOO_MODE=mock`)**: every Qloo call is answered by a local,
  deterministic generator (`src/lib/qloo/mock.ts`). Names are prefixed `[SYN]`, ids start with `SYN-`,
  and the screen shows **"SYNTHETIC — not Qloo data"**. None of these numbers come from Qloo.
- **Offline (no `PRETASTE_ANTHROPIC_API_KEY`)**: the agent's text (the blind guess, the comparables,
  the grounded listing) comes from prepared fixtures in `src/fixtures/scenarios.ts`, and the screen
  shows an "Offline" notice. Verdicts and rankings are always computed by fixed rules
  (`src/lib/rules.ts`) from the recorded calls. The prepared text covers the first idea only: when
  the ranking puts another idea in focus, the after listing repeats the before listing and is marked
  "model unavailable".

## Screens

1. **Verdicts** — the agent's seven guesses about the buyer, each marked supported / refuted / can't be checked, with the Qloo call behind it.
2. **Blind vs Grounded** — the LLM-only listing next to the Qloo-grounded one. "Qloo off" shows what would ship without taste data.
3. **What to make** — the ideas ranked by a fixed formula (affinity, trend, found, overlap), with "don't make (yet)" when the evidence is missing.
4. **Who they are** — what these buyers also like, age and gender skew, top US regions, and the cover direction (marked as interpretation).
5. **Receipts** — every claim linked to the recorded call, the claim checker's result, the agent's own decisions, and the call log with redacted params.

Each listing has a copy button, and the whole run can be saved as Markdown.

## Access

There is no login and no hard usage cap: anyone can run the prepared scenarios or their own idea.
See `PRETASTE_LLM_CALLS_PER_DAY` for how cost is kept in check without blocking.

## License

MIT — see [LICENSE](./LICENSE).
