---
name: screenshots-to-docs
description: "Use when creating or refreshing docs screenshots of a web app for a release or a UI review: the P1 editor, WordPress admin, Drupal admin, Pantheon Content Publisher, a public website, or any app with its own preset. A per-run config names the preset, the base URL, how the person signs in (their signed-in dedicated Chrome, a local login form read from environment variables, or none), the Figma destination, and the handoff location. Captures fail closed on sign-in, loading, challenge, and wrong-page states; each run goes to Figma for annotation; alt text is drafted from the marks; and a release swaps images and alt text into Markdown docs and Google Docs from a commit-pinned manifest. It never signs in for the person or publishes.""
---

# Screenshots to docs

Capture trustworthy screenshots of a web app, put each run in Figma for manual annotation, and hand the docs author a note they can act on without having run the capture.

**Targets.** The config's `preset` picks the app: `p1-editor` (the default; the workflow below describes it), `wordpress-admin`, `drupal-admin`, `content-publisher`, `pantheon-dashboard`, `gdocs-addon`, `word-addin`, or `public-site`. Each preset in `scripts/presets/` declares the settings it needs, how the person signs in, CSS that hides notices and banners, and named checks; each has a starter brief in `briefs/` and an example config in `examples/`. A form sign-in reads the username and password from environment variables the person exports; never ask for, print, or write those values. Release detection takes `--source` (`npm:`, `github:`, `wordpress`, `drupal`, `page:`) or the preset's default. Details: `docs/reference/presets.md` and `docs/how-to/capture-other-apps.md`.

Nothing here is tied to one person or project. Each run takes its settings from a config file: for the P1 editor, the P1 base URL, project name, workstream, page, Chrome profile and debugging port, Figma destination and naming, and where the handoff note goes (`references/configuration.md`). The workflow was proven end to end once, on a demo project; the record is in `references/poc-results.md`, and the shape of its config is in `examples/proof-of-concept/`, with placeholders, as an example only.

## Always do, without asking

Every run does all three. Don't ask whether to do them and don't offer to skip them. If a person says to skip one for a run, follow that and write the skip in the handoff note.

1. **Push the run to Figma** (workflow step 6), to the saved `figma.fileKey`. Ask only when no file key is saved, or the saved file isn't the person's or team's agreed review file, because a push adds a page to a shared file.
2. **Annotate every shot in Figma with the Annotation kit** (workflow step 7): one annotated frame per shot, built from kit instances only (Highlight box, Step badge, Callout label, Redact). Never style marks by hand: no custom colors, boxes, or legends. Read `docs/how-to/annotate.md` and `docs/reference/annotation-kit.md` first. An agent annotates with `use_figma` by default; a person reviews.
3. **Redact avatars, names, emails, and IDs** on every shot, with the kit's Redact component.

## What this skill does not do

- It doesn't capture the published site. The page path shown in the editor header is the page being edited, not a route to visit.
- It doesn't sign in for anyone. A person completes Google sign-in in a browser window; the harness never sees credentials.
- It doesn't publish to the P1 docs. A release can swap images and alt text into Google Docs from a commit-pinned manifest with an Apps Script, and a person still clicks Publish in Content Publisher (`references/release-swap.md`, built and tested against mocks; the live run is pending). Otherwise the handoff is manual (`references/docs-handoff.md`).
- It doesn't create true Figma version-history entries. One page per run is the convention; a person saves a Figma version by hand if the history must show it.

## Safety rules

1. Every screenshot comes through the signed-in editor route. Fail closed on a sign-in screen, "Loading/Authenticating", a bot-challenge page, public-site content, missing editor chrome, the wrong project, or the wrong workstream.
2. A person completes Google sign-in interactively in the dedicated Chrome window. Never ask for, print, store, or automate Google credentials, MFA codes, cookies, tokens, or recovery codes. Never put them in the config, a brief, or a chat.
3. Never use the regular Chrome profile. Chrome refuses a debugging port on it, and it holds the person's real sessions. Use a separate `chrome.profileDir`.
4. Never commit or upload a browser profile, storage state, cookies, upload URLs, or scratch output. Validation refuses a profile directory inside a git repository or this tool's folder. Check `git status` before any commit.
5. Never click an item in an editor menu. The More actions menu contains a delete action. Open menus only to look at them.
6. Don't bypass bot protection (no user-agent spoofing, challenge solving, or stealth tooling). Capture from an unchallenged origin instead.
7. Don't push to Figma until a validation screenshot has been inspected and shows the signed-in editor.

