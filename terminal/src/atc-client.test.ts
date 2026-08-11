import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MadAtcClient, buildRecordingName, parseAtcOutput } from "./atc-client";

describe("parseAtcOutput", () => {
	test("returns the roast text and generated voice path", () => {
		const parsed = parseAtcOutput("Cleared for takeoff. Try not to aim for the moon.\nvoice -> roast.wav\n");

		expect(parsed.roast).toBe("Cleared for takeoff. Try not to aim for the moon.");
		expect(parsed.voicePath).toBe("roast.wav");
	});

	test("keeps multi-line roasts but removes the voice marker", () => {
		const parsed = parseAtcOutput("Line one\nLine two\nvoice -> recordings/roast.wav\n");

		expect(parsed.roast).toBe("Line one\nLine two");
		expect(parsed.voicePath).toBe("recordings/roast.wav");
	});
});

describe("buildRecordingName", () => {
	test("creates a stable terminal-safe wav filename", () => {
		const name = buildRecordingName(new Date("2026-08-11T14:05:06.000Z"));

		expect(name).toBe("atc-2026-08-11T14-05-06-000Z.wav");
	});
});

describe("MadAtcClient", () => {
	const sandbox = join(import.meta.dir, "..", ".tmp-test-atc-client");
	const projectRoot = join(sandbox, "project");
	const terminalRoot = join(sandbox, "terminal");

	beforeEach(async () => {
		await rm(sandbox, { recursive: true, force: true });
		await mkdir(projectRoot, { recursive: true });
		await mkdir(terminalRoot, { recursive: true });
		await writeFile(join(projectRoot, "roast.wav"), "wav-bytes");
	});

	afterEach(async () => {
		await rm(sandbox, { recursive: true, force: true });
	});

	test("runs the Python ATC command and archives the generated wav", async () => {
		const calls: Array<{ command: string[]; cwd: string }> = [];
		const client = new MadAtcClient({
			projectRoot,
			terminalRoot,
			now: () => new Date("2026-08-11T14:05:06.000Z"),
			runCommand: async (command, options) => {
				calls.push({ command, cwd: options.cwd });
				return { stdout: "Hold short. Reading is hard, apparently.\nvoice -> roast.wav\n", stderr: "", exitCode: 0 };
			},
		});

		const result = await client.sendText("tower request takeoff");

		expect(calls).toEqual([{ command: ["uv", "run", "mad-atc", "tower request takeoff"], cwd: projectRoot }]);
		expect(result.roast).toBe("Hold short. Reading is hard, apparently.");
		expect(result.recordingPath.endsWith("recordings/atc-2026-08-11T14-05-06-000Z.wav")).toBe(true);
		expect(await Bun.file(result.recordingPath).text()).toBe("wav-bytes");
	});

	test("runs the live voice recorder as the terminal subprocess", async () => {
		const calls: Array<{ command: string[]; cwd: string }> = [];
		const client = new MadAtcClient({
			projectRoot,
			terminalRoot,
			runLiveCommand: async (command, options) => {
				calls.push({ command, cwd: options.cwd });
				return 0;
			},
		});

		const exitCode = await client.runLiveRecorder();

		expect(exitCode).toBe(0);
		expect(calls).toEqual([{ command: ["uv", "run", "python", "main.py"], cwd: projectRoot }]);
	});
});
