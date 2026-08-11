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

import { MadAtcClient, type VoiceTurnSession } from "./atc-client";

type LogRole = "system" | "pilot" | "tower" | "recording" | "error";

type LogEntry = {
	role: LogRole;
	text: string;
};

type AppClient = Pick<MadAtcClient, "sendText" | "startVoiceTurn">;

type AppOptions = {
	client?: AppClient;
	pushToTalkReleaseMs?: number;
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
	static readonly #DEFAULT_PUSH_TO_TALK_RELEASE_MS = 750;
	static readonly #AWAKE_FRAMES = ["AWAKE  ▂▃▄▅", "AWAKE  ▃▄▅▆", "AWAKE  ▄▅▆▇", "AWAKE  ▅▆▇█", "AWAKE  ▄▅▆▇", "AWAKE  ▃▄▅▆"];

	focused = false;
	#ui?: TUI;
	#client: AppClient;
	#input = new Input();
	#log = new ScrollView([], { height: 12, scrollbar: "auto" });
	#entries: LogEntry[] = [
		{ role: "system", text: "Frequency open. Hold ENTER to key the mic. Type /text <call> only for a text-only fallback." },
	];
	#status = "ready";
	#busy = false;
	#voiceSession?: VoiceTurnSession;
	#voiceRecorderReady = false;
	#pushToTalkReleaseTimer?: NodeJS.Timeout;
	#pushToTalkReleaseMs: number;
	#awakeTimer?: NodeJS.Timeout;
	#awakeFrame = 0;
	#voicePhase: "idle" | "recording" | "processing" = "idle";
	#cachedWidth = -1;
	#cachedHeight = -1;
	#cachedSignature = "";
	#cachedLines: string[] = [];

	constructor(options: AppOptions = {}) {
		this.#client = options.client ?? new MadAtcClient();
		this.#pushToTalkReleaseMs = options.pushToTalkReleaseMs ?? MadAtcTerminal.#DEFAULT_PUSH_TO_TALK_RELEASE_MS;
		this.#input.prompt = "audio> ";
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
			this.#disposeAwakeAnimation();
			this.#ui?.stop();
			return;
		}
		if (data === "\x12") {
			this.#input.setValue("");
			this.#handlePushToTalkEnter();
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
		if ((data === "\n" || data === "\r") && (this.#voiceSession || this.#input.getValue().trim() === "" || this.#input.getValue().trim() === "/record")) {
			if (this.#input.getValue().trim() === "/record") this.#input.setValue("");
			this.#handlePushToTalkEnter();
			return;
		}
		this.#input.handleInput(data);
	}

	render(width: number): readonly string[] {
		this.#input.focused = this.focused;
		const height = Math.max(12, process.stdout.rows || 24);
		const signature = `${this.#status}|${this.#busy}|${this.#voicePhase}|${this.#awakeFrame}|${this.#input.getValue()}|${this.#entries.length}|${this.focused}`;
		if (this.#cachedWidth === width && this.#cachedHeight === height && this.#cachedSignature === signature) {
			return this.#cachedLines;
		}

		const bodyHeight = Math.max(6, height - 9);
		this.#log.setHeight(bodyHeight);
		this.#log.setLines(this.#renderLogLines(width));
		this.#log.scrollToBottom();

		const header = new Box(1, 0, undefined, {
			chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			color: fg.cyan,
		});
		header.addChild(new TruncatedText(`${fg.bold("MAD ATC")} ${fg.dim("audio terminal tower")}  ${fg.dim("Hold Enter PTT · /text <call> fallback · PgUp/PgDn log · Ctrl+C quit")}`));

		const status = new Text(this.#busy ? `${fg.yellow("status:")} ${this.#status}` : `${fg.green("status:")} ${this.#status}`, 1, 0);
		const awake = new Text(this.#renderAwakeLine(), 1, 0);
		const prompt = new Box(1, 0, undefined, {
			chars: { topLeft: "├", topRight: "┤", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			color: fg.dim,
		});
		prompt.addChild(this.#input);

		const lines = [
			...header.render(width),
			...this.#log.render(width),
			...status.render(width),
			...awake.render(width),
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
		if (!prompt || prompt === "/record") {
			this.#handlePushToTalkEnter();
			return;
		}
		if (prompt === "/quit" || prompt === "/exit") {
			this.#ui?.stop();
			return;
		}
		if (prompt.startsWith("/text ")) {
			await this.#sendText(prompt.slice(6));
			return;
		}
		this.#append("error", "audio is primary here — hold ENTER to talk, or use /text <call> for text-only fallback");
		this.#setStatus("ready");
	}

	async #sendText(prompt: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) {
			this.#setStatus("say again — empty /text transmission");
			return;
		}
		if (this.#busy) {
			this.#append("error", "stand by — ATC is still answering the last call");
			return;
		}

		this.#busy = true;
		this.#append("pilot", trimmed);
		this.#setStatus("ATC thinking and synthesizing voice...");
		try {
			const result = await this.#client.sendText(trimmed);
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

	#handlePushToTalkEnter(): void {
		if (this.#voiceSession) {
			if (this.#voiceRecorderReady) {
				this.#armPushToTalkRelease();
			}
			return;
		}
		if (this.#busy) {
			return;
		}

		this.#busy = true;
		this.#voicePhase = "recording";
		const session = this.#client.startVoiceTurn();
		this.#voiceSession = session;
		this.#voiceRecorderReady = false;
		this.#append("system", "mic keyed — starting recorder; keep holding ENTER");
		this.#setStatus("starting recorder — hold ENTER");
		this.#startAwakeAnimation();
		void (session.ready ?? Promise.resolve()).then(() => {
			if (this.#voiceSession !== session || this.#voicePhase !== "recording") return;
			this.#voiceRecorderReady = true;
			this.#append("system", "recorder live — release ENTER to transmit");
			this.#setStatus("recording — hold ENTER, release to transmit");
			this.#armPushToTalkRelease();
		});
	}

	#armPushToTalkRelease(): void {
		clearTimeout(this.#pushToTalkReleaseTimer);
		this.#pushToTalkReleaseTimer = setTimeout(() => {
			this.#pushToTalkReleaseTimer = undefined;
			void this.#finishPushToTalk();
		}, this.#pushToTalkReleaseMs);
	}

	async #finishPushToTalk(): Promise<void> {
		const session = this.#voiceSession;
		if (!session) return;

		this.#voiceSession = undefined;
		this.#voiceRecorderReady = false;
		this.#voicePhase = "processing";
		this.#setStatus("transmitting — ATC transcribing, roasting, and speaking...");
		try {
			const result = await session.stop();
			this.#append("pilot", result.transcript || "(nothing transcribed)");
			this.#append("tower", result.roast || "(no text returned)");
			this.#setStatus("ready");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#append("error", message);
			this.#setStatus(message.includes("nothing heard") ? "ready — nothing heard, try again" : "failed — check credentials/audio services, then try again");
		} finally {
			this.#busy = false;
			this.#voicePhase = "idle";
			this.#disposeAwakeAnimation();
			this.#requestRender();
		}
	}

	#startAwakeAnimation(): void {
		if (this.#awakeTimer) return;
		this.#awakeTimer = setInterval(() => {
			this.#awakeFrame = (this.#awakeFrame + 1) % MadAtcTerminal.#AWAKE_FRAMES.length;
			this.#requestRender();
		}, 120);
	}

	#disposeAwakeAnimation(): void {
		if (this.#pushToTalkReleaseTimer) {
			clearTimeout(this.#pushToTalkReleaseTimer);
			this.#pushToTalkReleaseTimer = undefined;
		}
		if (this.#awakeTimer) {
			clearInterval(this.#awakeTimer);
			this.#awakeTimer = undefined;
		}
		this.#awakeFrame = 0;
	}

	#renderAwakeLine(): string {
		if (this.#voicePhase === "idle") {
			return fg.dim("awake idle — hold ENTER to talk");
		}
		const frame = MadAtcTerminal.#AWAKE_FRAMES[this.#awakeFrame] ?? MadAtcTerminal.#AWAKE_FRAMES[0];
		const message = this.#voicePhase === "recording" ? "listening to pilot audio" : "tower is working the transmission";
		return `${fg.cyan(frame)} ${fg.yellow(message)}`;
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
