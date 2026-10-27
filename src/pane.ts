import { ItemView, Keymap, MarkdownView, Menu, Notice, Platform, setIcon, TFile, type App, type PaneType, type WorkspaceLeaf } from "obsidian";
import { DRAG_TYPE, embedFor, subpathOf, type DragPayload } from "./drag";
import { MEDIA_KINDS, mediaKey, parseMedia, pdfPage, type MediaItem, type MediaKind } from "./media";
import { pdfThumbnail } from "./pdf";
import type NoteMediaNavigatorPlugin from "./main";

export const VIEW_TYPE = "note-media-navigator-view";

const LABELS: Record<MediaKind, string> = {
	image: "Images", svg: "SVG", pdf: "PDF", video: "Video", audio: "Audio", table: "Tables"
};

const REVEAL_LABEL = Platform.isMacOS ? "Reveal in Finder" : "Show in system explorer";

const CARD_HINT = Platform.isDesktopApp
	? `Click to show it in the note; drag it into a note to embed it there; ${Platform.isMacOS ? "Cmd" : "Ctrl"}-click to open the file; ` +
		`${Platform.isMacOS ? "Option" : "Alt"}-click: ${REVEAL_LABEL}; right-click for more.`
	: "Tap to show it in the note; press and hold for more.";

// Obsidian's own "Reveal in Finder" calls App.showInFolder, which the typed API leaves out. It works on desktop only.
type AppWithShowInFolder = App & { showInFolder?: (path: string) => void };

const CARD_GAP = 8;
const MIN_CARD_WIDTH = 85;

/** A drawn card. `key` names the media its preview shows (see mediaKey). */
interface Card {
	key: string;
	el: HTMLElement;
	preview: HTMLElement;
	title: HTMLElement;
	meta: HTMLElement;
}

