import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type RunCommand = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<CommandResult>;
export type RunLiveCommand = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<number>;


export type ParsedAtcOutput = {
	roast: string;
	voicePath?: string;
};

export type AtcRunResult = {
	prompt: string;
	roast: string;
	recordingPath?: string;
	stderr: string;
};

export type MadAtcClientOptions = {
	projectRoot?: string;
	terminalRoot?: string;
	now?: () => Date;
	runCommand?: RunCommand;
	runLiveCommand?: RunLiveCommand;
};

const DEFAULT_PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_TERMINAL_ROOT = resolve(import.meta.dir, "..");

export function parseAtcOutput(stdout: string): ParsedAtcOutput {
	const lines = stdout.replace(/\r\n/g, "\n").split("\n");
	let voicePath: string | undefined;
	const roastLines: string[] = [];

	for (const line of lines) {
		const match = line.match(/^voice\s*->\s*(.+?)\s*$/i);
		if (match) {
			voicePath = match[1];
			continue;
		}
		roastLines.push(line);
	}

	return {
		roast: roastLines.join("\n").trim(),
		voicePath,
	};
}

export function buildRecordingName(date: Date = new Date()): string {
	return `atc-${date.toISOString().replaceAll(":", "-").replaceAll(".", "-")}.wav`;
}

export class MadAtcClient {
	readonly projectRoot: string;
	readonly terminalRoot: string;
	#now: () => Date;
	#runCommand: RunCommand;
	#runLiveCommand: RunLiveCommand;

	constructor(options: MadAtcClientOptions = {}) {
		this.projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
		this.terminalRoot = resolve(options.terminalRoot ?? DEFAULT_TERMINAL_ROOT);
		this.#now = options.now ?? (() => new Date());
		this.#runCommand = options.runCommand ?? runCommandWithBun;
		this.#runLiveCommand = options.runLiveCommand ?? runLiveCommandWithInheritedTerminal;
	}

	async sendText(prompt: string): Promise<AtcRunResult> {
		const trimmed = prompt.trim();
		if (!trimmed) {
			throw new Error("Pilot transmission is empty.");
		}

		const result = await this.#runCommand(["uv", "run", "mad-atc", trimmed], {
			cwd: this.projectRoot,
			env: { VERBOSE: "false" },
		});
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `mad-atc exited with ${result.exitCode}`);
		}

		const parsed = parseAtcOutput(result.stdout);
		let recordingPath: string | undefined;
		if (parsed.voicePath) {
			recordingPath = await this.#archiveRecording(parsed.voicePath);
		}

		return {
			prompt: trimmed,
			roast: parsed.roast,
			recordingPath,
			stderr: result.stderr,
		};
	}

	async runLiveRecorder(): Promise<number> {
		return await this.#runLiveCommand(["uv", "run", "python", "main.py"], {
			cwd: this.projectRoot,
			env: { VERBOSE: "false" },
		});
	}

	async #archiveRecording(relativeOrAbsoluteVoicePath: string): Promise<string> {
		const sourcePath = resolve(this.projectRoot, relativeOrAbsoluteVoicePath);
		const destination = join(this.terminalRoot, "recordings", buildRecordingName(this.#now()));
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(sourcePath, destination);
		return destination.replaceAll("\\", "/");
	}
}

async function runCommandWithBun(command: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CommandResult> {
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...Bun.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function runLiveCommandWithInheritedTerminal(command: string[], options: { cwd: string; env?: Record<string, string> }): Promise<number> {
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...Bun.env, ...options.env },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await proc.exited;
}
