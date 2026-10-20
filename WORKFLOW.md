# Shipping: who built what

Transcripts: `~/.claude/projects/D--ClaudeProjects-Shipping/<id>*.jsonl`. Picture: `WORKFLOW.html`.

## 2026-10-20: first build of Ship Desk (nodeterm team, shared working tree)

**At a glance:** 5 Claude sessions: 1 orchestrator, 3 parallel builders, 1 QA station armed `--after-success` on all three.

```
orchestrator (research, CONTRACT.md, specs/, test harness, vendored libs)
   ├─> Data ──┐
   ├─> PDF  ──┼─> QA (e2e tests, screenshots, README, fixes) ─> orchestrator (check, landscape label)
   └─> UI   ──┘
```

**Timeline (CDT)**

| Time | What happened |
|---|---|
| 13:42 | User: build an app that does what tcgspeedshipper.com does, same CSV drop; no worktrees |
| 13:42-13:47 | Orchestrator reads the site + sample CSV + guides, vendors jsPDF/pdf.js/qrcode, writes serve.py, test harness, CONTRACT.md, 4 briefs |
| 13:48 | spawn-team: Data, PDF, UI start; QA armed after-success |
| 13:59 | Data reports success (39 tests) |
| 14:05 | PDF (50) and UI (13) report success; full run 104 passed |
| 14:02-14:17 | QA runs: 113 passed, screenshots checked |
| 14:17-14:22 | Orchestrator re-runs all tests, looks at screenshots, updates brain |
| 14:22-14:29 | User asks for a landscape label: thermal 6x4 added, 117 passed |

**Every session**

| Stage | Session | Role (node) | Time | Files | Built / found | Outcome |
|---|---|---|---|---|---|---|
| Lead | bce15ced | Orchestrator (term-mvh165ig) | 13:42-14:29 | serve.py, tools/test.py, app/tests/runner.js, run.html, harness.test.js, CONTRACT.md, specs/*, later render.js + tests + README (landscape) | Spec, harness, team; verified 113/113; added `thermal6x4` | done |
| Build | 6b69dd20 | Data (term-mvh1e25u-41847069) | 13:48-13:59 | app/js/csv.js, plan.js, tracking.js, paste.js, samples/tcgplayer-sample.csv, tests/data.test.js | CSV reader, plan + stamps, tracking match, import + Pirate Ship files, paste parser; 39 tests (found "Value" header gap itself) | done |
| Build | c8819c4f | PDF (term-mvh1e25u-a5b91bb5) | 13:48-14:05 | app/js/render.js, slips.js, tests/render.test.js | 8 formats, slips, design options, slip-PDF reader; 50 tests | done |
| Build | 37946309 | UI (term-mvh1e25u-c6d7d08c) | 13:48-14:05 | index.html, app.css, app.js, store.js, sw.js, manifest, icon.svg, Start Ship Desk.bat, tests/ui.test.js | Whole 4-step page, profiles, offline, phone layout; 13 tests; moved plan settings to step 2 (deviation, noted) | done |
| QA | f3bbcddd | QA (term-mvh1e78g-7fc05325) | 14:02-14:17 | tests/e2e.test.js, tests/pdf-preview.html, docs/make_screens.py, docs/screens/, README.md, docs/TEST_REPORT.md, small fixes in app.js/app.css/sw.js | 9 e2e tests (113 total), 16 screenshots looked at, 3 small fixes | done |

**What went wrong, and the lesson**
- Nothing blocked. Short launch prompts ("Read specs/x.md, it is your brief") avoided the cut-off-brief problem; no `LOOKS CUT OFF` flags.
- A shared test harness written and proven by the orchestrator before launch (headless Edge + results POSTed back) let all four stations test independently on a PC without Node.
- Explicit file ownership in the contract + "Requests" sections meant no station edited another's files; no requests were needed.
- First curl of the vendor libraries from cdnjs failed silently with `curl -f` in a `&&` chain (only qrcode was tried): check each download, jsdelivr worked.
