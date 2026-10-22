---
title: Export and hand off
parent: How-to guides
nav_order: 7
---

# Export and hand off

Export each annotated frame as a 2x PNG, record its checksum, and hand it to the docs owner.

{% include video.html name="06-export-handoff" title="Export and hand off" poster="figma-export-2x.jpg" %}

## Steps

1. Export the annotated frame. Either:

   - **With a Figma token** (`file_content:read`), export every annotated record at once:

     ```bash
     FIGMA_TOKEN=<your token> node scripts/figma-export.mjs --inventory <inventory> --status annotated --out <dir> --record --assets-dir <assets>
     ```

     It exports the annotated frame only, never the clean one. Set the token in your shell; it's never
     printed or written to a file.

   - **By hand**: select the annotated frame, add an export setting **PNG, 2x**, export it, then record it:

     ```bash
     node scripts/inventory.mjs record-asset --id <id> --file <exported png> --assets-dir <assets> --inventory <inventory>
     ```

   A 1440 by 900 frame exports at 2880 by 1800.

   {% include figure.html src="figma-export-2x.jpg" alt="Figma's Export section for the annotated frame, set to 2x PNG." caption="The export setting: PNG at 2x." %}

   The Figma MCP can't do this export in one call: [export through the MCP](#export-through-the-figma-mcp-past-the-1024-px-cap).

2. Mark it handed off and write the handoff:

   ```bash
   node scripts/inventory.mjs transition --id <id> --to handed_off --inventory <inventory>
   node scripts/inventory.mjs handoff --inventory <inventory> --out handoff.md
   ```

   The handoff lists each image's docs slot, caption, alt text, checksum, and the annotated frame's node.

3. Commit the exported images and the inventory change to the repository that holds screenshots, in one pull
   request per release. The diff shows each old and new image.

## Export through the Figma MCP past the 1024 px cap

The Figma MCP's `get_screenshot` returns at most 1024 px on the longest side. A 1100 by 700 frame at 2x is 2200
by 1400, so it can't come back in one call. `scripts/export-frame.mjs` clones the frame, rescales the clone, cuts
it into tiles of 1000 px or less, and stitches the tiles you download. A tile under the cap comes back at full
resolution.

1. Write the plan code and run it with `use_figma`:

   ```bash
   node scripts/export-frame.mjs plan --node-id <annotated frame node> --scale 2 --name <id> --out plan.js
   ```

   It rescales only the clone, never the frame you pass. It returns the grid (2200 by 1400 is 3 columns by 2 rows
   of tiles 734 or 732 by 700) and each tile's node ID, row, column, and size. Tiles are frames named
   `TEMP-tile <id>_r<row>c<col>`. Rows and columns count from 0. The frame must sit on a page or a section, not in
   an auto layout frame; the code refuses that.

2. Fetch each tile with `get_screenshot` and save it as `<id>_r<row>c<col>.png` in one folder.

3. Stitch the tiles, stating the size you expect:

   ```bash
   node scripts/export-frame.mjs stitch --dir <tiles> --prefix <id> --width 2200 --height 1400 --out <id>.png
   ```

   It refuses a missing tile, a tile whose size doesn't fit its row and column, and a total that isn't the size you
   stated, then stitches in headless Chrome and checks the output's pixel size. Set `CHROME_BIN` if it can't find
   Chrome.

4. Remove the temporary nodes with `use_figma`:

   ```bash
   node scripts/export-frame.mjs cleanup --name <id> --out cleanup.js
   ```

   It removes the `TEMP-clone <id>` and `TEMP-tile <id>_…` nodes and returns what it removed. Without `--name` it
   removes every top-level node whose name starts with `TEMP-`.

Then record the stitched file with `inventory.mjs record-asset`, as in step 1.

Next: [Swap images in Markdown docs](swap-markdown.html) or [in Google Docs](swap-google-docs.html).
