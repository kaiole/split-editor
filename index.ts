import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	CustomEditor,
	getAgentDir,
	type AppKeybinding,
	type ExtensionAPI,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { chooseLayout, PANE_FORMAT, parsePaneInfo, supportsFloatingPanes, type Layout, type PaneInfo } from "./layout.ts";

const DEFAULT_CONFIG: SplitEditorConfig = {
	editor: "nvim",
	size: "50%",
	direction: "auto",
};

/** App actions that only change what pi shows, so they still work while the prompt is locked. */
const VIEW_ACTIONS: readonly AppKeybinding[] = ["app.tools.expand", "app.thinking.toggle", "app.message.copy"];


type SplitEditorConfig = {
	editor: string;
	size: string;
	direction: string;
};

type RawConfig = Partial<SplitEditorConfig> & {
	splitEditor?: Partial<SplitEditorConfig>;
};

/** Set while the editor pane owns the prompt. */
type Lock = { phase: "opening" } | { phase: "editing"; paneId: string };

type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

class SplitEditor extends CustomEditor {
	private lock: Lock | undefined;
	private editorName = basename(DEFAULT_CONFIG.editor);
	private disposed = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly appKeybindings: KeybindingsManager,
		private readonly ui: ExtensionUIContext,
		private readonly cwd: string,
	) {
		super(tui, theme, appKeybindings);
	}

	/** The session ended; a pane still open must not write into this editor. */
	dispose(): void {
		this.disposed = true;
	}

	handleInput(data: string): void {
		// Intercept before CustomEditor's copied app handlers so pi's built-in
		// blocking external-editor action never runs.
		if (this.appKeybindings.matches(data, "app.editor.external")) {
			if (this.lock) {
				void this.focusEditorPane();
				return;
			}
			if (!process.env.TMUX) {
				this.notify("tmux not detected; using pi's external editor; start tmux for split editing or disable split-editor to stop this warning.", "warning");
				super.handleInput(data);
				return;
			}
			void this.openSplitEditor();
			return;
		}

		if (this.lock) {
			// The pane owns the prompt: drop typing, Enter and Esc (a vim reflex
			// would abort the agent), but keep extension shortcuts such as
			// browse's and the actions that only change the view.
			if (this.onExtensionShortcut?.(data)) return;
			for (const action of VIEW_ACTIONS) {
				if (this.appKeybindings.matches(data, action)) {
					this.actionHandlers.get(action)?.();
					return;
				}
			}
			return;
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		return this.lock ? this.renderLocked(width) : super.render(width);
	}

	/**
	 * An accent border naming the editor, and the prompt dimmed. No cursor
	 * marker, so pi hides the terminal cursor: input goes to the pane.
	 */
	private renderLocked(width: number): string[] {
		const theme = this.ui.theme;
		const border = (text: string) => theme.fg("accent", text);
		const key = this.appKeybindings.getKeys("app.editor.external")[0] ?? "ctrl+g";
		const label =
			this.lock?.phase === "editing" ? ` editing in ${this.editorName} · ${key} goes there ` : ` opening ${this.editorName}… `;

		const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - padding * 2 - (padding ? 0 : 1));
		const maxLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		const wrapped = this.getText()
			.split("\n")
			.flatMap((line) => (line ? wrapTextWithAnsi(line, contentWidth) : [""]));
		const shown = wrapped.slice(0, maxLines);
		const hidden = wrapped.length - shown.length;

		const pad = " ".repeat(padding);
		return [
			border(labeledRule(label, width)),
			...shown.map((line) => pad + theme.fg("dim", line) + " ".repeat(Math.max(0, width - padding - visibleWidth(line)))),
			border(hidden > 0 ? labeledRule(` ↓ ${hidden} more `, width) : "─".repeat(width)),
		];
	}

	private async openSplitEditor(): Promise<void> {
		this.lock = { phase: "opening" };
		this.tui.requestRender();
		let dir: string | undefined;
		let keepDir = false;

		try {
			const config = await loadConfig(this.cwd);
			this.editorName = basename(config.editor.split(/\s+/)[0] ?? config.editor);
			dir = await mkdtemp(join(tmpdir(), "pi-split-editor-"));
			const files = { prompt: join(dir, "prompt.md"), status: join(dir, "status") };
			const original = this.getExpandedText();
			await writeFile(files.prompt, original, { encoding: "utf8", mode: 0o600 });

			const target = process.env.TMUX_PANE;
			const pane = await queryPane(target);
			const layout = chooseLayout(pane.geometry, {
				direction: config.direction,
				size: config.size,
				canFloat: supportsFloatingPanes(pane.version),
			});
			const editorPane = await openPane({
				layout,
				target,
				cwd: this.cwd,
				token: `pi-split-editor-${basename(dir)}`,
				command: `${config.editor} ${shellQuote(files.prompt)}`,
				statusFile: files.status,
			});
			this.lock = { phase: "editing", paneId: editorPane.id };
			this.tui.requestRender();
			await editorPane.closed;
			this.lock = undefined;

			const status = (await readOptional(files.status))?.trim();
			const edited = (await readFile(files.prompt, "utf8")).replace(/\n$/, "");
			const changed = edited !== original;

			if (this.disposed || status === undefined) {
				// The session ended, or the pane was killed before the editor exited.
				if (changed) {
					keepDir = true;
					const why = this.disposed ? "pi session changed while editing" : "editor pane closed";
					this.notify(`${why}; prompt unchanged, edits kept in ${files.prompt}`, "warning");
				}
				return;
			}
			if (status !== "0") {
				this.notify(`${this.editorName} exited with status ${status}; prompt unchanged`, "info");
				return;
			}

			if (changed) this.setText(edited);
		} catch (error) {
			this.notify(`split-editor: ${formatError(error)}`, "error");
		} finally {
			this.lock = undefined;
			if (dir && !keepDir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private async focusEditorPane(): Promise<void> {
		if (this.lock?.phase !== "editing") return;
		const { paneId } = this.lock;
		try {
			await tmux(["select-window", "-t", paneId, ";", "select-pane", "-t", paneId]);
		} catch (error) {
			this.notify(`split-editor: ${formatError(error)}`, "error");
		}
	}

	private notify(message: string, type: "info" | "warning" | "error"): void {
		try {
			this.ui.notify(message, type);
		} catch {
			// The ui of a replaced session throws; there is nowhere left to report.
		}
	}
}

/** "──" + label, then rule to the full width; the label is cut when narrow. */
function labeledRule(label: string, width: number): string {
	const head = truncateToWidth(`──${label}`, width, "");
	return head + "─".repeat(Math.max(0, width - visibleWidth(head)));
}

async function queryPane(target: string | undefined): Promise<PaneInfo> {
	const targetArgs = target ? ["-t", target] : [];
	let info = parsePaneInfo(await tmux(["display-message", "-p", ...targetArgs, PANE_FORMAT]));
	if (info.zoomed) {
		// A split would unzoom anyway; do it first so the layout sees the real pane.
		await tmux(["resize-pane", "-Z", ...targetArgs]);
		info = parsePaneInfo(await tmux(["display-message", "-p", ...targetArgs, PANE_FORMAT]));
	}
	return info;
}

/**
 * Opens the editor pane. `closed` resolves when the pane's shell exits, killed
 * or not: its EXIT trap signals a tmux wait-for channel, which is waited on
 * before the pane exists so the signal cannot be missed.
 */
async function openPane(options: {
	layout: Layout;
	target: string | undefined;
	cwd: string;
	token: string;
	command: string;
	statusFile: string;
}): Promise<{ id: string; closed: Promise<void> }> {
	const wait = startTmux(["wait-for", options.token]);
	const closed = wait.result.then((result) => {
		if (result.code !== 0) throw new Error(`tmux wait-for failed${formatProcessDetails(result)}`);
	});
	closed.catch(() => undefined); // handled by the caller's await; this only marks it handled meanwhile

	const paneCommand = [
		`trap ${shellQuote(`tmux wait-for -S ${shellQuote(options.token)}`)} EXIT`,
		options.command,
		`printf '%s' "$?" > ${shellQuote(options.statusFile)}`,
	].join("; ");

	try {
		const id = await tmux([...paneArgs(options.layout), "-P", "-F", "#{pane_id}", "-c", options.cwd, ...(options.target ? ["-t", options.target] : []), paneCommand]);
		return { id, closed };
	} catch (error) {
		wait.child.kill();
		throw error;
	}
}

function paneArgs(layout: Layout): string[] {
	if (layout.kind === "split") return ["split-window", `-${layout.direction}`, "-l", layout.size];
	return ["new-pane", "-X", String(layout.x), "-Y", String(layout.y), "-x", String(layout.width), "-y", String(layout.height)];
}

async function loadConfig(cwd: string): Promise<SplitEditorConfig> {
	const globalConfig = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "extensions", "split-editor.json")));
	const projectConfig = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "split-editor.json")));
	const globalSettings = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "settings.json")));
	const projectSettings = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "settings.json")));
	const envConfig = normalizeRawConfig({
		editor: process.env.SPLIT_EDITOR_EDITOR,
		size: process.env.SPLIT_EDITOR_SIZE,
		direction: process.env.SPLIT_EDITOR_DIRECTION,
	});

	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...globalSettings,
		...projectConfig,
		...projectSettings,
		...envConfig,
	};
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function normalizeRawConfig(raw: unknown): Partial<SplitEditorConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as RawConfig;
	const source = record.splitEditor && typeof record.splitEditor === "object" ? record.splitEditor : record;
	const config: Partial<SplitEditorConfig> = {};

	if (typeof source.editor === "string" && source.editor.trim()) config.editor = source.editor.trim();
	if (typeof source.size === "string" && source.size.trim()) config.size = source.size.trim();
	if (typeof source.direction === "string" && source.direction.trim()) config.direction = source.direction.trim();

	return config;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function startTmux(args: readonly string[]): { child: ChildProcess; result: Promise<ProcessResult> } {
	const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
	const result = new Promise<ProcessResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendLimited(stdout, chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendLimited(stderr, chunk.toString("utf8"));
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
	return { child, result };
}

/** Runs tmux and returns its trimmed stdout; throws on a non-zero exit. */
async function tmux(args: readonly string[]): Promise<string> {
	const result = await startTmux(args).result;
	if (result.code !== 0) throw new Error(`tmux ${args[0]} failed${formatProcessDetails(result)}`);
	return result.stdout.trim();
}

function appendLimited(current: string, next: string, maxLength = 8192): string {
	const combined = current + next;
	return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

function formatProcessDetails(result: ProcessResult): string {
	const parts: string[] = [];
	if (result.code !== null) parts.push(`exit ${result.code}`);
	if (result.signal) parts.push(`signal ${result.signal}`);
	const status = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	const stderr = result.stderr.trim();
	return stderr ? `${status}: ${stderr}` : status;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	let current: SplitEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			current = new SplitEditor(tui, theme, keybindings, ctx.ui, ctx.cwd);
			return current;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		current?.dispose();
		current = undefined;
		ctx.ui.setEditorComponent(undefined);
	});
}
