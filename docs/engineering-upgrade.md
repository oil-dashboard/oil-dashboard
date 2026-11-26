# Engineering upgrade acceptance

Scope: quote/reference correctness, source provenance, trading-session history, source health, futures curve, sourced release calendar, editorial source redundancy, interactive charts and a verified publishing pipeline.

## Correctness regressions

- Absolute and percentage change use the latest completed daily close for the exact same symbol and source, with an exchange-local bar date before the quote's session trading date. Weekends and holidays select the latest available earlier daily bar.
- Yahoo's daily chart may append a live quote at `regularMarketTime` after the exchange-midnight daily labels. Only midnight-labelled bars are eligible, so an overnight live value cannot become its own baseline; the implementation does not drop the final array element blindly.
- Futures change is rounded to the cent tick before percentage calculation, so float32 provider residue cannot render a false zero move with an up/down arrow.
- The previous daily close is selected by exchange trading date, not SGT calendar date, so a quote during Singapore morning and afternoon of the same exchange session uses the same baseline. The NYMEX continuous quotes use the New York session boundary.
- If the same-symbol prior daily bar is missing or invalid, both change fields stay null and the UI states that the daily previous close is unavailable. It never falls back to quote.previousClose, chartPreviousClose, or another symbol/source, and does not show a pending-confirmation label.
- Monthly chartPreviousClose and quote.previousClose can differ from the prior daily close, especially around a continuous-contract roll. They are informational context only and do not override the daily-close baseline; the UI never calls that baseline an official settlement.
- The API retains the legacy `previous-close` reference type for the current frontend and marks the rule with `basis: daily-close`. New clients reject legacy cached references without that basis.
- TradingView provider update time is separate from market price time; ten-minute delayed feeds remain delayed and cannot manufacture a synchronized spread.
- UTC timestamps remain unshifted. Exchange trading-date templates and IANA time zones determine sessions; complete holiday coverage is never claimed without a calendar.
- Full 1D futures-session history includes the Singapore morning rather than starting at New York midnight.
- Final snapshots and spread history are validated before caching/rendering. Incorrect source/symbol, impossible dates, future points, wrong spread arithmetic and invalid curve contracts are rejected.

## Local evidence

- `npm test`: 92 tests passed, zero failed at final precommit verification.
- `npm run deploy:worker -- --dry-run`: valid production bundle, 62.53 KiB / gzip16.92 KiB before final commit identity injection.
- Both GitHub workflows passed actionlint.
- Actual Wrangler/workerd, not only Node, returned HTTP200 for market, curve, calendar and editorial APIs with real upstream responses.
- A workerd-specific redirect incompatibility was caught and fixed: use manual redirects and reject non-2xx responses. Node success alone had not detected the unsupported error mode.
- Desktop1440px and mobile390/320px verified: document scrollWidth equals viewport; price chart visible, source/reference labels readable, all range controls reachable.
- Browser verified 1D/5D/1M, WTI/Brent/spread switching, exact contract curve, original source links, and publication-time event markers without inserting price points or claiming causation.
- Original GoogleNews RSS returned a real automated-query denial. Independent official Oilprice/Guardian RSS sources were verified and implemented rather than bypassing the denial.
- Independent reviews identified and fixed cache-write fallback regression, missing Worker calendar trigger, incompatible frontend/Worker deployment, unvalidated spread history, and malformed/wrong-instrument curve data.

## Publishing gate

Build-info describes public bytes with MIME/SHA256 and the required Worker source digest. The matching Worker protocol/capabilities/digest must pass before Pages publishes. After publishing, all actual assets and Worker identity are checked again. Data-only updates do not require matching Git SHAs across services.

The upgrade is merged and live. GitHub Pages commit `7a6e895f6fb58ef08bfa31726a7da898d689f819` is verified; the Worker source digest is `5e366ee916faa4e0f59851e7576b025b88d80084176099bd05cea3ba778c4edc`. The Pages workflow passed its pre-publish Worker compatibility gate and post-publish verification of all 13 public assets. The deployed market, curve, calendar, and news endpoints returned HTTP 200 during final checks.

## Known product limits

- Public feeds are delayed; this release does not promise exchange-authorized real-time prices.
- Public feed daily closes form the comparison baseline and are not represented as official exchange settlement prices. Continuous-contract rolls can make Yahoo's provider previousClose differ from the prior daily close for the same symbol; the provider field is not used as the baseline.
- Curves represent nearest unexpired concrete contracts and can differ from a continuous instrument's already-rolled active month.
- EIA schedule is dynamically verified with bounded coverage; API annual dates and monthly report dates have an explicit source-coverage end. Unverified future releases are omitted.
- Calendar actual/consensus/previous are unavailable until reliable statistic providers are added, and show em dashes.
