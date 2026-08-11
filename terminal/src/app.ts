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
};

const sgr = (code: string, reset = "39") => (text: string) => `\x1b[${code}m${text}\x1b[${reset}m`;

const fg = {
	dim: sgr("2", "22"),
	red: sgr("31"),
	green: sgr("32"),
	yellow: sgr("33"),
	blue: sgr("34"),
	magenta: sgr("35"),
	cyan: sgr("36"),
	white: sgr("37"),
	bold: sgr("1", "22"),
	orange: sgr("38;5;208"),
	violet: sgr("38;5;141"),
	steel: sgr("38;5;75"),
};

const PUSH_TO_TALK_KEY = " ";
const PUSH_TO_TALK_LABEL = "SPACE";
// A held key sends OS auto-repeat events at an uneven cadence (a slow initial
// repeat-delay, then jittery repeats). Comparing the gap between consecutive
// events against a fixed window is unreliable — any one late repeat reads as
// a deliberate second press and stops the recording mid-hold. Instead every
// press while recording (re)arms this trailing timer; it only fires — and
// actually stops the turn — once no further SPACE arrives before it elapses,
// which holds up under holding the key regardless of repeat timing.
const PUSH_TO_TALK_RELEASE_QUIET_MS = 400;


export class MadAtcTerminal implements Component, Focusable {
	static readonly #RADAR_FRAMES = ["◜", "◝", "◞", "◟"];
	static readonly #WAVE_FRAMES = ["▁▂▃▄▅▆", "▂▃▄▅▆▇", "▃▄▅▆▇█", "▄▅▆▇█▇", "▃▄▅▆▇█", "▂▃▄▅▆▇"];

