# Progress

## 2026-11-25

- Read current code/tests/workflow and prior diagnosis. Created managed worktree and codex/oil-dashboard-engineering branch.
- Loaded current Workers and Lightweight Charts docs. Reading skill guidance for implementation, planning, UI and deployment verification.
- Dispatched independent provider capability checks. Preparing clearly owned implementation workstreams.

- Implemented shared market snapshots and Worker APIs, UI, calendar, deterministic build and CI. Initial suite57 passed; UI adds12 behavior tests; calendar adds2 boundary regressions.
- Real browser desktop1440/mobile390/320 has no document overflow, chart canvases render and range buttons fit. Screenshots output/playwright/oil-desktop.png and oil-mobile.png.
- Real workerd caught unsupported redirect:error which Node tests did not catch. Changed fetch to manual with explicit non-2xx rejection; live8787market/curve both200. 1D history now spans actual futures trading session including SG morning.
- Independent core review found annual schedule coverage overstatement; restricted trailing partial years and added regression.
- Current deployment blocker: Wrangler4.168 confirms localOAuth expired/unrefreshable; GitHub repo has no Cloudflare secrets. All code/local validation proceeds before requesting login.
- Existing GoogleNews via public Worker returns503 automated-query denial; evaluating independent RSS sources, without bypassing provider restrictions.

- Final precommit suite92/92, zero failures; production Worker bundle dry-run passed. Desktop/mobile and live workerd APIs checked.
- Added official RSS editorial API and source-time news markers. Corrected a feed integration missing helper detected by browser acceptance; regression covers production rendering.
- Added exact Worker source digest/capability gate before Pages deployment and post-deploy public asset verification. Review fiveP2 items fixed.
- Implementation and review complete; authenticated publication remains pending. Preparing concrete commit/PR and CI evidence before requesting Cloudflare login.
