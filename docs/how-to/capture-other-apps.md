---
title: Capture WordPress, Drupal, and other apps
parent: How-to guides
nav_order: 3.5
---

# Capture WordPress, Drupal, and other apps

Point the tool at any web app by choosing a preset in the config. Everything after capture (Figma,
alt text, swaps, and verification) is the same for every app.

## Choose a preset

| Preset               | For                                                                         | Sign-in                                                         |
| -------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `p1-editor`          | The P1 editor (the default when a config names no preset)                   | You, in the dedicated Chrome                                    |
| `wordpress-admin`    | wp-admin, the block editor, the Site Editor                                 | Login form, `WP_USER` and `WP_PASSWORD` from your shell         |
| `drupal-admin`       | Drupal administration pages (Claro)                                         | Login form, `DRUPAL_USER` and `DRUPAL_PASSWORD` from your shell |
| `content-publisher`  | Pantheon Content Publisher's dashboard                                      | You, in the dedicated Chrome                                    |
| `pantheon-dashboard` | The Pantheon dashboard: workspace pages and a site's environments           | You, in the dedicated Chrome                                    |
| `gdocs-addon`        | A Google Docs add-on's side panel, such as Content Publisher                | You, in the dedicated Chrome                                    |
| `word-addin`         | An Office add-in's task pane in Word for the web, such as Content Publisher | You, in the dedicated Chrome                                    |
| `public-site`        | Any public website                                                          | None                                                            |

Each preset has a starter brief in `briefs/<preset>.json` and an example config in
`examples/<preset>.config.example.json`. What each preset checks and hides: [Presets](../reference/presets.html).

## WordPress admin

1. Start a local site. [WordPress Studio](https://developer.wordpress.com/studio/) runs WordPress on PHP
   directly, with no Docker:

   ```bash
   studio site create --name docs-shots --path ~/Studio/docs-shots
   ```

   Studio shows the admin username and password. Its MCP tool returns the password base64-encoded: decode
   it before you sign in.

2. Write a config:

   ```json
   {
     "topic": "wp-docs",
     "preset": "wordpress-admin",
     "baseUrl": "http://localhost:8881"
   }
   ```

3. Put the sign-in in your shell for this session only. `read -s` keeps the password off the screen and
   out of your shell history:

   ```bash
   export WP_USER=admin
   read -s WP_PASSWORD && export WP_PASSWORD
   ```

4. Check, then capture:

   ```bash
   node scripts/preflight.mjs --config wp.config.json --brief briefs/wordpress-admin.json
   node scripts/capture.mjs --config wp.config.json --brief briefs/wordpress-admin.json --out-dir <out>/wp
   ```

   ```text
   Authenticating...
     dashboard                                     OK
     plugins                                       OK
     block-editor                                  OK
     site-editor                                   OK
     front-page                                    OK

   Done: 5/5 captured, 0 failed, 0 with HTTP >= 400
   ```

   <div class="shot-pair" markdown="1">

   {% include figure.html src="preset-wp-dashboard.jpg" alt="The WordPress dashboard with the admin menu, the Welcome panel, and the Site Health, At a Glance, and Quick Draft widgets." caption="dashboard: admin notices and update counts hidden." %}

   {% include figure.html src="preset-wp-block-editor.jpg" alt="The WordPress block editor on a new post, with the Post settings sidebar open and no welcome guide." caption="block-editor: the welcome guide is hidden, not dismissed." %}

   </div>

For a production site with single sign-on or two-factor authentication, add `"signIn": "chrome"` and the
`chrome` settings, and sign in yourself in the dedicated Chrome, as for P1.

## Drupal admin

1. Start a local site. With PHP 8.3 or later and Composer, Drupal runs on SQLite and PHP's built-in server,
   with no containers (about 160 MB):

   ```bash
   composer create-project drupal/recommended-project drupal-docs
   cd drupal-docs
   vendor/bin/dr install standard --site-name="Docs screenshots"
   cd web && php -S 127.0.0.1:8890 .ht.router.php
   ```

   `dr install` prints the admin password once. Drupal 11.4 replaced `core/scripts/drupal` with `dr`.

2. Write a config with `"preset": "drupal-admin"` and `"baseUrl": "http://127.0.0.1:8890"`, export
   `DRUPAL_USER` and `DRUPAL_PASSWORD` the same way, and capture with `briefs/drupal-admin.json`.

   <div class="shot-pair" markdown="1">

   {% include figure.html src="preset-drupal-content.jpg" alt="The Drupal Content administration page with the Navigation sidebar and an empty content list." caption="content" %}

   {% include figure.html src="preset-drupal-status.jpg" alt="The Drupal Status report showing Drupal 11.4.8, PHP 8.5.10, and SQLite." caption="status-report" %}

   </div>

## Content Publisher

1. Copy `examples/content-publisher.config.example.json`. Set `params.collectionId` to a collection's ID,
   from its URL, for the collection shot.
2. Start the dedicated Chrome with `node scripts/chrome.mjs --config <file>` and sign in with Google.
3. Capture with `briefs/content-publisher.json`.

The starter brief covers Overview, Collections, Sites, and one collection. It leaves out Accounts and Tokens,
which show account data. A trial account shows a free-trial banner across the top; the preset leaves it in.

## Public websites

Use `"preset": "public-site"`. To build a brief from a sitemap instead of the starter brief:

```bash
node scripts/routes.mjs --topic my-site --site https://example.com --sitemap
```

The preset hides common cookie banners and chat widgets, such as Qualified's docked sales chat on pantheon.io. A site behind a bot challenge fails closed: no PNG is saved.

## Desktop app windows

Use `scripts/capture-window.mjs` for a screen no browser can reach, such as an AI assistant's reply in Claude
Desktop or Cursor. It runs on macOS only.

1. Set the window up yourself: open the app, run the prompt, and leave the reply on screen. The script never
   clicks or types in the app.
2. Find the window, then capture it:

   ```bash
   node scripts/capture-window.mjs --list --app Claude
   node scripts/capture-window.mjs --app Claude --front --slug assistant-reply --topic my-doc
   ```

   ```text
     assistant-reply                              OK  Claude "Claude"  2990x2146 (2x)
   Report: screenshots/my-doc/capture-report.json
   ```

   The shot goes to `screenshots/<topic>/`, which git ignores, at the display's native resolution. It's added
   to that folder's `capture-report.json`, so [Push a run to Figma](push-to-figma.html) works the same way.

| Option             | Use it when                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `--title "<text>"` | The app has more than one window. Pass part of the title `--list` shows.                                 |
| `--front`          | The window is behind another app or in another Stage Manager group. Minimized windows can't be captured. |
| `--size 1440x900`  | Shots must match a set size. Needs Accessibility permission.                                             |
| `--delay 3`        | You need a few seconds to hover or open a menu first.                                                    |

The app running the command (Terminal, or Claude) needs Screen Recording permission in System Settings >
Privacy & Security. Before you share the PNG, check it for account names, file paths, and other people's data.

## Add your own app

Copy the closest preset in `scripts/presets/`, change its sign-in, CSS, and actions, and point a brief's
`presets` at it. [Presets](../reference/presets.html#write-a-preset) lists every field.

Next: [Push a run to Figma](push-to-figma.html).
