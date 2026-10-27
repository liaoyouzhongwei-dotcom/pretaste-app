# Qloo parameters Pretaste sends, checked against the public guide

Checked 2026-10-22 against https://docs.qloo.com/reference/parameters and
https://docs.qloo.com/reference/insights-api-deep-dive. "Listed" = the parameter appears in the guide
for that call's entity type. "Silent-ignore risk" = if the server ignores it, the call still returns 200
and nothing tells us.

| Call (endpoints.ts) | Parameter | Listed in guide? | Silent-ignore risk | What Pretaste does about it |
|---|---|---|---|---|
| searchEntity `/search` | `query` | No (search has no page in the guide; reference/search is 404) | Low (the name is the search) | — |
| searchEntity | `types` | No | **High**: an ignored type filter lets a book or sports team stand in for a movie | Since 10/22: pick the first result whose `types` contains the requested URN; drop the name if none does (warning on the call record) |
| searchEntity | `take` | Listed for insights (default 20, max 50), not for search | Low | Raised 3 → 5 so the type check has more to choose from |
| demographics `/v2/insights` | `filter.type=urn:demographics` | Not in the filter table (no row names Demographics) | Low: a wrong type would not return `results.demographics`, and `expect` warns | — |
| demographics / neighbors / heatmap / trending | `signal.interests.entities` (comma list) | Yes, all entity types | Low | — |
| neighbors | `filter.type` (urn:entity:*) | Yes | Low | — |
| neighbors | `feature.explainability=true` | Yes (boolean) | Low | — |
| neighbors | `take=10` | Yes (max 50) | Low | — |
| neighbors | `filter.popularity.max=0.98` | Yes, 0–1, for artist, book, brand, destination, movie, person, place, podcast, tv_show, videogame = every kind in KIND_TO_URN | Low | — |
| compare `/v2/analysis/compare` | `a.signal.interests.entities`, `b.signal.interests.entities` | Not in the parameter guide | Medium: an ignored side gives no tags | Already handled: no tags on either side → overlap null + warning |
| trending `/v2/trending` | `filter.start_date`, `filter.end_date` | Not in the guide (only `bias.trends` is) | Medium | Live API refused calls without them (10/21), so they are read; keep |
| heatmap `/v2/insights` | `filter.type=urn:heatmap` | Deep dive names `urn:entity:heatmap` for `heatmap.dimensions`; we send `urn:heatmap` and get cells | Low (cells come back; `expect` warns if not) | — |
| heatmap | `filter.location.query=United States` | Listed only for Destination and Place | **High**: may be ignored for heatmaps | Harmless today: every cell is mapped to a US state by lat/lon (`stateOf`) and cells outside the US are dropped, states with <5 cells are dropped |

Not used but relevant: `output.heatmap.boundary` (default geohash; city / neighborhood exist),
`signal.demographics.age` / `signal.demographics.gender`, `diversify.by`, `bias.trends`.

## Link to the first measurement (10/22 06:33)

- Comparables from another field (a sports team among movies) fit the `types` row above: the old code
  only looked at the first result. Fixed in searchEntity; re-check in A3 (10/23).
- "Also likes" Lofi Girl → an unrelated manga book is a name match on a neighbor list, not a search
  parameter. It belongs to A3 (exact-name / ID matching).
- 61% "cannot check" is not explained by an ignored parameter in this table; it comes from claims the
  Qloo calls never measure. A2 / A5 territory.
