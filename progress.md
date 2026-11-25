# Progress

## 2026-11-25

- Read current code/tests/workflow and prior diagnosis. Created managed worktree and codex/oil-dashboard-engineering branch.
- Loaded current Workers and Lightweight Charts docs. Reading skill guidance for implementation, planning, UI and deployment verification.
- Dispatched independent provider capability checks. Preparing clearly owned implementation workstreams.

- Implemented shared market snapshots and Worker APIs, UI, calendar, deterministic build and CI. Initial suite57 passed; UI adds12 behavior tests; calendar adds2 boundary regressions.
- Real browser desktop1440/mobile390/320 has no document overflow, chart canvases render and range buttons fit. Screenshots output/playwright/oil-desktop.png and oil-mobile.png.
- Real workerd caught unsupported redirect:error which Node tests did not catch. Changed fetch to manual with explicit non-2xx rejection; live8787market/curve both200. 1D history now spans actual futures trading session including SG morning.
- Independent core review found annual schedule coverage overstatement; restricted trailing partial years and added regression.
- At that stage, the Wrangler OAuth token was expired and GitHub secrets were absent; the user later renewed OAuth through device authorization.
- Existing GoogleNews via public Worker returns503 automated-query denial; evaluating independent RSS sources, without bypassing provider restrictions.

- Final precommit suite92/92, zero failures; production Worker bundle dry-run passed. Desktop/mobile and live workerd APIs checked.
- Added official RSS editorial API and source-time news markers. Corrected a feed integration missing helper detected by browser acceptance; regression covers production rendering.
- Added exact Worker source digest/capability gate before Pages deployment and post-deploy public asset verification. Review fiveP2 items fixed.
- Implementation and review complete; authenticated publication was pending before the 2026-11-26 SGT deployment closeout below.

## 2026-11-26 SGT deployment closeout

- Renewed Cloudflare OAuth with the user. Deployed Worker digest `5e366ee916faa4e0f59851e7576b025b88d80084176099bd05cea3ba778c4edc`.
- Merged PR #1 as Pages commit `7a6e895f6fb58ef08bfa31726a7da898d689f819`. GitHub Pages workflow passed tests, bundle, Worker preflight, artifact visibility, deployment, and verification of all 13 assets.
- Final public browser showed Yahoo BZ=F/CL=F prices, delayed status, explicit same-source previous closes, aligned spread, interactive chart, three curve contracts, 10 sourced calendar events and Oilprice/Guardian RSS articles. No browser console errors; viewport width remained 390px with no horizontal document overflow.
- Fast-forwarded the automatic OOTT-sync checkout to origin/main. Its existing `tmp/` screenshots were preserved.
- Report and plan now reflect deployment completion.
