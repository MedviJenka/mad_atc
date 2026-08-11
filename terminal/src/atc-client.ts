import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type VoiceTurnResult = {
	transcript: string;
	roast: string;
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type VoiceTurnSession = {
	stop(): Promise<VoiceTurnResult>;
};

export type RunCommand = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<CommandResult>;
export type RunVoiceTurnCommand = (command: string[], options: { cwd: string; env?: Record<string, string> }) => VoiceTurnSession;


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
	runVoiceTurnCommand?: RunVoiceTurnCommand;
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

export function parseVoiceTurnOutput(stdout: string): Pick<VoiceTurnResult, "transcript" | "roast"> {
	const marker = stdout
		.replace(/\r\n/g, "\n")
		.split("\n")
		.find(line => line.startsWith("result -> "));
	if (!marker) {
		throw new Error("voice turn completed without a result marker");
	}
	const parsed = JSON.parse(marker.slice("result -> ".length)) as { transcript?: unknown; roast?: unknown };
	if (typeof parsed.transcript !== "string" || typeof parsed.roast !== "string") {
		throw new Error("voice turn result marker is missing transcript or roast");
	}
	return { transcript: parsed.transcript, roast: parsed.roast };
}

export function buildRecordingName(date: Date = new Date()): string {
	return `atc-${date.toISOString().replaceAll(":", "-").replaceAll(".", "-")}.wav`;
}

export class MadAtcClient {
	readonly projectRoot: string;
	readonly terminalRoot: string;
	#now: () => Date;
	#runCommand: RunCommand;
	#runVoiceTurnCommand: RunVoiceTurnCommand;

	constructor(options: MadAtcClientOptions = {}) {
		this.projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
		this.terminalRoot = resolve(options.terminalRoot ?? DEFAULT_TERMINAL_ROOT);
		this.#now = options.now ?? (() => new Date());
		this.#runCommand = options.runCommand ?? runCommandWithBun;
		this.#runVoiceTurnCommand = options.runVoiceTurnCommand ?? runVoiceTurnCommandWithBun;
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

	startVoiceTurn(): VoiceTurnSession {
		return this.#runVoiceTurnCommand(["uv", "run", "python", "main.py", "--once"], {
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

function runVoiceTurnCommandWithBun(command: string[], options: { cwd: string; env?: Record<string, string> }): VoiceTurnSession {
	const proc = Bun.spawn(command, {
		cwd: options.cwd,
		env: { ...Bun.env, ...options.env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stopped = false;
	return {
		async stop(): Promise<VoiceTurnResult> {
			if (!stopped) {
				stopped = true;
				try {
					proc.stdin.write("\n");
					proc.stdin.end();
				} catch {
					// Process may have already exited; the exit code/stdout below is authoritative.
				}
			}
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				throw new Error(stderr.trim() || stdout.trim() || `mad-atc voice turn exited with ${exitCode}`);
			}
			const parsed = parseVoiceTurnOutput(stdout);
			return { ...parsed, stdout, stderr, exitCode };
		},
	};
}
