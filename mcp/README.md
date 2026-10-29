# Pretaste MCP server

Pretaste as a check any agent can call before it makes something. One MCP tool, `pretaste_check`, runs the full Pretaste pipeline (steps 0–10) on a Pretaste server, which checks the AI's buyer guesses for 1–3 product ideas against Qloo taste data. It returns:

- the verdict on each of the seven guesses for the focus idea: Supported, Challenged or Not established, with the reason and the evidence call ids
- the research-priority ranking: score out of 100 (not a sales forecast), the call and the reason
- the rewritten listing: title, tags, description
- checker counts, provenance (commit, Qloo mode, models) and a one-line `next` built only from those fields

`mcp/pretaste-mcp.mjs` is plain Node 20+ ESM with no npm dependencies. It speaks MCP over stdio (newline-delimited JSON-RPC 2.0, protocol `2025-06-18`) and logs only to stderr. It reuses `runPipeline` from `scripts/pretaste-cli.mjs`, so keep the two files together in a clone of this repo.

## Add it to a client

Server URL: `PRETASTE_URL` (default `https://pretaste.vercel.app`). Use `http://localhost:3000` to work against `npm run dev`.

Claude Code:

```bash
claude mcp add pretaste -- node /path/to/pretaste/mcp/pretaste-mcp.mjs
# against a local server:
claude mcp add pretaste -e PRETASTE_URL=http://localhost:3000 -- node /path/to/pretaste/mcp/pretaste-mcp.mjs
```

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pretaste": {
      "command": "node",
      "args": ["/path/to/pretaste/mcp/pretaste-mcp.mjs"],
      "env": { "PRETASTE_URL": "https://pretaste.vercel.app" }
    }
  }
}
```

A run takes about 40 to 60 seconds. The server sends a `notifications/progress` after each step when the client passes a `progressToken`. If your client times out tool calls sooner, raise its limit (Claude Code: `MCP_TOOL_TIMEOUT=120000`).

## Tool `pretaste_check`

Input (same limits as the web form and `POST /api/pipeline/0`):

| field | type | required | limits |
|---|---|---|---|
| `ideas` | string[] | yes | 1–3 ideas, 3–200 characters each, no personal data |
| `marketplace` | `"etsy"` \| `"kdp"` \| `"other"` | yes | |
| `priceUsd` | number | no | above 0, at most 10000 |
| `ownAssumptions` | string | no | at most 600 characters: the maker's own beliefs about the buyers. They are checked too (`makerChecks`) |

Output: `structuredContent`, with the same object as JSON in one text block. Idea numbers start at 1, as on screen. `score` is `null` for an idea with no taste signal to score.

Failures (bad input, rate limit, server error) come back as `isError: true` with a message. The server does not retry. Both Qloo and the model have limits, and each custom run spends the shared daily model budget, so agents should call it once per product decision and not in a loop. When the budget is used up, the run still finishes on the ideas' own words: `noModel` is `true` and there are no guesses to check.

## Example

Call:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "pretaste_check",
    "arguments": {
      "ideas": ["Coloring book of cats in small towns", "Coloring book of seasonal festivals"],
      "marketplace": "kdp",
      "priceUsd": 9.99
    }
  }
}
```

Result shape (placeholders only; real runs carry Qloo-derived values, which are never stored in this repository):

```json
{
  "runId": "<run id>",
  "focusIdea": 1,
  "focusText": "<idea text>",
  "guesses": [
    {
      "field": "age",
      "label": "Age",
      "guessed": "<the AI's guess>",
      "verdict": "Supported | Challenged | Not established",
      "reason": "<plain reason>",
      "evidenceCallIds": ["<call id>"]
    }
  ],
  "makerChecks": [
    { "text": "<one of your assumptions>", "verdict": "<verdict>", "reason": "<reason>", "evidenceCallIds": ["<call id>"] }
  ],
  "ranking": [
    { "idea": 1, "text": "<idea text>", "score": "<0-100>", "call": "Research first | Revise, then research | Lower research priority | Hold · more evidence needed", "reason": "<reason>" }
  ],
  "listing": { "title": "<title>", "tags": ["<tag>"], "description": "<description>" },
  "checker": { "downgraded": "<count>", "dropped": "<count>", "listingFixes": "<count>" },
  "coverageIncomplete": false,
  "noModel": false,
  "provenance": { "commit": "<git sha>", "qlooMode": "live | mock", "models": { "planner": "<model>", "writer": "<model>" }, "startedAt": "<ISO time>", "qlooCalls": "<count>" },
  "errors": [],
  "next": "Idea 1 (\"<idea text>\"): <call> — <reason>. Revise the challenged guesses (<fields>) before making it. ..."
}
```

`guesses` has seven entries: age, gender, life stage, aesthetic, also likes, trend, region (US).

## Test

`npm test` includes `mcp/pretaste-mcp.test.mjs`. It spawns the server and checks `initialize`, `tools/list`, `ping`, the errors and the input limits, plus the result mapping on a synthetic state. It makes no network calls.