export class MediaPane extends ItemView {
	private listEl: HTMLElement | null = null;
	private filterEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private items: MediaItem[] = [];
	private notePath: string | null = null;
	private cards: Card[] = [];
	private cardsNotePath: string | null = null;
	private refreshToken = 0;
	// Watches the list's width and each card's height (images load late), to place the cards again.
	private resizeObserver: ResizeObserver | null = null;
	private layoutFrame: number | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: NoteMediaNavigatorPlugin) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "Note media"; }
	getIcon(): string { return "images"; }

	async onOpen(): Promise<void> {
		const content = this.contentEl;
		content.empty();
		content.addClass("nmn-pane");
		const header = content.createDiv({ cls: "nmn-header" });
		header.createEl("h3", { text: "Note media" });
		this.countEl = header.createDiv({ cls: "nmn-count" });
		this.filterEl = content.createDiv({ cls: "nmn-filters" });
		const sizeRow = content.createDiv({ cls: "nmn-size-row" });
		const sizeLabel = sizeRow.createEl("label", { text: "Thumbnail size" });
		const slider = sizeLabel.createEl("input", {
			type: "range", attr: { min: "25", max: "100", step: "5", "aria-label": "Thumbnail size" }
		});
		slider.value = String(this.plugin.settings.sizePercent);
		this.listEl = content.createDiv({ cls: "nmn-list" });
		this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
		this.resizeObserver.observe(this.listEl);
		this.applySize();
		this.renderFilters();
		this.registerDomEvent(slider, "input", () => {
			this.plugin.settings.sizePercent = Number(slider.value);
			this.applySize();
		});
		this.registerDomEvent(slider, "change", () => void this.plugin.saveSettings());
		this.registerDomEvent(this.filterEl, "click", (event: MouseEvent) => {
			const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]");
			const kind = button?.dataset.kind as MediaKind | undefined;
			if (!kind || !MEDIA_KINDS.includes(kind)) return;
			this.plugin.settings.visible[kind] = !this.plugin.settings.visible[kind];
			this.renderFilters();
			this.renderItems();
			void this.plugin.saveSettings();
		});
		this.registerDomEvent(this.listEl, "click", (event: MouseEvent) => {
			const item = this.itemAt(event);
			if (!item) return;
			const pane = Keymap.isModEvent(event);
			if (pane) void this.openItem(item, pane === true ? "tab" : pane);
			else if (event.altKey && Platform.isDesktopApp) this.revealItem(item);
			else void this.jumpToItem(item);
		});
		this.registerDomEvent(this.listEl, "auxclick", (event: MouseEvent) => {
			const item = event.button === 1 ? this.itemAt(event) : undefined;
			if (item) void this.openItem(item, "tab");
		});
		this.registerDomEvent(this.listEl, "contextmenu", (event: MouseEvent) => {
			const item = this.itemAt(event);
			if (!item) return;
			event.preventDefault();
			this.itemMenu(item).showAtMouseEvent(event);
		});
		// A card dragged into a note embeds its file: the plugin's editor-drop handler writes the link for the note
		// it lands in; any other drop target gets the embed as plain text.
		this.registerDomEvent(this.listEl, "dragstart", (event: DragEvent) => {
			const item = this.itemAt(event);
			const payload = item ? this.dragPayload(item) : null;
			const text = payload ? embedFor(this.app, payload, this.notePath ?? "") : null;
			if (!payload || !text || !event.dataTransfer) {
				event.preventDefault();
				return;
			}
			event.dataTransfer.effectAllowed = "copy";
			event.dataTransfer.setData("text/plain", text);
			event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
		});
		await this.refresh(true);
	}

	async onClose(): Promise<void> {
		this.refreshToken++;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
		this.layoutFrame = null;
		this.items = [];
		this.cards = [];
		this.cardsNotePath = null;
		this.listEl = null;
		this.filterEl = null;
		this.countEl = null;
	}

	/** Reparse the note. `rebuild` redraws every card, for when a file a preview shows may have moved. */
	async refresh(rebuild = false): Promise<void> {
		const token = ++this.refreshToken;
		const view = this.plugin.getNoteView();
		const file = view?.file;
		if (!file) {
			this.notePath = null;
			this.items = [];
			this.renderItems(rebuild);
			return;
		}
		const source = view.editor?.getValue() ?? await this.app.vault.cachedRead(file);
		if (token !== this.refreshToken) return;
		this.notePath = file.path;
		this.items = parseMedia(source);
		this.renderItems(rebuild);
	}

	private itemAt(event: MouseEvent): MediaItem | undefined {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-index]");
		const index = Number(button?.dataset.index);
		return Number.isInteger(index) ? this.items[index] : undefined;
	}

	private applySize(): void {
		this.layout();
	}

	private scheduleLayout(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			this.layout();
		});
	}

	/**
	 * Masonry: each card goes into the column that is shortest so far, so short cards leave no gaps and a card
	 * higher up still comes earlier in the note. The thumbnail size is a share of the width, gaps included,
	 * so 50% gives two columns that fill the pane.
	 */
	private layout(): void {
		const list = this.listEl;
		if (!list) return;
		if (!this.cards.length) {
			list.setCssProps({ "--nmn-list-height": "auto" });
			return;
		}
		const width = list.clientWidth;
		const cardWidth = Math.max(MIN_CARD_WIDTH, (width + CARD_GAP) * this.plugin.settings.sizePercent / 100 - CARD_GAP);
		const columns = Math.max(1, Math.floor((width + CARD_GAP) / (cardWidth + CARD_GAP) + 1e-6));
		list.setCssProps({ "--nmn-card-px": `${cardWidth}px` });
		// Read every height before moving any card, so the browser lays out once.
		const heights = this.cards.map((card) => card.el.offsetHeight);
		const columnHeights = new Array<number>(columns).fill(0);
		this.cards.forEach((card, position) => {
			const column = columnHeights.indexOf(Math.min(...columnHeights));
			card.el.setCssProps({
				"--nmn-x": `${column * (cardWidth + CARD_GAP)}px`,
				"--nmn-y": `${columnHeights[column] ?? 0}px`
			});
			columnHeights[column] = (columnHeights[column] ?? 0) + (heights[position] ?? 0) + CARD_GAP;
		});
		list.setCssProps({ "--nmn-list-height": `${Math.max(...columnHeights) - CARD_GAP}px` });
	}

	private renderFilters(): void {
		const container = this.filterEl;
		if (!container) return;
		container.empty();
		for (const kind of MEDIA_KINDS) {
			const button = container.createEl("button", {
				text: LABELS[kind], cls: "nmn-filter",
				attr: { type: "button", "data-kind": kind, "aria-pressed": String(this.plugin.settings.visible[kind]) }
			});
			button.toggleClass("is-active", this.plugin.settings.visible[kind]);
		}
	}

	private renderItems(rebuild = false): void {
		const container = this.listEl;
		if (!container) return;
		const visible = this.items.map((item, index) => ({ item, index }))
			.filter(({ item }) => this.plugin.settings.visible[item.kind]);
		if (this.countEl) this.countEl.setText(this.notePath
			? `${visible.length} of ${this.items.length} items · ${this.notePath.split("/").pop()}`
			: "Open a Markdown note to see its media.");
		// Typing in the note refreshes the pane at every pause. Keep the cards, so loaded PDF and video
		// previews stay, and redraw only the previews whose media changed; new cards only when their number or the note changes.
		if (!rebuild && visible.length && visible.length === this.cards.length && this.cardsNotePath === this.notePath) {
			visible.forEach(({ item, index }, position) => {
				const card = this.cards[position];
				if (card) this.updateCard(card, item, index);
			});
			this.scheduleLayout();
			return;
		}
		container.empty();
		this.cards = [];
		this.cardsNotePath = this.notePath;
		this.resizeObserver?.disconnect();
		this.resizeObserver?.observe(container);
		if (!visible.length) {
			container.createDiv({ cls: "nmn-empty", text: this.notePath
				? "No matching media in this note." : "No note selected." });
			this.layout();
			return;
		}
		for (const { item, index } of visible) {
			const el = container.createEl("button", { cls: "nmn-card", attr: { type: "button" } });
			const preview = el.createDiv({ cls: "nmn-preview" });
			const caption = el.createDiv({ cls: "nmn-caption" });
			const card: Card = {
				key: "", el, preview,
				title: caption.createDiv({ cls: "nmn-title" }),
				meta: caption.createDiv({ cls: "nmn-meta" })
			};
			this.updateCard(card, item, index);
			this.cards.push(card);
			this.resizeObserver?.observe(el);
		}
		// Place the cards before the first paint; the observer places them again as images load.
		this.layout();
	}

	private updateCard(card: Card, item: MediaItem, index: number): void {
		card.el.dataset.index = String(index);
		card.el.setAttribute("aria-label", `${item.title}, ${LABELS[item.kind]}, line ${item.line + 1}. ${CARD_HINT}`);
		card.title.setText(item.title);
		card.meta.setText(`${LABELS[item.kind]} · line ${item.line + 1}`);
		card.el.draggable = this.dragPayload(item) !== null;
		const key = mediaKey(item);
		if (card.key === key) return;
		card.key = key;
		card.preview.empty();
		card.preview.removeClass("is-image", "is-table");
		card.preview.dataset.media = key;
		this.renderPreview(card.preview, item);
	}

	private resolve(item: MediaItem): { file: TFile | null; url: string | null } {
		const target = item.target;
		if (!target) return { file: null, url: null };
		if (/^https?:\/\//i.test(target)) return { file: null, url: target };
		const path = target.split("#", 1)[0]?.replace(/^\//, "") ?? "";
		const file = this.app.metadataCache.getFirstLinkpathDest(path, this.notePath ?? "")
			?? this.app.vault.getFileByPath(path);
		return file ? { file, url: this.app.vault.getResourcePath(file) } : { file: null, url: null };
	}

	/** What dragging the card carries: its vault file or web address. Tables and missing files cannot be dragged. */
	private dragPayload(item: MediaItem): DragPayload | null {
		if (item.kind === "table") return null;
		const { file, url } = this.resolve(item);
		if (file) {
			const subpath = subpathOf(item.target ?? "");
			return subpath ? { path: file.path, subpath } : { path: file.path };
		}
		return url && /^https?:\/\//i.test(url) ? { url } : null;
	}

	private renderPreview(container: HTMLElement, item: MediaItem): void {
		if (item.kind === "table") {
			this.renderTable(container, item);
			return;
		}
		const { file, url } = this.resolve(item);
		if (!url) {
			this.renderPlaceholder(container, "file-question", "File unavailable");
		} else if (item.kind === "image" || item.kind === "svg") {
			// The class sizes the preview to the image (a class rather than :has(), which the plugin review flags as slow).
			container.addClass("is-image");
			const image = container.createEl("img", { attr: { src: url, alt: item.title, loading: "lazy" } });
			image.draggable = false;
		} else if (item.kind === "video") {
			container.createEl("video", { attr: { src: url, preload: "metadata", muted: "", playsinline: "" } });
		} else if (item.kind === "pdf" && file) {
			this.renderPdf(container, item, file);
		} else if (item.kind === "pdf") {
			// Obsidian does not load web PDFs in a note, so the pane does not load one either.
			this.renderPlaceholder(container, "globe", "Web PDF");
		} else {
			this.renderPlaceholder(container, "audio-lines", "Audio");
		}
	}

	/**
	 * The page the link opens at, drawn by pdf.js as an image with the page's own proportions. Chromium's PDF viewer
	 * in a frame filled the rest of the card with its dark background. Shows an icon until the image is ready, and
	 * keeps it when pdf.js cannot read the file.
	 */
	private renderPdf(container: HTMLElement, item: MediaItem, file: TFile): void {
		const key = mediaKey(item);
		this.renderPlaceholder(container, "file-text", "PDF");
		void pdfThumbnail(this.app, file, pdfPage(item.target ?? "")).then((src) => {
			if (!src || container.dataset.media !== key) return;     // the card shows something else by now
			container.empty();
			container.addClass("is-image");
			container.createEl("img", { attr: { src, alt: item.title } }).draggable = false;
		});
	}

	private renderPlaceholder(container: HTMLElement, icon: string, text: string): void {
		const placeholder = container.createDiv({ cls: "nmn-placeholder" });
		setIcon(placeholder, icon);
		placeholder.createSpan({ text });
	}

	private renderTable(container: HTMLElement, item: MediaItem): void {
		let rows = item.tableRows;
		if (!rows && item.htmlTable) {
			const document = new DOMParser().parseFromString(item.htmlTable, "text/html");
			rows = Array.from(document.querySelectorAll("table tr")).map((tr) =>
				Array.from(tr.querySelectorAll("th, td")).map((cell) => cell.textContent?.trim() ?? ""));
		}
		if (!rows?.length) return;
		container.addClass("is-table");
		const table = container.createEl("table", { cls: "nmn-table" });
		for (const [rowIndex, row] of rows.slice(0, 6).entries()) {
			const tr = table.createEl("tr");
			for (const cell of row.slice(0, 5)) tr.createEl(rowIndex === 0 ? "th" : "td", { text: cell });
		}
		if (rows.length > 6) container.createDiv({ cls: "nmn-table-more", text: `+ ${rows.length - 6} more rows` });
	}

	private itemMenu(item: MediaItem): Menu {
		const menu = new Menu();
		menu.addItem((entry) => entry.setTitle("Show in note").setIcon("locate")
			.onClick(() => void this.jumpToItem(item)));
		const { file, url } = this.resolve(item);
		if (file) {
			menu.addItem((entry) => entry.setTitle("Open in new tab").setIcon("file-plus")
				.onClick(() => void this.openItem(item, "tab")));
			if (Platform.isDesktopApp) menu.addItem((entry) => entry.setTitle(REVEAL_LABEL).setIcon("folder-open")
				.onClick(() => this.revealItem(item)));
		} else if (url) {
			menu.addItem((entry) => entry.setTitle("Open in browser").setIcon("globe")
				.onClick(() => void this.openItem(item, "tab")));
		}
		return menu;
	}

	private async jumpToItem(item: MediaItem): Promise<void> {
		const view = await this.plugin.revealNote(this.notePath);
		if (!(view instanceof MarkdownView)) return;
		if (view.getMode() === "preview") {
			// Reading view scrolls by source line, also to sections it has not rendered yet.
			view.currentMode.applyScroll(item.line);
			return;
		}
		const position = { line: item.line, ch: item.column };
		view.editor.setCursor(position);
		view.editor.scrollIntoView({ from: position, to: position }, true);
	}

	private async openItem(item: MediaItem, pane: PaneType): Promise<void> {
		const { file, url } = this.resolve(item);
		if (file) {
			const leaf = this.app.workspace.getLeaf(pane);
			await leaf.openFile(file);
			await this.app.workspace.revealLeaf(leaf);
		} else if (url && /^https?:\/\//i.test(url)) {
			window.open(url, "_blank", "noopener,noreferrer");
		} else {
			await this.jumpToItem(item);
		}
	}

	private revealItem(item: MediaItem): void {
		const { file } = this.resolve(item);
		const app = this.app as AppWithShowInFolder;
		if (!file || typeof app.showInFolder !== "function") {
			new Notice(`${REVEAL_LABEL} works for media files in this vault only.`);
			return;
		}
		app.showInFolder(file.path);
	}
}
