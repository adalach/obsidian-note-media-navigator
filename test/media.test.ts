import { describe, expect, it } from "vitest";
import { parsePayload, subpathOf, webEmbed } from "../src/drag";
import { mediaKey, parseMedia, pdfPage } from "../src/media";

describe("parseMedia", () => {
	it("lists wikilinks, Markdown embeds, HTML media, and tables in source order", () => {
		const note = [
			"# Gallery",
			"![[figure.svg|300]] ![Photo](photos/a%20b.png)",
			"<video src='clips/demo.mp4'></video>",
			"![[paper.pdf#page=2]]",
			"| Name | Value |",
			"| --- | --- |",
			"| A | 1 |",
			"<table><tr><th>One</th></tr><tr><td>Two</td></tr></table>",
			"![[sound.mp3]]"
		].join("\n");
		const items = parseMedia(note);
		expect(items.map(({ kind, line }) => [kind, line])).toEqual([
			["svg", 1], ["image", 1], ["video", 2], ["pdf", 3],
			["table", 4], ["table", 7], ["audio", 8]
		]);
		expect(items[1]?.target).toBe("photos/a b.png");
		expect(items[4]?.tableRows).toEqual([["Name", "Value"], ["A", "1"]]);
	});

	it("ignores frontmatter, code, and comments", () => {
		const note = [
			"---", "cover: '![[front.png]]'", "---",
			"`![[inline.png]]` %% ![[comment.png]] %% ![[real.jpg]]",
			"```md", "![[fenced.pdf]]", "```",
			"%%", "![[long-comment.mp4]]", "%%"
		].join("\n");
		expect(parseMedia(note).map((item) => item.target)).toEqual(["real.jpg"]);
	});
});

describe("mediaKey", () => {
	it("stays the same when only the item's position changes", () => {
		const [before] = parseMedia("![[paper.pdf]]");
		const [after] = parseMedia("New first line\n\nText ![[paper.pdf]]");
		expect(before && after && mediaKey(before)).toBe(after && mediaKey(after));
	});

	it("changes with the target or the table's cells", () => {
		const keys = parseMedia([
			"![[a.png]] ![[b.png]]",
			"", "| x |", "| --- |", "| 1 |",
			"", "| x |", "| --- |", "| 2 |"
		].join("\n")).map(mediaKey);
		expect(new Set(keys).size).toBe(4);
	});
});

describe("drag payloads", () => {
	it("keeps a link's subpath, such as a PDF page", () => {
		expect(subpathOf("papers/paper.pdf#page=2")).toBe("#page=2");
		expect(subpathOf("figure.png")).toBeUndefined();
	});

	it("embeds web addresses, in angle brackets when they hold spaces or parentheses", () => {
		expect(webEmbed("https://example.com/a.png")).toBe("![](https://example.com/a.png)");
		expect(webEmbed("https://example.com/a (1).png")).toBe("![](<https://example.com/a (1).png>)");
	});

	it("reads only well-formed payloads", () => {
		expect(parsePayload(JSON.stringify({ path: "a.png", subpath: "#x" }))).toEqual({ path: "a.png", subpath: "#x" });
		expect(parsePayload(JSON.stringify({ url: "https://example.com/a.png" }))).toEqual({ url: "https://example.com/a.png" });
		expect(parsePayload("")).toBeNull();
		expect(parsePayload(JSON.stringify({ path: 3 }))).toBeNull();
	});
});

describe("pdfPage", () => {
	it("reads the page a PDF link opens at, else the first", () => {
		expect(pdfPage("paper.pdf#page=3")).toBe(3);
		expect(pdfPage("paper.pdf#zoom=50&page=12")).toBe(12);
		expect(pdfPage("paper.pdf")).toBe(1);
		expect(pdfPage("paper.pdf#page=0")).toBe(1);
	});
});