Details and reasons are in `references/safety.md`.

## Terms

- **Workstream:** an isolated line of work on a P1 site. Every site has a default workstream, and the editor's selector lists the rest. No workstream is assumed: the person names the one to show, for each run.
- **Button wording differs by workstream.** The editor shows a **Publish** button on some workstreams and **Review** on others. Read what your editor shows; don't assume.
- **Run:** one capture of the full brief. Its run ID comes from `figma.runIdPattern` (default `<topic>-<YYYYMMDD>-<HHmm>`), from the report's `capturedAt`.

## Prerequisites

- Node 18 or later (CI uses 20), npm, and Google Chrome. `bash scripts/setup.sh` checks them and runs `npm ci`. First time here? `references/contributor-setup.md`.
- A P1 site running at an origin you can reach. A local production build (`next build && next start`) is best for final shots. A hosted origin behind a bot challenge won't work.
- The P1 MCP, to look up projects, workstreams, pages, and block types.
- Figma (always used): the Figma MCP (`use_figma`, `upload_assets`, `get_screenshot`), edit access to a design file, and its file key. Load the `figma:figma-use` skill before the first `use_figma` call. A run uses at least three Figma calls.

## Workflow

### Coverage comes from the inventory

Which screenshots to capture is decided by `inventory/screenshots.json`, not by this skill or by routes. Add a record for each documented need, approve it, then generate the brief from the approved records (`node scripts/inventory.mjs brief`). Every report, gallery, Figma plan, and handoff then carries the record's stable `screenshot_id`, caption, and alt text unchanged. The stock six-shot brief below still works for a quick editor tour without an inventory. Full guide: `references/screenshot-inventory.md`.

### 1. Choose the values and write the config

Look for a saved config first: `<preset>.config.json` in the repository folder (for P1, `p1-editor.config.json`; these files are git-ignored). Run `preflight.mjs` on it (below). When it passes, don't ask again for values it already holds (base URL, project, Chrome profile and port, Figma file, handoff folder). Ask only what changes per run, in one message:

- Which release or change is this for, and which screenshots does the doc need?
- For P1: which workstream and page, if not the saved ones?
- Does any shot show a desktop app (Claude Desktop, Cursor, VS Code) instead of a web page? Capture those with `scripts/capture-window.mjs` (see "Desktop app windows" below).

Pass a per-run change with `--set key=value` instead of editing the saved file. With no saved config, ask the full list and write one. Ask, then confirm with the P1 MCP (`list_sites`, `list_branches`, `list_documents`, `get_document`):

1. Which P1 base URL? If it isn't running, the person starts it in their own terminal.
2. Which project and workstream should the screenshots show? Choose them for this run.
3. Which page is being edited? Each shot deep-links to it (`<baseUrl>/p1<pagePath>`); the editor's page selector must show it.
4. Which block should shots 3 and 4 select? (Optional; without one, those shots are skipped and reported.)
5. Which Chrome profile directory and debugging port? (Outside every repository; a free port.)
6. Which Figma file, and how should run IDs and page names look? Take these from the saved config; ask only if they are unset. Whether to use Figma is never a question (see "Always do, without asking").
7. Where does the handoff note go, and in which format?
8. Which release or change is this for? (It goes in the handoff note.)

Copy `examples/config.example.json` to `p1-editor.config.json`, fill it in, and check it without opening a browser:

```bash
node scripts/preflight.mjs --config p1-editor.config.json --need capture,figma,handoff --brief briefs/p1-editor.json
```

Fix every line it reports. `--dry-run` on `capture.mjs` also prints the resolved shots.

### 2. Start the dedicated Chrome

```bash
bash scripts/setup.sh
node scripts/chrome.mjs --config p1-editor.config.json      # prints the launch command; run it yourself
node scripts/chrome.mjs --config p1-editor.config.json --check
```

The printed command starts a separate Chrome instance with your profile directory and debugging port. The regular Chrome is left alone. While it runs, any local process can drive it through the port; close the window when you're done.

### 3. The person signs in