	focused = false;
	#ui?: TUI;
	#client: AppClient;
	#pushToTalkStopTimer?: NodeJS.Timeout;
	#input = new Input();
	#log = new ScrollView([], {
		height: 12,
		scrollbar: "auto",
		theme: { track: fg.dim, thumb: fg.cyan },
		trackChar: "│",
		thumbChar: "█",
	});
	#entries: LogEntry[] = [
		{ role: "system", text: `${PUSH_TO_TALK_LABEL} keys mic, ${PUSH_TO_TALK_LABEL} transmits. /text <call> is the text-only fallback.` },
	];
	#status = "ready";
	#busy = false;
	#voiceSession?: VoiceTurnSession;
	#voiceRecorderReady = false;
	#awakeTimer?: NodeJS.Timeout;
	#awakeFrame = 0;
	#voicePhase: "idle" | "recording" | "processing" = "idle";
	#logFollowsBottom = true;
	#cachedWidth = -1;
	#cachedHeight = -1;
	#cachedSignature = "";
	#cachedLines: string[] = [];

	constructor(options: AppOptions = {}) {
		this.#client = options.client ?? new MadAtcClient();
		this.#input.prompt = `${fg.cyan("radio")} ${fg.dim("›")} `;
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
			this.#clearPushToTalkStopTimer();
			this.#disposeAwakeAnimation();
			this.#ui?.stop();
			return;
		}
		if (data === "\x12") {
			this.#input.setValue("");
			this.#handlePushToTalkKey();
			return;
		}
		if (data === "\x0c") {
			this.#entries = [];
			this.#status = "cleared";
			this.#logFollowsBottom = true;
			this.#requestRender();
			return;
		}
		if (data === "\x1b[5~") {
			this.#log.page(-1);
			this.#logFollowsBottom = false;
			this.#requestRender();
			return;
		}
		if (data === "\x1b[6~") {
			this.#log.page(1);
			this.#logFollowsBottom = this.#log.getScrollOffset() === this.#log.getMaxScrollOffset();
			this.#requestRender();
			return;
		}
		if ((data === "\n" || data === "\r") && (this.#voiceSession || this.#input.getValue().trim() === "")) {
			return;
		}
		if (data === PUSH_TO_TALK_KEY && (this.#voiceSession || this.#input.getValue().trim() === "" || this.#input.getValue().trim() === "/record")) {
			if (this.#input.getValue().trim() === "/record") this.#input.setValue("");
			this.#handlePushToTalkKey();
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

		const bodyHeight = Math.max(6, height - 11);
		this.#log.setHeight(bodyHeight);
		this.#log.setLines(this.#renderLogLines(width));
		if (this.#logFollowsBottom) this.#log.scrollToBottom();

		const header = new Box(1, 0, undefined, {
			chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			color: this.#borderColor(),
		});
		header.addChild(new TruncatedText(`${fg.bold(fg.orange("MAD"))}${fg.bold(fg.white(" ATC"))} ${fg.dim("live tower")}  ${fg.steel(`${PUSH_TO_TALK_LABEL} start/stop`)} ${fg.dim("·")} ${fg.violet("/text <call>")} ${fg.dim("· PgUp/PgDn log · Ctrl+C quit")}`));

		const status = new Text(`${this.#statusBadge()} ${this.#status}`, 1, 0);
		const awake = new Text(this.#renderAwakeLine(), 1, 0);
		const hint = new Text(fg.dim(this.#voicePhase === "recording" ? `Speak now. Press ${PUSH_TO_TALK_LABEL} again when the transmission is complete.` : "Keep transmissions short. The tower has zero patience and excellent hearing."), 1, 0);
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
			...hint.render(width),
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
		if (prompt === "/record") {
			this.#handlePushToTalkKey();
			return;
		}
		if (!prompt) {
			this.#setStatus("ready");
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
		this.#append("error", `audio is primary here — press ${PUSH_TO_TALK_LABEL} to talk, or use /text <call> for text-only fallback`);
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

	#handlePushToTalkKey(): void {
		if (this.#voiceSession) {
			if (!this.#voiceRecorderReady) {
				this.#setStatus("recorder warming — wait for live before transmit");
				return;
			}
			this.#armPushToTalkStop();
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
		this.#append("system", "mic keyed — opening recorder");
		this.#setStatus("starting recorder — get ready to speak");
		this.#startAwakeAnimation();
		void (session.ready ?? Promise.resolve()).then(() => {
			if (this.#voiceSession !== session || this.#voicePhase !== "recording") return;
			this.#voiceRecorderReady = true;
			this.#append("system", `recorder live — speak, then press ${PUSH_TO_TALK_LABEL} to transmit`);
			this.#setStatus(`recording — press ${PUSH_TO_TALK_LABEL} again to transmit`);
		});
	}

	#armPushToTalkStop(): void {
		if (this.#pushToTalkStopTimer) {
			clearTimeout(this.#pushToTalkStopTimer);
		}
		this.#pushToTalkStopTimer = setTimeout(() => {
			this.#pushToTalkStopTimer = undefined;
			void this.#finishPushToTalk();
		}, PUSH_TO_TALK_RELEASE_QUIET_MS);
	}

	#clearPushToTalkStopTimer(): void {
		if (this.#pushToTalkStopTimer) {
			clearTimeout(this.#pushToTalkStopTimer);
			this.#pushToTalkStopTimer = undefined;
		}
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
			this.#clearPushToTalkStopTimer();
			this.#busy = false;
			this.#voicePhase = "idle";
			this.#disposeAwakeAnimation();
			this.#requestRender();
		}
	}

	#startAwakeAnimation(): void {
		if (this.#awakeTimer) return;
		this.#awakeTimer = setInterval(() => {
			this.#awakeFrame = (this.#awakeFrame + 1) % MadAtcTerminal.#WAVE_FRAMES.length;
			this.#requestRender();
		}, 120);
	}

	#disposeAwakeAnimation(): void {
		if (this.#awakeTimer) {
			clearInterval(this.#awakeTimer);
			this.#awakeTimer = undefined;
		}
		this.#awakeFrame = 0;
	}

	#renderAwakeLine(): string {
		const radar = MadAtcTerminal.#RADAR_FRAMES[this.#awakeFrame % MadAtcTerminal.#RADAR_FRAMES.length] ?? MadAtcTerminal.#RADAR_FRAMES[0];
		const wave = MadAtcTerminal.#WAVE_FRAMES[this.#awakeFrame % MadAtcTerminal.#WAVE_FRAMES.length] ?? MadAtcTerminal.#WAVE_FRAMES[0];
		if (this.#voicePhase === "idle") {
			return `${fg.dim("radar")} ${fg.green("●")} ${fg.dim("standby")} ${fg.dim("─")} ${fg.steel(`press ${PUSH_TO_TALK_LABEL} to key mic`)}`;
		}
		if (this.#voicePhase === "recording") {
			return `${fg.cyan(radar)} ${fg.green(wave)} ${fg.yellow("MIC LIVE")} ${fg.dim(`speak, then ${PUSH_TO_TALK_LABEL} to transmit`)}`;
		}
		return `${fg.magenta(radar)} ${fg.violet(wave)} ${fg.yellow("TOWER PROCESSING")} ${fg.dim("transcribing · roasting · speaking")}`;
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
			case "pilot": return fg.cyan("✈ pilot ");
			case "tower": return fg.orange("▣ tower ");
			case "recording": return fg.green("◆ rec   ");
			case "error": return fg.red("▲ error ");
			case "system": return fg.dim("◇ sys   ");
		}
	}


	#borderColor(): (text: string) => string {
		if (this.#voicePhase === "recording") return fg.green;
		if (this.#voicePhase === "processing") return fg.magenta;
		return fg.cyan;
	}

	#statusBadge(): string {
		if (this.#voicePhase === "recording") return fg.green("● recording");
		if (this.#voicePhase === "processing") return fg.magenta("◆ processing");
		if (this.#busy) return fg.yellow("● busy");
		return fg.green("● ready");
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
