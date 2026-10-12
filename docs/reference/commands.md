---
title: Commands
parent: Reference
nav_order: 1
---

# Commands

Every command a person runs, with its flags and what it refuses to do. Run them from the repository root.
`inv` below is short for `node scripts/inventory.mjs --inventory <inventory file>` (the default inventory is
`inventory/screenshots.json`).

{: .note }
Every command that writes to the inventory validates the result first and writes nothing if a record would
become invalid.

## Setup

| Command                          | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run setup`                  | Walks through every setup step; each can be skipped and each is safe to rerun.     |
| `npm run setup -- --status`      | Shows which steps are done. Changes nothing.                                       |
| `npm run setup -- --only <step>` | Runs one step: `tools`, `config`, `kit`, `markdown`, or `gdocs`.                   |
| `npm run build:figma-plugin`     | Rebuilds `figma-plugin/code.js` from `kit.json`. `-- --check` fails if it's stale. |
| `npm test`                       | Runs the full test suite. No browser sign-in, Figma, Google, or GitHub access.     |

Setup never asks for, prints, or stores a password or token. See [Set up the tool](../how-to/set-up.html).

## Capture

| Command                                                                                                             | What it does                                                                                                        | Refuses when                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/preflight.mjs --config <config> [--need capture,figma,handoff] [--brief <brief>] [--check-chrome]`    | Reports every missing or invalid config value at once.                                                              | — (exits 1 if anything required is missing)                                                                                                             |
| `node scripts/chrome.mjs --config <config> [--check]`                                                               | Prints the command that starts the dedicated Chrome; `--check` asks whether it's running.                           | It never starts Chrome itself.                                                                                                                          |
| `node scripts/capture.mjs --brief <brief> --config <config> --out-dir <dir> [--only <id>,<id>]`                     | Captures each shot in the brief from the signed-in editor.                                                          | The page shows sign-in, loading, a bot challenge, the public site, the wrong project or workstream, or no editor. That shot fails and nothing is saved. |
| `node scripts/capture-window.mjs --app <App> --slug <slug> --topic <topic> [--title <text>] [--front] [--size WxH]` | Captures one desktop app window (macOS) and adds it to the run's `capture-report.json`. `--list` shows the windows. | No on-screen window matches, more than one does (add `--title`), or the output folder isn't git-ignored.                                                |
| `node scripts/make-gallery.mjs --dir <run> [--title "…"]`                                                           | Writes `index.html` showing every shot in a run side by side.                                                       | —                                                                                                                                                       |
| `node scripts/compare-runs.mjs --old <run> --new <run> [--json <file>] [--fail-on-change]`                          | Lists each shot as `identical`, `changed`, `resized`, `new`, `removed`, or `failed`.                                | —                                                                                                                                                       |
| `node scripts/cleanup.mjs --config <config> --profile [--out-dir <dir>] [--yes]`                                    | Lists, then with `--yes` removes, the Chrome profile and capture folders.                                           | The Chrome is still running, the folder isn't a Chrome profile or capture run, or it's tracked by git. Handoff notes are never removed.                 |

## Figma

