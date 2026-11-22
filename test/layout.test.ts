import assert from "node:assert/strict";
import { test } from "node:test";

import {
	chooseLayout,
	largestRegionOutsidePane,
	parsePaneInfo,
	splitCells,
	supportsFloatingPanes,
	type PaneGeometry,
} from "../layout.ts";

const auto = { direction: "auto", size: "50%", canFloat: true };

/** pi alone in a window of the given size. */
function full(width: number, height: number): PaneGeometry {
	return { windowWidth: width, windowHeight: height, paneLeft: 0, paneTop: 0, paneWidth: width, paneHeight: height };
}

test("a fixed direction always splits that way", () => {
	assert.deepEqual(chooseLayout(full(40, 10), { ...auto, direction: "horizontal" }), { kind: "split", direction: "h", size: "50%" });
	assert.deepEqual(chooseLayout(full(400, 100), { ...auto, direction: "v" }), { kind: "split", direction: "v", size: "50%" });
});

test("auto: side by side when both halves get 80 columns", () => {
	assert.equal(chooseLayout(full(161, 40), auto).kind, "split");
	assert.deepEqual(chooseLayout(full(161, 40), auto), { kind: "split", direction: "h", size: "50%" });
	assert.deepEqual(chooseLayout(full(160, 40), auto), { kind: "split", direction: "v", size: "50%" });
});

test("auto: top/bottom when too narrow but both halves get 15 rows", () => {
	assert.deepEqual(chooseLayout(full(100, 31), auto), { kind: "split", direction: "v", size: "50%" });
});

test("auto: a small pane floats the editor beside it, never over pi", () => {
	// pi in the bottom-right quarter of a 200x60 window.
	const geometry = { windowWidth: 200, windowHeight: 60, paneLeft: 100, paneTop: 30, paneWidth: 100, paneHeight: 30 };
	assert.deepEqual(chooseLayout(geometry, auto), { kind: "float", x: 0, y: 0, width: 99, height: 60 });
});

test("auto: without floating panes or room for one, split the roomier way", () => {
	const geometry = { windowWidth: 200, windowHeight: 60, paneLeft: 100, paneTop: 30, paneWidth: 100, paneHeight: 30 };
	assert.deepEqual(chooseLayout(geometry, { ...auto, canFloat: false }), { kind: "split", direction: "v", size: "50%" });
	assert.deepEqual(chooseLayout(full(100, 12), auto), { kind: "split", direction: "h", size: "50%" });
});

test("the size option counts in the side-by-side check", () => {
	assert.deepEqual(chooseLayout(full(200, 40), auto), { kind: "split", direction: "h", size: "50%" });
	assert.deepEqual(chooseLayout(full(200, 40), { ...auto, size: "30%" }), { kind: "split", direction: "v", size: "30%" });
	assert.deepEqual(splitCells(200, "30%"), [60, 139]);
	assert.deepEqual(splitCells(200, "90"), [90, 109]);
	assert.deepEqual(splitCells(200, "junk"), [99, 100]);
});

test("the region outside pi must fit a floating pane", () => {
	assert.equal(largestRegionOutsidePane(full(200, 60)), undefined);
	const top = { windowWidth: 120, windowHeight: 40, paneLeft: 0, paneTop: 0, paneWidth: 120, paneHeight: 12 };
	assert.deepEqual(largestRegionOutsidePane(top), { x: 0, y: 13, width: 120, height: 27 });
});

test("parsePaneInfo reads the display-message format", () => {
	assert.deepEqual(parsePaneInfo("3.8,1,200,60,100,30,100,30\n"), {
		version: "3.8",
		zoomed: true,
		geometry: { windowWidth: 200, windowHeight: 60, paneLeft: 100, paneTop: 30, paneWidth: 100, paneHeight: 30 },
	});
	assert.throws(() => parsePaneInfo("3.8,0,200"));
});

test("floating panes need tmux 3.8", () => {
	assert.equal(supportsFloatingPanes("3.8"), true);
	assert.equal(supportsFloatingPanes("3.8a"), true);
	assert.equal(supportsFloatingPanes("next-3.9"), true);
	assert.equal(supportsFloatingPanes("3.5a"), false);
	assert.equal(supportsFloatingPanes(""), false);
});
