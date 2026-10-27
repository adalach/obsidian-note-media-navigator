export const MEDIA_KINDS = ["image", "svg", "pdf", "video", "audio", "table"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];

export interface MediaItem {
	kind: MediaKind;
	line: number;
	column: number;
	title: string;
	target?: string;
	tableRows?: string[][];
	htmlTable?: string;
}

const EXTENSIONS: Record<string, MediaKind> = {
	avif: "image", bmp: "image", gif: "image", heic: "image", jpeg: "image",
	jpg: "image", png: "image", tif: "image", tiff: "image", webp: "image",
	svg: "svg", pdf: "pdf",
	mp4: "video", m4v: "video", mov: "video", webm: "video", ogv: "video",
	avi: "video", mkv: "video",
	flac: "audio", m4a: "audio", mp3: "audio", oga: "audio", ogg: "audio",
	opus: "audio", wav: "audio"
};

/** What a card's preview shows: equal keys need no new preview when only the item's line moves. */
export function mediaKey(item: MediaItem): string {
	return JSON.stringify([item.kind, item.target ?? "", item.tableRows ?? item.htmlTable ?? null]);
}

/** The page a PDF link opens at (`paper.pdf#page=3`), else the first. */
export function pdfPage(target: string): number {
	const page = Number(/#(?:.*&)?page=(\d+)/.exec(target)?.[1]);
	return Number.isInteger(page) && page > 0 ? page : 1;
}

export function cleanTarget(value: string): string {
	let result = value.trim();
	if (result.startsWith("<") && result.endsWith(">")) result = result.slice(1, -1);
	result = result.replace(/\\([ ()])/g, "$1");
	try { result = decodeURIComponent(result); } catch { /* Keep malformed percent escapes unchanged. */ }
	return result;
}

export function mediaKind(target: string): MediaKind | null {
	const path = cleanTarget(target).split(/[?#]/, 1)[0] ?? "";
	const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
	return extension ? EXTENSIONS[extension] ?? null : null;
}

function titleFor(target: string): string {
	const path = cleanTarget(target).split(/[?#]/, 1)[0] ?? target;
	return path.split("/").pop() || target;
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableStart(lines: string[], index: number): boolean {
	if (index + 1 >= lines.length || !lines[index]?.includes("|")) return false;
	const header = splitTableRow(lines[index] ?? "");
	const separator = splitTableRow(lines[index + 1] ?? "");
	return header.length > 0 && header.length === separator.length &&
		separator.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function maskInlineCodeAndComments(line: string, inComment: boolean): [string, boolean] {
	let masked = "";
	let index = 0;
	while (index < line.length) {
		if (inComment) {
			const end = line.indexOf("%%", index);
			if (end < 0) return [masked + " ".repeat(line.length - index), true];
			masked += " ".repeat(end + 2 - index);
			index = end + 2;
			inComment = false;
			continue;
		}
		if (line.startsWith("%%", index)) {
			inComment = true;
			masked += "  ";
			index += 2;
			continue;
		}
		if (line[index] === "`") {
			const run = line.slice(index).match(/^`+/)?.[0] ?? "`";
			const end = line.indexOf(run, index + run.length);
			if (end >= 0) {
				masked += " ".repeat(end + run.length - index);
				index = end + run.length;
				continue;
			}
		}
		masked += line[index];
		index++;
	}
	return [masked, inComment];
}

function addInlineMedia(items: MediaItem[], line: string, lineNumber: number): void {
	const wiki = /!\[\[([^\]]+)\]\]/g;
	for (const match of line.matchAll(wiki)) {
		const target = cleanTarget((match[1] ?? "").split("|", 1)[0] ?? "");
		const kind = mediaKind(target);
		if (!kind) continue;
		items.push({ kind, line: lineNumber, column: match.index, target, title: titleFor(target) });
	}

	const markdown = /!\[([^\]]*)\]\(\s*(<[^>]+>|(?:\\.|[^)])+)\s*\)/g;
	for (const match of line.matchAll(markdown)) {
		const raw = (match[2] ?? "").replace(/\s+["'][^"']*["']\s*$/, "");
		const target = cleanTarget(raw);
		const kind = mediaKind(target);
		if (!kind) continue;
		items.push({ kind, line: lineNumber, column: match.index, target, title: (match[1] || titleFor(target)).trim() });
	}

	const htmlTag = /<(?:img|video|audio|source|iframe|embed|object)\b[^>]*>/gi;
	for (const match of line.matchAll(htmlTag)) {
		const attribute = match[0].match(/\b(?:src|data)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
		const target = cleanTarget(attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? "");
		const kind = mediaKind(target);
		if (!kind) continue;
		items.push({ kind, line: lineNumber, column: match.index, target, title: titleFor(target) });
	}
}

export function parseMedia(source: string): MediaItem[] {
	const lines = source.split(/\r?\n/);
	const items: MediaItem[] = [];
	let fence: { char: string; length: number } | null = null;
	let inComment = false;
	let inFrontmatter = lines[0]?.trim() === "---";
	let inHtmlTable: { line: number; column: number; text: string[] } | null = null;

	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		if (inFrontmatter) {
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(raw)) inFrontmatter = false;
			continue;
		}
		const marker = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (marker) {
			const run = marker[1] ?? "";
			if (!fence) fence = { char: run[0] ?? "`", length: run.length };
			else if (run[0] === fence.char && run.length >= fence.length) fence = null;
			continue;
		}
		if (fence) continue;

		const [line, nextComment] = maskInlineCodeAndComments(raw, inComment);
		inComment = nextComment;
		if (inHtmlTable) {
			inHtmlTable.text.push(raw);
			if (/<\/table\s*>/i.test(line)) {
				items.push({ kind: "table", line: inHtmlTable.line, column: inHtmlTable.column,
					title: `Table at line ${inHtmlTable.line + 1}`, htmlTable: inHtmlTable.text.join("\n") });
				inHtmlTable = null;
			}
			continue;
		}

		const htmlStart = line.search(/<table\b/i);
		if (htmlStart >= 0) {
			inHtmlTable = { line: index, column: htmlStart, text: [raw] };
			if (/<\/table\s*>/i.test(line)) {
				items.push({ kind: "table", line: index, column: htmlStart,
					title: `Table at line ${index + 1}`, htmlTable: raw });
				inHtmlTable = null;
			}
			continue;
		}

		if (isTableStart(lines, index)) {
			const rows = [splitTableRow(raw)];
			let end = index + 2;
			while (end < lines.length && (lines[end] ?? "").includes("|") && (lines[end] ?? "").trim()) {
				rows.push(splitTableRow(lines[end] ?? ""));
				end++;
			}
			items.push({ kind: "table", line: index, column: raw.indexOf("|"),
				title: rows[0]?.join(" · ").slice(0, 80) || `Table at line ${index + 1}`, tableRows: rows });
		}
		addInlineMedia(items, line, index);
	}
	return items.sort((a, b) => a.line - b.line || a.column - b.column);
}