Ask the person to complete the Google sign-in in that window, choose the workstream in the editor's selector, and tell you when the Blocks panel, canvas, and properties panel are on screen. A page that says "Loading Authenticating…" or asks the person to log in isn't signed in. Stop and ask again.

### 4. Validation shot

```bash
node scripts/capture.mjs --brief briefs/p1-editor.json --config p1-editor.config.json \
  --only editor-shell --out-dir <out>/validate
```

Open the PNG. It must show the editor header, the project, the requested workstream, the page, the Blocks panel, the canvas, and the properties panel. If it doesn't, don't continue.

### 5. Capture the six shots

```bash
node scripts/capture.mjs --brief briefs/p1-editor.json --config p1-editor.config.json --out-dir <out>/run1
```

The capture attaches to `http://127.0.0.1:<chrome.cdpPort>`. Open every PNG from this exact run. Check that each is distinct and legible, with no stray tooltip, stale menu, or loading state. `references/six-shot-workflow.md` lists the shots, their actions, and what each check proves.

| #   | Slug                            | State                                                                |
| --- | ------------------------------- | -------------------------------------------------------------------- |
| 1   | `editor-shell`                  | Full editor, Blocks panel open, the configured page                  |
| 2   | `blocks-browser`                | All block categories expanded, `blockCategory` visible               |
| 3   | `block-selected-properties`     | The configured block selected, its properties open                   |
| 4   | `block-selected-canvas-context` | Same block selected, Blocks panel collapsed, canvas wider            |
| 5   | `workstream-selector-open`      | Selector open, the configured workstream listed                      |
| 6   | `publish-menu-open`             | More actions menu open on the workstream, the publish option visible |

### 6. Push to Figma

```bash
node scripts/figma-plan.mjs --dir <out>/run1 --config p1-editor.config.json
```

Then follow `references/figma-review.md`: run `figma-page.js` with `use_figma`, request upload URLs with `upload_assets` (`scaleMode: "FIT"`, the returned `nodeIds`), upload with `scripts/figma-upload.mjs`, and verify the page. The page name comes from `figma.pageNamePattern`.

For a first delivery or a release-critical refresh, capture a second time (wait for the next minute so the run ID changes) and push it as its own page. Then re-run the first page's unmodified generated code. It must be rejected with `Page already exists`, and the page list must show one page per run ID.

### 7. Annotate and hand off

Annotate every shot in Figma with the Annotation kit. This is required and is never offered as a choice: an agent places kit instances with `use_figma` (`docs/how-to/annotate.md`, `docs/reference/annotation-kit.md`), and a person reviews and adjusts. Hand-styled marks are a defect. Record each annotated frame, then generate the handoff note and fill in its `TO FILL` lines:

```bash
node scripts/record-annotation.mjs --dir <out>/run1 --slug <shot> --annotated-node-id <id> --kit-only --redacted   # once per shot
node scripts/handoff.mjs --config p1-editor.config.json --dir <out>/run1 --release "<release or change>"
```

`record-annotation.mjs` is an attestation that the marks are kit instances only and personal data is redacted; pass the flags only if that's true. `handoff.mjs` refuses to write the note until every shot is recorded (or has an inventory record with `annotation_status` complete). A person can pass `--skip-annotation "<reason>"` to hand off anyway; the note then says the annotation was skipped.

It writes the note to `docs.handoffDir`. For a refresh, add `--previous <earlier run>` to list what changed (`references/release-refresh.md`). Don't say screenshots reached the P1 docs unless that export was verified (`references/docs-handoff.md`): the Google Docs swap in `references/release-swap.md` replaces images already in a doc; the first insertion and every publish are still manual.

### Desktop app windows

A browser preset can't reach a desktop app's window, such as an AI assistant's reply in Claude Desktop or Cursor. The person sets the window up (opens the app, runs the prompt, leaves the reply on screen), then:

```bash
node scripts/capture-window.mjs --list --app Claude
node scripts/capture-window.mjs --app Claude --front --slug assistant-reply --topic <topic> [--title "<window title text>"] [--size 1440x900]
```

It captures only that window, at native resolution, into `screenshots/<topic>/` and adds the shot to that folder's `capture-report.json`, so `figma-plan.mjs` and the rest work unchanged. It needs macOS and Screen Recording permission for the app running the command; `--size` also needs Accessibility permission. The window must be on screen (not minimized, and in the current Stage Manager group); `--front` brings the app forward. It never clicks or types in the app. Check the PNG for account names, file paths, and other people's data before it goes anywhere.

