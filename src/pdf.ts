import { loadPdfJs, type App, type TFile } from "obsidian";

// The parts of pdf.js (bundled with Obsidian, loaded through loadPdfJs) that the thumbnails use.
interface PdfViewport { width: number; height: number }
interface PdfPage {
	getViewport(options: { scale: number }): PdfViewport;
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfJs { getDocument(source: { data: Uint8Array }): { promise: Promise<PdfDocument> } }

/** Thumbnail width in pixels: sharp on a wide sidebar, still small as a JPEG (about 100-350 KB). */
const THUMB_WIDTH = 800;

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * A JPEG data URL of one page of a vault PDF, rendered once per file version and page and one at a time, so a note
 * full of PDFs does not parse them all at once. Null when pdf.js cannot read the file.
 */
export function pdfThumbnail(app: App, file: TFile, page: number): Promise<string | null> {
	const key = `${file.path}\u0000${file.stat.mtime}\u0000${page}`;
	let thumb = cache.get(key);
	if (!thumb) {
		thumb = queue.then(() => render(app, file, page)).catch(() => null);
		queue = thumb;
		cache.set(key, thumb);
	}
	return thumb;
}

export function clearPdfThumbnails(): void {
	cache.clear();
}

async function render(app: App, file: TFile, pageNumber: number): Promise<string> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const doc = await pdfjs.getDocument({ data: new Uint8Array(await app.vault.readBinary(file)) }).promise;
	try {
		const page = await doc.getPage(Math.min(pageNumber, doc.numPages));
		const viewport = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
		const canvas = createEl("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("No 2D canvas context");
		// A page without a background of its own would otherwise turn black in the JPEG.
		context.fillStyle = "white";
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: context, viewport }).promise;
		return canvas.toDataURL("image/jpeg", 0.85);
	} finally {
		await doc.destroy();
	}
}
