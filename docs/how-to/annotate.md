---
title: Annotate with the kit
parent: How-to guides
nav_order: 5
---

# Annotate with the kit

Add numbered marks, highlights, and redactions to each screenshot in an annotated frame the docs embed.

{% include video.html name="05-annotate" title="Annotating with the kit" poster="kit-assets-panel.jpg" %}

## Check the kit first

An older kit has the wrong colors and nothing flags it until an extraction comes back wrong. Check the file before
you annotate or extract in it:

1. Write the check and run it with `use_figma` in the review file. It only reads:

   ```bash
   node scripts/figma-kit-check.mjs --out kit-check.js
   ```

2. Save what it returns as JSON and verify it against `figma-plugin/annotation-tokens.json`:

   ```bash
   node scripts/figma-kit-check.mjs --result kit-check-result.json
   node scripts/preflight.mjs --config p1-editor.config.json --need figma --kit-result kit-check-result.json
   ```

   Preflight can't call Figma, so without `--kit-result` it prints these steps instead of passing the kit.

It exits 1 with a plain fix. Missing or different stamps (the file root's `tokensSchema` and `tokensHash`, and each
of the 13 components' `kit` stamp): run Plugins > Development > Screenshot annotation kit in this file. Variables
that don't hold the contract's values, or alias anything but the `brand/*` variables in `Annotation primitives`:
repoint them to the brand primitives, or delete the old Annotation collection and re-run the plugin. Fix the
variables first. The plugin reuses variables that already exist, so re-running it alone stamps the file and keeps
the old colors.

## Steps

1. Make the annotated frame beside the clean one: a frame the size of the image, holding a copy of the image
   only. Name it `[<id>] — <title> — <release> — annotated`. The clean frame stays untouched.
2. Open the Assets panel (**Option+2**) and drag marks onto the image:

   - **Highlight box** over the area the step is about. Resize it with the corner handles; never fill it.
   - **Step badge** next to each area, numbered in reading order.
   - **Callout label** when the UI element needs its name on the image.
   - **Redact** over names, emails, avatars, and IDs. Use **Solid** when blur might still leak text.

   {% include figure.html src="kit-assets-panel.jpg" alt="Figma's Assets panel listing the kit components: Arrow, Callout label, Click indicator, Cursor, Dim overlay, Highlight box, and more." caption="The kit in the Assets panel. Drag a component onto the image." %}

   <div class="shot-pair" markdown="1">

   {% include figure.html src="kit-highlight-box.jpg" alt="A purple Highlight box resized to fit the Blocks panel." caption="Highlight box, resized to the Blocks panel." %}

   {% include figure.html src="kit-step-badge.jpg" alt="A purple numbered Step badge placed beside the highlighted Blocks panel." caption="Step badge 1 beside it." %}

   </div>

3. Keep every mark inside the annotated frame, so it exports with the image. Check the Layers panel.

   {% include figure.html src="figma-annotated-layers.jpg" alt="Figma's Layers panel for an annotated frame: Step 1 to 4, Highlight 1 to 4, two Redact layers, and the screenshot, all nested in the frame." caption="Every mark nested inside the annotated frame. Step layers are named the way the alt text should read." %}

4. **Name each step layer the way it should be read**, for example `Step 4: the Review button`. The alt text
   is drafted from these names.
5. When the UI didn't change since the last release, copy last release's annotated frame and swap in the new
   image, then check every redaction still covers what it should.

Which mark to use for what: [Annotation kit](../reference/annotation-kit.html).

## Record it

After a reviewer approves the marks:

```bash
node scripts/inventory.mjs record-figma --id <id> --annotated-node-id <annotated frame node> --annotation-status complete --inventory <inventory>
node scripts/inventory.mjs transition --id <id> --to annotated --inventory <inventory>
```

Next: [Write alt text from the marks](alt-text.html).
