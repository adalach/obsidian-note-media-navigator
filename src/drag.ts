import type { EditorView } from "@codemirror/view";
import type { App, Editor } from "obsidian";

/** The drag data type that marks a card dragged out of the pane. */
export const DRAG_TYPE = "application/x-note-media-navigator";

/** What a dragged card carries: a vault file, with the original link's subpath (such as a PDF page), or a web address. */
export type DragPayload = { path: string; subpath?: string } | { url: string };

/** The `#…` part of a link target, such as `#page=2`, or undefined. */
export function subpathOf(target: string): string | undefined {
	const hash = target.indexOf("#");
	return hash > 0 ? target.slice(hash) : undefined;
}

/** A Markdown embed of a web address; angle brackets keep spaces and parentheses inside the address. */
export function webEmbed(url: string): string {
	return /[\s()<>]/.test(url) ? `![](<${url}>)` : `![](${url})`;
}

export function parsePayload(raw: string): DragPayload | null {
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return null; }
	if (typeof value !== "object" || value === null) return null;
	const { path, subpath, url } = value as Record<string, unknown>;
	if (typeof url === "string") return { url };
	if (typeof path !== "string") return null;
	return typeof subpath === "string" ? { path, subpath } : { path };
}

/**
 * The embed to insert into the note at `sourcePath`, in the vault's link format (wikilink or Markdown, shortest,
 * relative or absolute path), so the new link points at the original file; null when the file is gone.
 */
export function embedFor(app: App, payload: DragPayload, sourcePath: string): string | null {
	if ("url" in payload) return webEmbed(payload.url);
	const file = app.vault.getFileByPath(payload.path);
	return file ? "!" + app.fileManager.generateMarkdownLink(file, sourcePath, payload.subpath) : null;
}

// Obsidian's Editor keeps its CodeMirror view in `cm`, which the typed API leaves out.
type EditorWithView = Editor & { cm?: EditorView };

/** Insert `text` where the pointer dropped it, or at the cursor when the editor cannot tell the drop position. */
export function insertAtDrop(editor: Editor, event: DragEvent, text: string): void {
	const offset = (editor as EditorWithView).cm?.posAtCoords({ x: event.clientX, y: event.clientY });
	const at = offset == null ? editor.getCursor() : editor.offsetToPos(offset);
	editor.replaceRange(text, at);
	editor.setCursor(editor.offsetToPos(editor.posToOffset(at) + text.length));
	editor.focus();
}