| Command                                                                                                                                                 | What it does                                                                                                                                                                                                                          | Refuses when                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/figma-plan.mjs --dir <run> --inventory <file> --config <config> [--release <r>]`                                                          | Writes `figma-plan.json` and `figma-page.js` for the run's Figma page. Uploads nothing.                                                                                                                                               | A captured shot's PNG is missing or corrupt.                                                                                                          |
| `node scripts/figma-upload.mjs --dir <run> --urls urls.json [--only <key>]`                                                                             | Sends each PNG to the single-use URL Figma returned.                                                                                                                                                                                  | Any URL isn't https on `figma.com`, or a redirect isn't a 307/308 to an allowed host. Nothing is sent.                                                |
| `node scripts/record-annotation.mjs --dir <run> --slug <shot> --annotated-node-id <id> --kit-only --redacted [--clean-node-id <id>]`                    | Records that a shot has an annotated frame in Figma, built from Annotation kit instances only, with personal data redacted. Writes `annotation-record.json` in the run folder.                                                        | Either attestation flag is missing, the annotated ID equals the clean ID, or the shot isn't in the run.                                               |
| `node scripts/handoff.mjs --config <config> --dir <run> --release "<name>" [--skip-annotation "<reason>"]`                                              | Writes the docs handoff note. Refuses until every shot has a recorded annotated frame (or an inventory record with `annotation_status` complete). `--skip-annotation` hands off anyway, and the note says the annotation was skipped. | A shot has no complete annotation record, or `--skip-annotation` has no reason. Nothing is written.                                                   |
| `FIGMA_TOKEN=… node scripts/figma-export.mjs --inventory <file> (--id a,b \| --status annotated) --out <dir> [--scale 2] [--record --assets-dir <dir>]` | Exports each record's annotated frame through the Figma API. `--record` runs `record-asset`.                                                                                                                                          | A record has no annotated frame node (the clean frame is never exported), an image host isn't allowed, a download redirects, or the file isn't a PNG. |

## Inventory

| Command                                                                                                                                                            | What it does                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inv validate [--against <file\|git:REF>]`                                                                                                                         | Checks every record; `--against` also checks status changes.                                                                                       |
| `inv list [--status s] [--release r] [--owner o] [--workstream w]`                                                                                                 | Lists records.                                                                                                                                     |
| `inv prereqs [--id id]`                                                                                                                                            | Shows what each record still needs for its next status.                                                                                            |
| `inv brief --config <config> [--release r] --out <brief>`                                                                                                          | Writes a capture brief from approved records.                                                                                                      |
| `inv release-check --version <v>` \| `--registry` \| `--app <app folder>`, with `--source <source>` \| `--package <npm package>` \| `--config <config>`            | Lists screenshots captured for an older version, and the command that retargets each. `--reopen` reopens them. Sources: [below](#release-sources). |
| `inv transition --id <id> --to <status> [--release r] [--reason "…"]`                                                                                              | Moves a record one step; `--to approved --release r` reopens it for a new release; `--to retired` needs `--reason`.                                |
| `inv record-capture --run <run> --assets-dir <dir>`                                                                                                                | Stores each captured PNG's checksum and size; approved records become `captured`.                                                                  |
| `inv record-figma --id <id> --evidence uploaded --file-url <u> --page-name "<p>" --node-id <clean> --annotated-node-id <annotated> [--annotation-status complete]` | Records where the record lives in Figma. Writes only what you pass.                                                                                |
| `inv record-asset --id <id> --file <png> [--assets-dir <dir>]`                                                                                                     | Stores the exported annotated PNG and its checksum.                                                                                                |
| `inv set-alt --id <id> --text "<alt text>" [--verified-at <time>]`                                                                                                 | Replaces a record's alt text. A verified record also needs `--verified-at`.                                                                        |
| `inv check-alt --id <id> --notes "<alt text from the page>"`                                                                                                       | Compares published alt text with the record, ignoring case and spacing.                                                                            |
| `inv handoff [--id id] [--out <file>]`                                                                                                                             | Writes the docs handoff: slot, caption, alt text, checksum, and the annotated frame to export.                                                     |
| `inv record-publication --id <id> --published-url <u> (--published-file <png> \| --published-sha256 <hex>) --verified-at <time>`                                   | Records what the published page serves.                                                                                                            |
| `inv lookup --id <id>` / `--doc <doc>` / `--unverified` / `--stale`                                                                                                | Reverse lookups.                                                                                                                                   |
| `inv trace [--assets-dir <dir>]`                                                                                                                                   | Read-only audit of every image's chain, from release to verification. Exits 1 on any missing link.                                                 |

Statuses and fields: [Inventory](inventory.html).

### Release sources

`release-check --registry` asks a source for the latest released version. Name it with `--source`, use
`--package <name>` for an npm package, or pass `--config` to use the default of the config's
[preset](presets.html). `--app <folder>` reads the version installed in an app, so it needs an npm source.

| Source                  | Reads                                                                                                                                                            | Example                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm:<package>`         | The `latest` dist-tag, through `npm view`, so private registries in `.npmrc` work                                                                                | `npm:@pantheon-systems/p1-next-sdk`                                                               |
| `github:<owner>/<repo>` | The latest GitHub release (GitHub skips drafts and prereleases). A repository that releases several packages tags them `@scope/name@1.2.3`; use `npm:` for those | `github:pantheon-systems/terminus`                                                                |
| `wordpress`             | WordPress core, from api.wordpress.org                                                                                                                           | `wordpress`                                                                                       |
| `wporg-plugin:<slug>`   | A plugin in the WordPress.org directory                                                                                                                          | `wporg-plugin:wp-redis`                                                                           |
| `drupal:<project>`      | A Drupal.org module or theme, its newest stable release                                                                                                          | `drupal:search_api_pantheon`                                                                      |
| `drupal`                | Drupal core, the newest stable release on Drupal.org                                                                                                             | `drupal`                                                                                          |
| `page:<url>`            | A version printed on a public page. `--pattern` is a regular expression whose first group is the version                                                         | `page:https://wordpress.org/download/` with `--pattern 'Download WordPress (\d+\.\d+(?:\.\d+)?)'` |

A prerelease version (`0.21.0-canary.1`) is refused: screenshots track shipped versions.

`release-check --product <id>` compares only the records whose `product` is that ID.

### Watch

| Command                                                                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/watch.mjs --watchlist <name\|file> --state <file> [--inventory <file>] [--update] [--only-new] [--json] [--since-days 14]` | Checks every product in the watchlist and its release-notes feeds, and lists the screenshots each change can affect, with the `release-check` command for each. Read-only; `--update` saves what was seen, and `--only-new` hides products with no change. Exits 3 when something is new. [How to](../how-to/detect-a-release.html#watch-everything-pantheon-ships). |

A watchlist (`watchlists/pantheon.json`) lists `products`, each `{ "id", "name", "source" }`, and `feeds`, each
`{ "id", "name", "url", "tagPattern", "tagProducts" }`. `tagPattern` is a regular expression run on each new
entry's page, whose first group is a tag; `tagProducts` maps a tag to the product IDs it can change.

## Docs

| Command                                                                                                                      | What it does                                                                                                                       | Refuses when                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `node scripts/draft-alt.mjs --marks <marks.json> --subject "…" [--id <id> --inventory <file> --apply]`                       | Drafts alt text from the frame's `Step N: …` layers; `--apply` saves it through `set-alt`.                                         | Steps aren't numbered 1 to N with no gaps or repeats.                                                 |
| `node scripts/publish-markdown.mjs --inventory <file> --assets-dir <dir> --repo <docs repo> [--branch <name>] [--dry-run]`   | Copies each release image over its mapped file and updates Markdown alt text; `--branch` commits only changed files. Never pushes. | A map path leaves the repo or isn't a PNG, an asset's checksum doesn't match, or alt text is missing. |
| `node scripts/gdocs-manifest.mjs --inventory <file> --repo <owner/name> --ref <commit> [--assets-root <dir>] [--out <file>]` | Writes the swap list the Apps Script reads, pinned to a commit.                                                                    | `--ref` isn't a full 40-character SHA, or the repo name is malformed.                                 |

The Apps Script functions are in [Google Docs swap](google-docs-swap.html).
