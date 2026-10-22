# Known limitations

## Capture

- **Page switching is a deep link, not a click, and isn't verified live.** The editor derives the page from the URL (`/p1` is `/`, `/p1/about` is `/about`, in the SDK's `editorPagePathFromUrlPath`), so each shot opens `<baseUrl>/p1<pagePath>`. The page selector must show `pageLabel` (default `pagePath`) or the shot fails. That is deterministic if the URL scheme holds, and fails closed if it doesn't. It was derived from the editor SDK source and tested against a fixture. Only `/` has been captured against a live editor. If your editor doesn't deep-link, set `pageNavigation: manual` and open the page yourself before each run. The tool doesn't click through the page navigator dialog.
- **Some canvas blocks select a neighbor.** On the demo project's home page, clicking three block types (`P1Stats`, `P1Features`, `P1Cta`) selected the block below, while `P1Hero` and `P1PullQuote` selected correctly. The cause isn't known. Every block shot now proves the selection by instance: the block's `data-puck-component` ID, exactly one selected overlay, that overlay's box matching the block's, and the properties panel naming the type (`six-shot-workflow.md`). A wrong selection fails the shot instead of shipping. Choose a `blockType` that works on your page.
- **The block proof depends on Puck's markup.** It reads the overlay's `--isSelected` class from Puck 0.21.x. It was tested against a fixture that follows that markup, with a mutation test, and not yet against the live editor after this change. A Puck upgrade that renames the class makes block shots fail closed.
- **The block proof accepts the type or the label.** The editor shows a component's label (`Notice`) where the block id holds its type (`NoticeBlock`). The properties panel check passes when the panel names either; the label is the first text in the selected overlay's toolbar. It fails closed when neither appears, or when the overlay shows no label and the panel doesn't name the type. Tested on a fixture with a toolbar; not yet run against the live editor.
- **`editorReady` breaks block selection at narrow viewports.** On 2026-10-21 at 1100 by 700, `editorReady` opened the Blocks drawer, the canvas iframe shrank to about 372 px, and the later block click selected nothing; with the panel collapsed the same click selected. `editorReadyKeepPanel` never toggles the panel. The fixture test shows the panel staying collapsed; the narrow-canvas effect itself isn't reproduced by the fixture.
- **An open category can sit below the fold.** `expandBlockCategory` skips its click when the category is already open, so nothing brought the category's blocks on screen. It now scrolls the category button into view after the click step, whether or not the click ran. Tested on a fixture with a category below the fold, not live.
- **`projectName` proves a match, not an absence.** A screenshot showed a project name that must never ship, and the check passed because the name matched the config. `forbiddenNames` fails a shot whose header label, page text, or same-origin frame text contains a listed name (case-insensitive). It doesn't read cross-origin frames, text inside images, or text that isn't rendered. It's tested on a fixture, not live.
- **`--final` relies on `devMode`.** `devMode` is true when the page has a `<nextjs-portal>` element. On 2026-10-21 a dev-overlay badge ("1 Issue", caused by a browser extension changing `<html>`) appeared in shots. `--final` fails any shot with `devMode: true`; an overlay built from another element isn't detected. Fixture-tested.
- **Zoom didn't work as a state change.** A zoom action showed the zoom toolbar but didn't visibly change the canvas scale, so it was removed. Shot 4 collapses the left panel instead.
- **Workstream can't be pre-seeded.** The editor keeps the chosen workstream per tab in `sessionStorage` and opens every new tab on the site's default workstream. Writing that value before the page loads had no effect, so shots pick the workstream through the selector.
- **Only the left panel is restored between shots.** The editor keeps other panel state across loads. If you add a shot that changes the right panel, add a matching restore.
- **Hosted dev sites may be challenged.** A hosted P1 dev site served a Cloudflare challenge to headless Chrome on the day of the proof of concept. The harness fails those shots. Use a local production build.
- **Selectors track the current editor.** Checks rely on `data-testid` values, ARIA labels, Puck's `data-puck-component`, and menu wording. Re-check them after an editor upgrade.
- **Screenshot comparison ignores isolated noise.** `compare-runs.mjs` treats fewer than 8 differing pixels in a 16 by 16 square as noise, because headless Chrome varies by about 10 pixels in 5 million. A change smaller than that threshold, such as one changed dot, goes unreported. Use `--exact` to see every difference.
- **Text checks are case-insensitive substrings.** A short workstream or project name also matches longer text in the same element.
- **The block category and publish text are defaults.** `blockCategory` defaults to `P1 Layout` and `publishMenuLabel` to `Publish this page to`. Both must match what your editor shows, or shots 2 and 6 fail closed.
- **Screenshots contain account details.** The avatar and real page content appear in every frame.
- **The debugging port is open.** While the dedicated Chrome runs, any local process can drive it.

## Figma

