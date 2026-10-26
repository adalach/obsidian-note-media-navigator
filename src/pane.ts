import { ItemView, Keymap, MarkdownView, Menu, Notice, Platform, setIcon, TFile, type App, type PaneType, type WorkspaceLeaf } from "obsidian";
import { MEDIA_KINDS, mediaKey, parseMedia, type MediaItem, type MediaKind } from "./media";
import type NoteMediaNavigatorPlugin from "./main";

export const VIEW_TYPE = "note-media-navigator-view";

const LABELS: Record<MediaKind, string> = {
	image: "Images", svg: "SVG", pdf: "PDF", video: "Video", audio: "Audio", table: "Tables"
};

const REVEAL_LABEL = Platform.isMacOS ? "Reveal in Finder" : "Show in system explorer";

const CARD_HINT = Platform.isDesktopApp
	? `Click to show it in the note; ${Platform.isMacOS ? "Cmd" : "Ctrl"}-click to open the file; ` +
		`${Platform.isMacOS ? "Option" : "Alt"}-click: ${REVEAL_LABEL}; right-click for more.`
	: "Tap to show it in the note; press and hold for more.";

// Obsidian's own "Reveal in Finder" calls App.showInFolder, which the typed API leaves out. It works on desktop only.
type AppWithShowInFolder = App & { showInFolder?: (path: string) => void };

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
		await this.refresh(true);
	}

	async onClose(): Promise<void> {
		this.refreshToken++;
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
		this.listEl?.setCssProps({ "--nmn-card-width": `${this.plugin.settings.sizePercent}%` });
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
			return;
		}
		container.empty();
		this.cards = [];
		this.cardsNotePath = this.notePath;
		if (!visible.length) {
			container.createDiv({ cls: "nmn-empty", text: this.notePath
				? "No matching media in this note." : "No note selected." });
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
		}
	}

	private updateCard(card: Card, item: MediaItem, index: number): void {
		card.el.dataset.index = String(index);
		card.el.setAttribute("aria-label", `${item.title}, ${LABELS[item.kind]}, line ${item.line + 1}. ${CARD_HINT}`);
		card.title.setText(item.title);
		card.meta.setText(`${LABELS[item.kind]} · line ${item.line + 1}`);
		const key = mediaKey(item);
		if (card.key === key) return;
		card.key = key;
		card.preview.empty();
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

	private renderPreview(container: HTMLElement, item: MediaItem): void {
		if (item.kind === "table") {
			this.renderTable(container, item);
			return;
		}
		const { url } = this.resolve(item);
		if (!url) {
			this.renderPlaceholder(container, "file-question", "File unavailable");
		} else if (item.kind === "image" || item.kind === "svg") {
			const image = container.createEl("img", { attr: { src: url, alt: item.title, loading: "lazy" } });
			image.draggable = false;
		} else if (item.kind === "video") {
			container.createEl("video", { attr: { src: url, preload: "metadata", muted: "", playsinline: "" } });
		} else if (item.kind === "pdf" && /^https?:\/\//i.test(url)) {
			// Obsidian does not load web PDFs in a note, so the pane does not open one in a frame either.
			this.renderPlaceholder(container, "globe", "Web PDF");
		} else if (item.kind === "pdf") {
			container.createEl("iframe", { attr: { src: `${url}#page=1&toolbar=0&navpanes=0`, title: item.title, loading: "lazy" } });
		} else {
			this.renderPlaceholder(container, "audio-lines", "Audio");
		}
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