### 8. Clean up

Close the debugging Chrome, then remove the profile and capture folders with `node scripts/cleanup.mjs --config p1-editor.config.json --profile --out-dir <out>/run1` (lists only) and `--yes` (removes). See `references/contributor-setup.md`.

## Validation and duplicate protection

- Missing or invalid configuration is reported before any browser opens (`preflight.mjs`, and the start of every script).
- Unknown actions, missing action parameters, and unset `{{placeholders}}` fail before a browser opens.
- Each action carries checks; a failed check saves no PNG and exits 1. Every shot checks the project name, page, and workstream.
- A challenged or HTTP 403 shot fails and saves no PNG.
- The planner refuses a report whose "captured" shots have a missing or corrupt PNG, or no usable shots.
- The generated Figma code throws `Page already exists: <name>` before creating anything when the run ID is already in the file.
- Inventory records are validated for source, destination, capture state, alt text, and secrets; a missing alt text or an uncovered shot stops the handoff.
- Block shots prove the block instance (selected overlay matches the block, panel names its type) and fail on a neighbor.
- `compare-runs.mjs` compares two runs and ignores isolated pixel noise; `cleanup.mjs` and the `--out-dir` guard keep captures and profiles out of commits.
- `npm test` runs the regression and portability suite against local fixtures, with mutation checks. It needs Chrome but no P1, Figma, or Google access. `node scripts/validate-skill.mjs` checks this file; `node scripts/check-identity.mjs` checks commit and file emails. CI runs all three on changes to this folder.

## Completion checklist

- [ ] Inventory: every screenshot has an approved record with a documented reason; `node scripts/inventory.mjs validate` passes.
- [ ] Config filled in by the person running it; `preflight.mjs` passes.
- [ ] Signed-in editor, not the public site; the person completed Google sign-in interactively.
- [ ] The requested project, workstream, and page shown in the editor.
- [ ] Validation shot inspected before the full run.
- [ ] Six distinct, inspected PNGs from the delivered run (or the skipped ones reported); report shows all captured.
- [ ] Figma page has one image-filled rectangle per shot, unique names, transparent wrappers.
- [ ] Every shot has an annotated frame the size of the image, built from Annotation kit instances only, named `[<id>] — <title> — <release> — annotated`, with step layers named `Step N: the <element>`.
- [ ] Avatars, names, emails, and IDs are redacted in every annotated frame.
- [ ] Every annotated frame is recorded with `scripts/record-annotation.mjs`, and the handoff note says `Annotation: Complete` (or states why it was skipped).
- [ ] Duplicate-run re-run rejected; one page per run ID.
- [ ] Handoff note written; no claim of automated Google Docs export.
- [ ] Known limitations recorded.
- [ ] No credentials, profile, storage state, upload URLs, or scratch output in any repository (`git status`, `gitleaks`).

## References

- `references/configuration.md`: every setting, and how to choose the values per run.
- `references/safety.md`: credentials, browser profile, storage state, menus, challenges.
- `references/six-shot-workflow.md`: the shots, actions, and checks.
- `references/figma-review.md`: pushing runs, naming, verifying, annotating, retrying.
- `references/screenshot-inventory.md`: the inventory schema, lifecycle, Figma conventions, docs mapping, verification, and a worked example.
- `references/release-refresh.md`: refreshing screenshots when a release changes the UI, comparing runs, versioning, rollback.
- `references/contributor-setup.md`: setup, tests, cleanup, and contributing for someone new to the tool.
- `references/second-user-smoke-test.md`: the second-user and second-project test; the live run is pending.
- `references/docs-handoff.md`: the handoff note, and the unclear Google Docs connection.
- `references/walkthrough.md`: the whole release process step by step, who does what, and problems seen in the rehearsal.
- `references/release-swap.md`: alt text drafted from the marks, Figma REST export, and the commit-pinned Google Docs swap (Apps Script).
- `references/known-limitations.md`: what doesn't work or isn't proven.
- `references/poc-results.md`: what the proof of concept verified.
- `references/nextjs-screenshots-harness.md`: the harness reference (brief schema, steps, checks, failure modes).
