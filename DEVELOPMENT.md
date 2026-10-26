# Developing Note Media Navigator

## Build and test

```bash
npm install
npm run build   # typecheck, then a minified main.js
npm run dev     # an unminified main.js with an inline source map, for debugging
npm test        # the parser tests in test/
npm run lint    # eslint with Obsidian's plugin review rules (eslint-plugin-obsidianmd)
```

Obsidian loads `main.js`, `manifest.json` and `styles.css` from `<vault>/.obsidian/plugins/note-media-navigator/`. Each build copies the three files there: into the folder named by the `NOTE_MEDIA_NAVIGATOR_PLUGIN_DIR` environment variable, or else into `~/Documents/Obsidian Vault/.obsidian/plugins/note-media-navigator/` when that folder exists. After a rebuild, turn the plugin off and on under **Settings → Community plugins** to load the new code.

## How it works

`src/main.ts` only wires the parts together. It registers the sidebar view, the ribbon icon and the **Open note media** command, and remembers the Markdown note last active, so the pane keeps showing that note while the pane itself has focus. An edit, a save of that note, or a renamed or deleted file schedules a refresh 180 ms later. After a rename or deletion every card is redrawn, because a preview may now point to another file. The pane opens by itself only in `onUserEnable`, when someone turns the plugin on; on later starts Obsidian restores it with the workspace, or leaves it closed.

`src/media.ts` reads a note's text without runtime imports from `obsidian`. `parseMedia` finds wikilink embeds, Markdown embeds, HTML media tags (`img`, `video`, `audio`, `source`, `iframe`, `embed`, `object`), Markdown pipe tables and HTML tables, skipping frontmatter, fenced and inline code and `%%` comments. It decides the kind of an embed by its file extension and returns the items in source order with line and column. `mediaKey` names what a card's preview shows (kind, target and table cells), so a card whose item only moved to another line keeps its preview. `test/media.test.ts` covers both.

`src/pane.ts` is the sidebar view: the kind chips, the thumbnail slider (the `--nmn-card-width` CSS variable) and the cards. Links resolve relative to the note through `metadataCache.getFirstLinkpathDest`. Typing refreshes the pane at every pause, so as long as the number of cards and the note stay the same, the cards are kept and only previews whose `mediaKey` changed are redrawn; a PDF frame or video that is already loaded is not reloaded. Web PDFs get an icon instead of a frame, since Obsidian itself does not load them in a note.

A click on a card goes to the item: in Live Preview and Source mode it places the cursor on the item's line and centres it; in Reading view it calls `currentMode.applyScroll(line)`. Reading view marks only list items, checklists and code blocks with `data-line`, counted from the start of their section, so those markers cannot locate an image in a paragraph. `Keymap.isModEvent` turns Cmd/Ctrl-clicks and middle-clicks into a new tab, split or window, as elsewhere in Obsidian. Option/Alt-click calls `App.showInFolder`, the function behind Obsidian's own **Reveal in Finder** and **Show in system explorer**; it is not in the typed API, so the code checks that it exists. The right-click menu offers the same actions, and on a phone it opens on press and hold.

The plugin uses no Node or Electron APIs and makes no network requests, so `isDesktopOnly` is `false`. Every color in `styles.css` comes from the active theme.

## Testing in Obsidian

The checks of 2026-10-26 ran in Obsidian 1.14.5 on macOS, on a temporary note with a PNG, a vault PDF, a Markdown table, an SVG and a web PDF spread over 378 lines:

- Turning the plugin on opened the pane in the right sidebar. With the pane closed, reloading the plugin did not open it again.
- The five cards showed an image, a PDF frame, a table, an image and the web PDF icon. After a line was typed at the top, every line number moved by one while the same image and PDF frame elements stayed in place.
- In Reading view, clicking the SVG, table and PDF cards scrolled each one into view. In Live Preview, clicking the PDF card put the cursor on its line in view.
- Cmd-click on the PNG card opened it in a new tab. The right-click menus listed **Show in note**, **Open in new tab** and **Reveal in Finder** for a vault file, **Show in note** and **Open in browser** for a web PDF, and **Show in note** alone for a table.

Not yet checked: Windows and Linux, and the plugin on a phone (`isDesktopOnly` is now `false`).

## Release

1. `npm version <x.y.z>` sets the version in `package.json`, `manifest.json` and `versions.json` (through `version-bump.mjs`), commits, and tags the commit `x.y.z` without a `v`.
2. `git push --follow-tags` starts `.github/workflows/release.yml`, which checks that the tag matches `manifest.json`, builds, tests, lints and opens a draft release with `main.js`, `manifest.json` and `styles.css` attached.
3. Review the draft on GitHub and publish it. Obsidian offers the update to users once the release is published.

Raise `minAppVersion` in `manifest.json` before `npm version` when a release needs a newer Obsidian. The plugin needs 1.7.2 for `Workspace.ensureSideLeaf` and `Plugin.onUserEnable`.

To list the plugin in Obsidian's community plugins, sign in at community.obsidian.md with the Obsidian account, link GitHub and choose **Add your plugin**. The review is automatic; fixes ship as a new release with a higher version.
