// Where the editor pane goes. Pure functions, unit-tested in test/layout.test.ts.

export type PaneGeometry = {
	windowWidth: number;
	windowHeight: number;
	paneLeft: number;
	paneTop: number;
	paneWidth: number;
	paneHeight: number;
};

export type PaneInfo = {
	version: string;
	zoomed: boolean;
	geometry: PaneGeometry;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type Layout = { kind: "split"; direction: "h" | "v"; size: string } | ({ kind: "float" } & Rect);

/** Side by side only when both pi and the editor get this many columns. */
export const MIN_SIDE_COLUMNS = 80;
/** Top/bottom only when both get this many rows. */
export const MIN_STACK_ROWS = 15;
/** The smallest floating pane worth opening, border included. */
export const MIN_FLOAT_COLUMNS = 40;
export const MIN_FLOAT_ROWS = 10;

/** Format for `tmux display-message -p`; parse the output with parsePaneInfo. */
export const PANE_FORMAT = [
	"#{version}",
	"#{window_zoomed_flag}",
	"#{window_width}",
	"#{window_height}",
	"#{pane_left}",
	"#{pane_top}",
	"#{pane_width}",
	"#{pane_height}",
].join(",");

export function parsePaneInfo(output: string): PaneInfo {
	const [version = "", zoomed, ...fields] = output.trim().split(",");
	const numbers = fields.map((field) => Number.parseInt(field, 10));
	if (numbers.length !== 6 || numbers.some((n) => !Number.isFinite(n))) {
		throw new Error(`unexpected tmux pane info: ${output.trim()}`);
	}
	const [windowWidth, windowHeight, paneLeft, paneTop, paneWidth, paneHeight] = numbers as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	return {
		version,
		zoomed: zoomed === "1",
		geometry: { windowWidth, windowHeight, paneLeft, paneTop, paneWidth, paneHeight },
	};
}

/** Floating panes (`new-pane`) arrived in tmux 3.8. */
export function supportsFloatingPanes(version: string): boolean {
	const match = /(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 3 || (major === 3 && minor >= 8);
}

export function fixedDirection(direction: string): "h" | "v" | undefined {
	const normalized = direction.trim().toLowerCase();
	if (normalized === "h" || normalized === "horizontal") return "h";
	if (normalized === "v" || normalized === "vertical") return "v";
	return undefined;
}

/**
 * A fixed direction always splits. "auto" splits side by side when both halves
 * are wide enough, else top/bottom when both are tall enough, else floats the
 * editor over the largest part of the window outside pi's pane, so pi stays
 * visible. Without floating panes, or room for one, it splits the roomier way.
 */
export function chooseLayout(
	geometry: PaneGeometry,
	options: { direction: string; size: string; canFloat: boolean },
): Layout {
	const { size } = options;
	const fixed = fixedDirection(options.direction);
	if (fixed) return { kind: "split", direction: fixed, size };

	const [editorColumns, piColumns] = splitCells(geometry.paneWidth, size);
	if (Math.min(editorColumns, piColumns) >= MIN_SIDE_COLUMNS) return { kind: "split", direction: "h", size };

	const [editorRows, piRows] = splitCells(geometry.paneHeight, size);
	if (Math.min(editorRows, piRows) >= MIN_STACK_ROWS) return { kind: "split", direction: "v", size };

	if (options.canFloat) {
		const region = largestRegionOutsidePane(geometry);
		if (region) return { kind: "float", ...region };
	}

	const wide = Math.min(editorColumns, piColumns) / MIN_SIDE_COLUMNS;
	const tall = Math.min(editorRows, piRows) / MIN_STACK_ROWS;
	return { kind: "split", direction: wide >= tall ? "h" : "v", size };
}

/** Cells the editor and pi get when a pane of `total` cells is split by tmux `-l size`. */
export function splitCells(total: number, size: string): [editor: number, pi: number] {
	const usable = Math.max(0, total - 1); // one cell for the pane border
	const match = /^(\d+)(%?)$/.exec(size.trim());
	let editor = Math.floor(usable / 2);
	if (match) editor = match[2] ? Math.floor((total * Number(match[1])) / 100) : Number(match[1]);
	editor = Math.max(0, Math.min(editor, usable));
	return [editor, usable - editor];
}

/**
 * The largest full-height strip left or right of pi's pane, or full-width strip
 * above or below it, that fits a floating pane. Other panes there get covered;
 * pi does not.
 */
export function largestRegionOutsidePane(geometry: PaneGeometry): Rect | undefined {
	const { windowWidth, windowHeight, paneLeft, paneTop, paneWidth, paneHeight } = geometry;
	const right = paneLeft + paneWidth; // the border column right of pi
	const bottom = paneTop + paneHeight; // the border row below pi
	const regions: Rect[] = [
		{ x: 0, y: 0, width: paneLeft - 1, height: windowHeight },
		{ x: right + 1, y: 0, width: windowWidth - right - 1, height: windowHeight },
		{ x: 0, y: 0, width: windowWidth, height: paneTop - 1 },
		{ x: 0, y: bottom + 1, width: windowWidth, height: windowHeight - bottom - 1 },
	];
	let best: Rect | undefined;
	for (const region of regions) {
		if (region.width < MIN_FLOAT_COLUMNS || region.height < MIN_FLOAT_ROWS) continue;
		if (!best || region.width * region.height > best.width * best.height) best = region;
	}
	return best;
}
