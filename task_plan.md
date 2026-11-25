# Oil Dashboard engineering upgrade

User authorization: implement the reviewed upgrade in sequence, with engineering quality. Existing public dashboard and Worker are the deployment targets. Preserve the auto-updating source checkout and its data.

## Acceptance and phases

- [x] Isolate the working copy and capture diagnosed failures.
- [x] P0: one verifiable quote snapshot per exact instrument; fix SGT morning reference; no cross-provider price/reference arithmetic; meaningful regression tests.
- [x] P1: source, quote time, trading date, reference price/date/type, freshness and final-result cache; reliable build/deployment metadata and checks.
- [x] P2: aligned spread/history; contract curve where verified source permits; sourced SGT energy release calendar; event deduplication.
- [x] P3: interactive 1D/5D/1M charts, reference line, usable mobile layout and accessibility.
- [x] Validate unit/integration tests, Worker bundle, local real-data behavior and desktop/mobile browser flows; independent review and fixes.
- [x] Deploy backwards-compatible Worker then site, verify public assets/data/API and report limitations with evidence.

## Architecture decisions

- Keep the static site and existing Cloudflare Worker; avoid introducing an application server or a framework migration.
- Shared pure market logic uses a browser/Node/Worker-compatible module; Worker supplies normalized snapshots. Frontend renders source semantics without guessing dates.
- All quote/reference timestamps remain UTC epoch seconds; SGT is display-only. No fixed SGT reset hour.
- Missing or unverified bases produce an unavailable percentage, never a fabricated zero or a cross-instrument calculation.
- Test replay fixtures include NY midnight before/after SGT noon, DST, weekends/holidays, stale quotes, invalid values, instrument switches and cache fallback.

## Outstanding decisions

None. Worker/data sources, account authorization and deployment verification have been completed.

## Errors

- Existing Pages runs uploaded an artifact but deploy-pages found zero artifacts. Reproduce/inspect before changing Actions based on speculation.

## Implementation acceptance evidence

- Atomic Yahoo quote.previousClose replaces NY-midnight inference; default BZ=F/CL=F provider continuous instruments. TV fallback exact instruments, independent bases, source update separated from price time.
- Real workerd8787 market/curve/calendar/news all200 after manual-redirect compatibility correction. Old Google RSS denied automated queries; official Oilprice and Guardian feeds verified independently and now power editorial API.
- Calendar sources verified for EIA standard/holiday schedule, API2026 annual publication PDF, IEA Dec11 and OPEC Dec14 date-only events. No fabricated statistics/precise monthly time.
- Desktop1440/mobile390/320 browser: working chart and quote UI; document scrollWidth matches viewport. Range/instrument/failure tests and independent code review performed.
- Independent review fixes completed: strict spread/curve schema validation, SW storage-failure behavior, and pre-publish Worker source-digest interlock.
- Cloudflare OAuth was renewed without storing credentials in the repository or GitHub secrets; deployment completed and public assets/API were verified.
