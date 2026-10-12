# Figma review

Each capture run becomes one page in a Figma design file. The team annotates on that page by hand. Older runs stay in the file.

## Convention

- Page name: from `figma.pageNamePattern` in your config. The default is `{topic} · {datetime} · {runId}`, for example `my-project-editor · 2026-01-15 10:30 · my-project-editor-20260115-1030`. Tokens: `{topic} {date} {time} {datetime} {runId} {project} {workstream} {release}` (`{release}` needs `--release "<name>"` on `figma-plan.mjs`). The pattern must include `{runId}`, because the page name is how a repeat push is detected.
- Run ID: from `figma.runIdPattern`. The default is `{topic}-{yyyymmdd}-{hhmm}`, from the report's `capturedAt` in local time. Minute resolution means two captures in the same minute collide; wait a minute or remove the old page.
- Destination: `figma.fileKey`, the `:fileKey` in `figma.com/design/:fileKey/…`. The planner copies it into `figma-plan.json` so the `use_figma` and `upload_assets` calls use the same file.
- This is a naming convention, not Figma version history. The Plugin API can't create version-history entries. When the history must show a run, a person saves a version by hand (Cmd+Opt+S) after the push.

## Requirements

- The Figma MCP with `use_figma`, `upload_assets`, and `get_screenshot`, and the `figma:figma-use` skill loaded before the first `use_figma` call.
- Edit access to a **design** file (`/design/` URL). `figma.createPage()` isn't available in FigJam or Slides.
- The file key from `figma.com/design/<fileKey>/…`, set as `figma.fileKey` in the config.
- Quota: a run uses at least three MCP calls (page, upload URLs, verify). A View seat hit its tool-call limit during the proof of concept; an upgraded seat fixed it.
- Ask before pushing to a file that isn't the person's or the team's agreed review file. A push adds a page to a shared file.

## Steps

1. **Plan:** `node scripts/figma-plan.mjs --dir <out>/run1 --config p1-editor.config.json` checks the Figma settings and writes `figma-plan.json` and `figma-page.js`. It exits 1 and writes nothing if a "captured" shot has a missing or corrupt PNG, or the report has no usable shots. PNGs over 10 MB are flagged and left out.
2. **Page:** call `use_figma` with the contents of `figma-page.js`, the file key, and `skillNames: "figma-use"`. It creates the page, a header, and one named, empty rectangle per PNG, and returns `pageId`, `rootId`, and `nodeIds` in upload order. `createImageAsync` is blocked in `use_figma`, which is why images go in through upload URLs.
3. **Upload URLs:** call `upload_assets` with the file key, `count` = number of `nodeIds`, `currentPageId` = `pageId`, `nodeIds` exactly as returned, and `scaleMode: "FIT"`. Save the result's `uploads` array to `urls.json`. The field is `submitUrl`, not `url`. URLs are single-use and expire in 10 minutes. Up to 60 per call.
4. **Upload bytes:** `node scripts/figma-upload.mjs --dir <out>/run1 --urls urls.json`. The script refuses, before sending anything, any URL that isn't https on `figma.com` or a subdomain, and names the entry and host. Figma's upload URLs are on `https://mcp.figma.com` (first live push, 2026-10-06). Redirects are followed only when they are 307 or 308 and the target passes the same check, up to 3 hops. For a local mock server only, set `P1_UPLOAD_ALLOW_LOOPBACK=1`.
5. **Verify:** `get_screenshot` (or `node.screenshot()` in `use_figma`) on `rootId`, and check that there are exactly as many rectangles as shots, each with an image fill, with unique names and no fill on the wrapper frames.

## Duplicate protection

The generated code starts with a check for a page of the same name and throws `Page already exists: <name>. This run is already pushed.` before creating anything. To prove it, re-run the first page's complete, unmodified `figma-page.js`, then list the pages: one page per run ID.

## Inventory metadata

With `--inventory`, `figma-plan.mjs` also names each screenshot's frame `[screenshot_id] — short title — release — clean`, adds the ID, evidence state, planned Dev Resource links, asset checksum, and manifest commit to `figma-plan.json`, and writes `figma-manifest.json`. Every record is marked `planned`; nothing is called uploaded until a person records the real file URL and node ID with `inventory.mjs record-figma`. Annotate a frame named `... — annotated`; the annotated frame goes to the docs, and the clean frame stays as the unannotated capture. Name a Figma version at approval, annotation completion, and final handoff. Use a branch for a release rehearsal. See `screenshot-inventory.md`.

## Immutability and releases

A run's page is never edited or deleted by the tool. A refresh for a new release is a new run with a new run ID and, if the pattern has `{release}`, a new name. The earlier page stays as evidence of the old UI. See `release-refresh.md` for the comparison and rollback policy.

## What is tested without Figma

The generated `figma-page.js` runs in `npm test` against a mock of the Plugin API (`tests/figma-sandbox.mjs`), and the uploader runs against a mock upload endpoint. The tests check that:

- the page is named from the plan, with one named rectangle per upload, unique names, and node IDs returned in upload order;
- wrapper frames have no fill (the mock gives new auto-layout frames a default white fill, as Figma does);
- rows that need attention are marked, and missing or failed cells get a "(no image)" box;
- the same code run twice throws `Page already exists` before creating any node, a second run with another name coexists, and the first page is untouched;
- uploads send each PNG's real bytes as `image/png`, and one failed upload exits 1 and prints a `--only` retry line.

Mutation tests remove the fill reset and the duplicate guard and show the sandbox test failing. The mock follows the Plugin API as documented. It isn't Figma: real file permissions, quota, and image rendering are checked only in a live push.

## Retrying failed uploads

The uploader prints the index, key, local path, and HTTP status or network error for each failure, then exits 1. Files that succeeded keep their image. Request fresh URLs with `count` = the number of failures and the `nodeIds` of just those rectangles, in the order listed, then run:

```bash
node scripts/figma-upload.mjs --dir <out>/run1 --urls urls.json --only "editor-shell|next,publish-menu-open|next"
```

## Annotating

Use the Annotation kit for every mark. The kit components and the `Annotation` variables (Pantheon Design System colors) are in the design file, on the `Annotation kit · Components` page. Don't style marks by hand: place Highlight box, Step badge, Callout label, and Redact instances. Which mark to use, sizes, tones, and the redaction rule: [Annotate with the kit](../docs/how-to/annotate.md) and [Annotation kit](../docs/reference/annotation-kit.md). A person annotates on the run's page in Figma, or an agent does with `use_figma`, placing kit instances only. Suggested practice:

- Annotate in a separate frame named `[screenshot_id] — short title — release — annotated` that holds a copy of the image rectangle only. Don't duplicate the whole clean frame: it also holds the ID label and the HTTP caption, and those would end up in the docs image. Leave the clean frame untouched so the evidence stays intact.
- When the callouts are done, export the annotated frame as PNG at 2x, record it with `inventory.mjs record-asset --id <id> --file <export.png>`, and set `record-figma --annotation-status complete`.
- Mark callouts with numbers and keep the wording in the handoff note (`docs-handoff.md`).
- Note any UI state that changed since the previous run.
- Don't delete earlier run pages; they are the record of what the UI looked like at each release.
