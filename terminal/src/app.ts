import {
	Box,
	Input,
	ProcessTerminal,
	ScrollView,
	TUI,
	Text,
	TruncatedText,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@oh-my-pi/pi-tui";

import { MadAtcClient } from "./atc-client";

type LogRole = "system" | "pilot" | "tower" | "recording" | "error";

type LogEntry = {
	role: LogRole;
	text: string;
};

type AppOptions = {
	client?: MadAtcClient;
};

const fg = {
	dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	red: (text: string) => `\x1b[31m${text}\x1b[39m`,
	green: (text: string) => `\x1b[32m${text}\x1b[39m`,
	yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
	cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

export class MadAtcTerminal implements Component, Focusable {
	focused = false;
	#ui?: TUI;
	#client: MadAtcClient;
	#input = new Input();
	#log = new ScrollView([], { height: 12, scrollbar: "auto" });
	#entries: LogEntry[] = [
		{ role: "system", text: "Frequency open. Type a pilot call, /record for live mic, /quit to sign off." },
	];
	#status = "ready";
	#busy = false;
	#cachedWidth = -1;
	#cachedHeight = -1;
	#cachedSignature = "";
	#cachedLines: string[] = [];

	constructor(options: AppOptions = {}) {
		this.#client = options.client ?? new MadAtcClient();
		this.#input.prompt = "pilot> ";
		this.#input.onSubmit = value => {
			void this.#submit(value);
		};
	}

	attach(ui: TUI): void {
		this.#ui = ui;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#input.setUseTerminalCursor(useTerminalCursor);
	}

	handleInput(data: string): void {
		if (data === "\x03") {
			this.#ui?.stop();
			return;
		}
		if (data === "\x12") {
			void this.#launchLiveRecorder();
			return;
		}
		if (data === "\x0c") {
			this.#entries = [];
			this.#status = "cleared";
			this.#requestRender();
			return;
		}
		if (data === "\x1b[5~") {
			this.#log.page(-1);
			this.#requestRender();
			return;
		}
		if (data === "\x1b[6~") {
			this.#log.page(1);
			this.#requestRender();
			return;
		}
		this.#input.handleInput(data);
	}

	render(width: number): readonly string[] {
		this.#input.focused = this.focused;
		const height = Math.max(12, process.stdout.rows || 24);
		const signature = `${this.#status}|${this.#busy}|${this.#input.getValue()}|${this.#entries.length}|${this.focused}`;
		if (this.#cachedWidth === width && this.#cachedHeight === height && this.#cachedSignature === signature) {
			return this.#cachedLines;
		}

		const bodyHeight = Math.max(6, height - 8);
		this.#log.setHeight(bodyHeight);
		this.#log.setLines(this.#renderLogLines(width));
		this.#log.scrollToBottom();

		const header = new Box(1, 0, undefined, {
			chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			color: fg.cyan,
		});
		header.addChild(new TruncatedText(`${fg.bold("MAD ATC")} ${fg.dim("terminal tower")}  ${fg.dim("Enter send · /record live mic · Ctrl+R recorder · PgUp/PgDn log · Ctrl+C quit")}`));

		const status = new Text(this.#busy ? `${fg.yellow("status:")} ${this.#status}` : `${fg.green("status:")} ${this.#status}`, 1, 0);
		const prompt = new Box(1, 0, undefined, {
			chars: { topLeft: "├", topRight: "┤", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			color: fg.dim,
		});
		prompt.addChild(this.#input);

		const lines = [
			...header.render(width),
			...this.#log.render(width),
			...status.render(width),
			...prompt.render(width),
		];
		this.#cachedWidth = width;
		this.#cachedHeight = height;
		this.#cachedSignature = signature;
		this.#cachedLines = lines.slice(0, height);
		return this.#cachedLines;
	}

	async #submit(value: string): Promise<void> {
		const prompt = value.trim();
		this.#input.setValue("");
		if (!prompt) {
			this.#setStatus("say again — empty transmission");
			return;
		}
		if (prompt === "/quit" || prompt === "/exit") {
			this.#ui?.stop();
			return;
		}
		if (prompt === "/record") {
			await this.#launchLiveRecorder();
			return;
		}
		if (this.#busy) {
			this.#append("error", "stand by — ATC is still answering the last call");
			return;
		}

		this.#busy = true;
		this.#append("pilot", prompt);
		this.#setStatus("ATC thinking and synthesizing voice...");
		try {
			const result = await this.#client.sendText(prompt);
			this.#append("tower", result.roast || "(no text returned)");
			if (result.recordingPath) {
				this.#append("recording", `saved ${result.recordingPath}`);
			}
			this.#setStatus("ready");
		} catch (error) {
			this.#append("error", error instanceof Error ? error.message : String(error));
			this.#setStatus("failed — check credentials/audio services, then try again");
		} finally {
			this.#busy = false;
			this.#requestRender();
		}
	}

	async #launchLiveRecorder(): Promise<void> {
		if (this.#busy) {
			this.#append("error", "stand by — current ATC request is still running");
			return;
		}
		this.#append("system", "handing terminal to live voice recorder; Ctrl+C inside recorder returns here");
		this.#setStatus("live recorder running");
		this.#ui?.stop();
		try {
			await this.#client.runLiveRecorder();
		} finally {
			this.#setStatus("returned from live recorder");
			this.#ui?.start({ clearScrollback: true });
			this.#requestRender(true);
		}
	}

	#renderLogLines(width: number): string[] {
		const usableWidth = Math.max(10, width - 2);
		const lines: string[] = [];
		for (const entry of this.#entries) {
			const prefix = this.#prefix(entry.role);
			for (const rawLine of entry.text.split("\n")) {
				lines.push(truncateToWidth(`${prefix} ${rawLine}`, usableWidth));
			}
		}
		return lines;
	}

	#prefix(role: LogRole): string {
		switch (role) {
			case "pilot": return fg.cyan("pilot>");
			case "tower": return fg.yellow("tower>");
			case "recording": return fg.green("rec  >");
			case "error": return fg.red("error>");
			case "system": return fg.dim("sys  >");
		}
	}

	#append(role: LogRole, text: string): void {
		this.#entries.push({ role, text });
		this.#cachedSignature = "";
		this.#requestRender();
	}

	#setStatus(status: string): void {
		this.#status = status;
		this.#cachedSignature = "";
		this.#requestRender();
	}

	#requestRender(force = false): void {
		this.#cachedSignature = "";
		this.#ui?.requestRender(force);
	}
}

export function startMadAtcTerminal(options: AppOptions = {}): void {
	const terminal = new ProcessTerminal();
	const ui = new TUI(terminal, true);
	const app = new MadAtcTerminal(options);
	app.attach(ui);
	ui.addChild(app);
	ui.setFocus(app);
	ui.start({ clearScrollback: true });
}