- **No true version history.** One page per run is a convention. A person saves a Figma version by hand when the history must show it.
- **Images go through upload URLs.** `createImageAsync` is blocked in `use_figma`. URLs are single-use, expire in 10 minutes, and accept up to 10 MB per asset and 60 per call.
- **Minute-resolution run IDs.** Two captures in one minute collide; the second push is rejected as a duplicate.
- **Seat quota.** A View seat exhausted its MCP tool-call limit during the proof of concept. Each run needs at least three calls.
- **An older kit gives wrong colors and nothing flagged it.** On 2026-10-21 an extraction returned `tokens: {schemaVersion: 0, hash: ""}`, every kit instance had `kitStamp: null`, `color/mark` resolved to `#7952A8` (the contract says `#3017A1`), `color/ink` to `#4A4844` (`#23232D`), there was no `color/redact`, and labels used Inter Bold. A plugin re-run stamped the new components and the file root but reused the old variables, which aliased a remote design-system library instead of the `brand/*` primitives. `figma-kit-check.mjs` reads the stamps and the resolved variables and compares them to `figma-plugin/annotation-tokens.json`. It's tested against a model of the plugin API and a result built from the older kit's variables; it hasn't run against a live Figma file.
- **`get_screenshot` caps the longest side at 1024 px.** A 2200 by 1400 export can't come back in one call. `export-frame.mjs` clones the frame, rescales the clone, cuts it into tiles of 1000 px or less, and stitches the downloaded tiles; the workaround was done by hand on 2026-10-21 (3 columns by 2 rows of 734 by 700). The script is tested with a model of the Figma API and synthetic tiles, not against live Figma. The frame must not sit in an auto layout frame.
- **Annotation is by attestation.** An agent or a person places Annotation kit instances in Figma, and nothing exports the annotated frames. `handoff.mjs` refuses until each shot is recorded with `record-annotation.mjs`, but that tool can't read Figma: it trusts the `--kit-only` and `--redacted` flags, so a reviewer still checks the frames.

## Screenshot inventory

- **Live runs so far are one author, one Figma file, and one P1 site.** On 2026-10-02 the author ran brief, capture, `record-capture`, gallery, Figma plan, and handoff against a signed-in local P1 editor, using a temporary inventory outside the repository. Figma pushes have run live since 2026-10-06 (`figma-review.md` records the first). On 2026-10-12 a run was captured, pushed, and uploaded, and an agent built annotated frames from the Annotation kit with `use_figma`, in the author's design file, without an inventory. Nothing has run against Google Docs or Content Publisher, and no second person has run it. Everything else in the inventory workflow is tested with fixtures and mocks. Dev Resource links and Figma version names are planned and recorded, not created in Figma.
- **The uploader only sends to Figma hosts, including after a redirect.** `figma-upload.mjs` refuses, before sending anything, a URL that isn't https on `figma.com` or a subdomain. Figma's real upload host is `https://mcp.figma.com` (seen on the first live push, 2026-10-06), which passes. Redirects aren't followed automatically: only 307 and 308 (which keep the POST and its body) are followed, each target must pass the same check before anything is sent to it, and the uploader stops after 3 hops. `P1_UPLOAD_ALLOW_LOOPBACK=1` allows loopback hosts for local tests only. Whether Figma's upload URLs ever redirect hasn't been observed.
- **Figma evidence is whatever a person recorded.** Nothing reads Figma back to check a file URL, node ID, or version name.
- **Publication is verified by a person.** The tool compares alt text fingerprints and records the result; it doesn't fetch the published page. Content Publisher may re-encode images, so the published file's checksum can differ from the asset's.
- **A new version is detected automatically, but capture isn't unattended.** `release-check` finds the screenshots a new SDK version puts in question and reopens them. The capture itself needs a person's signed-in Chrome. It also can't tell whether the app you capture runs the new version unless you pass `--app`.
- **Publishing to the docs is manual, and automating it is deferred.** Revisit after the docs destination is settled (Google Docs and Content Publisher, P1 pages, or GitHub). Alt text flows from a Google Doc into the published page, per the team.
- **One capture run covers one project, workstream, and page.** Records for other targets need their own run.
- **The inventory is empty until someone adds records.** The shipped file holds none, and the tool invents none.

## Docs handoff

- **Figma to Google Docs is unverified, and nothing in the repository connects them.** The docs site's content comes from Pantheon Content Publisher (Google Docs); the repository has no Figma reference. `docs-handoff.md` lists what was inspected. The handoff is a written note and a manual export.
- **No documented destination for the final images.** The tool doesn't know where the docs author stores them; the note has a `TO FILL` line for it.

## Not tested

- Operating systems other than macOS; Chrome versions other than the two used in the proof of concept.
- Sign-in by someone other than the author, or on another machine. The live second-user smoke test is **pending** (`second-user-smoke-test.md`); only the offline second-project test has run.
- Projects, workstreams, and pages other than the demo project's, on a live editor.
- A release-time refresh against a real release. The release rehearsal runs against two fixture editors (`release-refresh.md`), not P1.
- A live signed-in capture and Figma push by a second person or on a second project. Both ran live once on 2026-10-12 (one author, one P1 site, one Figma file). `npm test` covers them with a fixture editor, a Figma API mock, and an upload mock. Those follow the documented contracts but aren't P1 or Figma, so a second live run can still find a mismatch.

## Repository

- The tool inherits the p1-docs repository license (GNU GPL v3, `LICENSE.md`) and adds no license of its own.
- The imported history keeps the six proof-of-concept commits, whose subjects use the Emoji-Log style rather than the conventional-commit style p1-docs uses, and whose hashes differ from the originals (`poc-results.md`). p1-docs squash-merges pull requests, and a squash merge collapses the imported history into one commit. Merge this branch with a merge commit (not a squash) if the proof-of-concept history should be kept.
