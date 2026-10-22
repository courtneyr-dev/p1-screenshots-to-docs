# Six-shot workflow

The shipped brief is `briefs/p1-editor.json`. It is a template: every project-specific value is a double-brace placeholder filled from your config file (`configuration.md`). Each shot opens the editor URL for your page (`<baseUrl>/p1<pagePath>`) in a new tab of the attached Chrome, so every shot starts from the editor's default workstream and is moved into the state it needs by named actions. Actions come from `scripts/presets/p1-editor.json`.

Each shot starts with `editorReady` (checks the editor chrome, the project name, and the page, and restores the left panel; at a viewport of about 1100 px or less use `editorReadyKeepPanel`, which runs the same checks and never toggles the panel), then `selectWorkstream` with your `workstream`, and ends with `workstreamMenuClosed` where the menu must be closed.

| #   | Slug                            | Actions after `editorReady` and `selectWorkstream`                                         | What the checks prove                                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `editor-shell`                  | `workstreamMenuClosed`                                                                     | Header, project name, page selector shows the page, selector reads the workstream, preview canvas rendered an `h1`, inspector present, menu closed |
| 2   | `blocks-browser`                | `expandAllBlockCategories`, `expandBlockCategory {blockCategory}`, `workstreamMenuClosed`  | Same shell checks; the screenshot shows "Collapse all" and the category groups open                                                                |
| 3   | `block-selected-properties`     | `selectBlockByType {blockType}` (or `selectBlockBySelector`), `workstreamMenuClosed`       | The block instance is the selected one (see "How a block is proven"), and the properties panel names its type or label                             |
| 4   | `block-selected-canvas-context` | the select action, `collapseLeftPanel`, the matching center action, `workstreamMenuClosed` | The left toggle reads collapsed (`aria-pressed=false`), the first block-category button is gone, and the same block is still selected              |
| 5   | `workstream-selector-open`      | `openWorkstreamMenu`                                                                       | The workstream list contains your `workstream`                                                                                                     |
| 6   | `publish-menu-open`             | `openPublishMenu {publishMenuLabel}`                                                       | The menu contains the publish text you configured; nothing is clicked                                                                              |

Shots 3 and 4 need `blockType` or `blockSelector` in the config. Without one they are skipped and reported, not failed.

## How a block is proven

After a click, the `selectedBlock` check runs in the preview iframe:

1. The target must sit inside a canvas block (`data-puck-component="<Type>-<id>"`). That attribute is the block's instance ID.
2. Exactly one selection overlay (`[data-puck-overlay]` whose class has the `--isSelected` modifier) must exist.
3. The overlay's box must match the target block's box within `tolerance` pixels (default 12). A neighbor's overlay sits at a different position, so a wrong selection fails with "a different block is selected".
4. The properties panel must name the block's type.

A same-type neighbor is caught by step 3, a different-type neighbor by steps 3 and 4. This works the same for `blockType` and `blockSelector`, so `blockSelector` is no longer the weaker option: a selector that finds the right block passes, and one that clicks into another block fails. Proof: the fixture editor has a `--bug neighbor` mode that selects the next block, and the suite shows both block shots rejected. A mutation test removes the two checks and shows the same editor then passes.

The overlay class comes from Puck 0.21.x compiled CSS. A Puck upgrade that renames it makes every block shot fail closed ("expected exactly one selected block overlay"), which is the intended failure.

## Why shots 3 and 4 differ

Selecting a block already scrolls it to the center, so a "centered" shot looked identical to shot 3. Shot 4 instead collapses the left panel: in the proof of concept the canvas grew from 744 to 1034 px and the category list disappeared, which is a change a check can prove.

## Design rules the actions follow

- **State leaks between shots.** The editor keeps panel state across page loads, and the workstream per tab. `editorReady` restores the left panel, and each shot selects its workstream explicitly.
- **Wait for layout.** A click first waits until the target's position is unchanged across reads. Clicking a block while the canvas was still scrolling selected its neighbor.
- **Case-insensitive text.** Category labels can be uppercase on screen through CSS, so text matching ignores case.
- **Check the right container.** The selected block's name shows in the properties panel. Earlier checks looked in `main` for a different element and never matched.
- **Menus are opened, never used.** See `safety.md`.
- **Permanent icons aren't loading signals.** A small `aria-label="loading"` icon stayed visible in the loaded editor. Readiness is "the preview iframe rendered an `h1`".
- **Nothing assumes a workstream or a page.** Both come from the config and are checked in the editor on every shot.

## Changing the set

- Another workstream, page, or project: change the config (`workstream`, `pagePath`, `projectName`), or pass `--set` for one command.
- Another block: set `blockType` to one that selects reliably (P1 MCP `get_document`), or `blockSelector`. Don't weaken `expectAfter` to make a failing block pass.
- Another origin: change `baseUrl`.
- Another page: change `pagePath` (and `pageLabel` if the selector shows something else). Each shot deep-links to it unless `pageNavigation` is `manual`.
- A new state: write it as an action in a preset with `expect`/`expectAfter` checks that would fail if the action did nothing. Add a matching restore for any panel it changes, and add a shot to a copy of the brief.
