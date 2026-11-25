# Verified findings

- Active source: ~/.openclaw/workspace/oil-dashboard, main f411063. Managed worktree isolates the upgrade from background OOTT updates.
- Production app.js matches that source. Most recent price code change is July 23.
- Yahoo regular.start observed as NY midnight; prior code selected an older daily bar ahead of explicit quote.previousClose. Same-price constructed replay: SGT09 -> Nov23 / +4.5%; SGT14 -> Nov24 / +2.1%.
- 13 existing price tests pass despite missing this real shape.
- Existing TradingView fallback mixes CFD/continuous prices with Yahoo references, and fetchedAt with market time. Dead fallback helpers do not protect production.
- Last two checked Pages runs failed finding artifact; online OOTT file differs from HEAD.
- Prior read-only report: /tmp/oil-dashboard-review-2026-11-25.md.

## Learning references

- Fincept: atomic same-session quote snapshot.
- World Monitor: observation provenance, source time/frequency, market calendar and freshness tests.
- OpenBB: provider boundary and expiration-aware futures model.
- Lightweight Charts v5: addSeries(LineSeries), UTC seconds, Intl formatters for time zones, explicit attribution.
