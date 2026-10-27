import { MarkdownView, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { DRAG_TYPE, embedFor, insertAtDrop, parsePayload } from "./drag";
import { MEDIA_KINDS, type MediaKind } from "./media";
import { MediaPane, VIEW_TYPE } from "./pane";

interface NavigatorSettings {
	sizePercent: number;
	visible: Record<MediaKind, boolean>;
}

const DEFAULT_SETTINGS: NavigatorSettings = {
	sizePercent: 100,
	visible: { image: true, svg: true, pdf: true, video: true, audio: true, table: true }
};

export default class NoteMediaNavigatorPlugin extends Plugin {
	settings: NavigatorSettings = structuredClone(DEFAULT_SETTINGS);
	private noteLeaf: WorkspaceLeaf | null = null;
	private refreshTimer: number | null = null;
	private rebuildPending = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(VIEW_TYPE, (leaf) => new MediaPane(leaf, this));
		this.addRibbonIcon("images", "Open note media", () => void this.activateView());
		this.addCommand({ id: "open-note-media", name: "Open note media", callback: () => void this.activateView() });
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf?.view instanceof MarkdownView && leaf.view.file) {
				this.noteLeaf = leaf;
				this.scheduleRefresh();
			}
		}));
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file?.extension === "md") {
				this.captureActiveNote();
				this.scheduleRefresh();
			}
		}));
		this.registerEvent(this.app.workspace.on("editor-change", (_editor, view) => {
			if (view === this.getNoteView()) this.scheduleRefresh();
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file.path === this.getNoteView()?.file?.path) this.scheduleRefresh();
		}));
		// A renamed or deleted file changes what a preview resolves to, though the note's text is the same.
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh(true)));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh(true)));
		// A card dropped into a note: link to the original file, written for the note it lands in.
		this.registerEvent(this.app.workspace.on("editor-drop", (event, editor, info) => {
			if (event.defaultPrevented) return;
			const payload = parsePayload(event.dataTransfer?.getData(DRAG_TYPE) ?? "");
			const text = payload ? embedFor(this.app, payload, info.file?.path ?? "") : null;
			if (!text) return;
			event.preventDefault();
			insertAtDrop(editor, event, text);
		}));
		this.app.workspace.onLayoutReady(() => {
			this.captureActiveNote();
			this.scheduleRefresh();
		});
	}

	// Obsidian restores the pane with the workspace layout, so it opens by itself only when the user turns the plugin on.
	onUserEnable(): void {
		void this.activateView();
	}

	onunload(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
	}

	private async loadSettings(): Promise<void> {
		const saved = await this.loadData() as Partial<NavigatorSettings> | null;
		this.settings = {
			sizePercent: Math.max(25, Math.min(100, Number(saved?.sizePercent) || DEFAULT_SETTINGS.sizePercent)),
			visible: { ...DEFAULT_SETTINGS.visible, ...saved?.visible }
		};
		for (const kind of MEDIA_KINDS) this.settings.visible[kind] = this.settings.visible[kind] !== false;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private captureActiveNote(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) this.noteLeaf = view.leaf;
	}

	getNoteView(): MarkdownView | null {
		if (this.noteLeaf?.view instanceof MarkdownView && this.noteLeaf.view.file) return this.noteLeaf.view;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) {
			this.noteLeaf = active.leaf;
			return active;
		}
		const candidate = this.app.workspace.getLeavesOfType("markdown")
			.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file);
		if (candidate?.view instanceof MarkdownView) {
			this.noteLeaf = candidate;
			return candidate.view;
		}
		return null;
	}

	async revealNote(path: string | null): Promise<MarkdownView | null> {
		if (!path) return null;
		let leaf = this.app.workspace.getLeavesOfType("markdown")
			.find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === path);
		if (!leaf) {
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) return null;
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof MarkdownView) {
			this.noteLeaf = leaf;
			return leaf.view;
		}
		return null;
	}

	private async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			if (existing.view instanceof MediaPane) await existing.view.refresh(true);
			return;
		}
		await this.app.workspace.ensureSideLeaf(VIEW_TYPE, "right", { active: false, reveal: true, split: false });
	}

	private scheduleRefresh(rebuild = false): void {
		this.rebuildPending ||= rebuild;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			const rebuildNow = this.rebuildPending;
			this.rebuildPending = false;
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				if (leaf.view instanceof MediaPane) void leaf.view.refresh(rebuildNow);
			}
		}, 180);
	}
}
