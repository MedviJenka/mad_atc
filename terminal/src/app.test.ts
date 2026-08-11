import { describe, expect, test } from "bun:test";

import { MadAtcTerminal } from "./app";


describe("MadAtcTerminal", () => {
	test("records a hold-Enter voice turn inside the Oh My Pi UI", async () => {
		const completed = Promise.withResolvers<void>();
		const uiCalls: string[] = [];
		const app = new MadAtcTerminal({
			pushToTalkReleaseMs: 1,
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					stop: async () => ({ transcript: "tower request takeoff", roast: "hold short, keyboard hero", stdout: "", stderr: "", exitCode: 0 }),
				}),
			},
		});
		app.attach({
			stop: () => uiCalls.push("stop"),
			start: () => uiCalls.push("start"),
			requestRender: () => {
				uiCalls.push("render");
				if (app.render(80).join("\n").includes("hold short, keyboard hero")) completed.resolve();
			},
		});

		app.handleInput("\n");
		expect(app.render(80).join("\n")).toContain("AWAKE");
		await completed.promise;

		const frame = app.render(80).join("\n");
		expect(frame).toContain("tower request takeoff");
		expect(frame).toContain("hold short, keyboard hero");
		expect(uiCalls).not.toContain("stop");
		expect(uiCalls).not.toContain("start");
	});

	test("does not release push-to-talk before the recorder is ready", async () => {
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let stopCalls = 0;
		const app = new MadAtcTerminal({
			pushToTalkReleaseMs: 1,
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					ready: ready.promise,
					stop: async () => {
						stopCalls += 1;
						stopped.resolve();
						return { transcript: "ready guarded", roast: "recorded after warmup", stdout: "", stderr: "", exitCode: 0 };
					},
				}),
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => undefined,
		});

		app.handleInput("\n");
		await Bun.sleep(10);
		expect(stopCalls).toBe(0);

		ready.resolve();
		await stopped.promise;
		expect(stopCalls).toBe(1);
	});

	test("keeps repeated Enter key auto-repeat inside one push-to-talk turn", async () => {
		const stopped = Promise.withResolvers<void>();
		let recorderRuns = 0;
		const app = new MadAtcTerminal({
			pushToTalkReleaseMs: 5,
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => {
					recorderRuns += 1;
					return {
						stop: async () => {
							stopped.resolve();
							return { transcript: "repeat guarded", roast: "one transmission", stdout: "", stderr: "", exitCode: 0 };
						},
					};
				},
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => undefined,
		});

		app.handleInput("\n");
		app.handleInput("\n");
		app.handleInput("\n");
		await stopped.promise;

		expect(recorderRuns).toBe(1);
	});

	test("ignores Enter repeats while a released recording is processing", async () => {
		const stopStarted = Promise.withResolvers<void>();
		const finishStop = Promise.withResolvers<void>();
		const app = new MadAtcTerminal({
			pushToTalkReleaseMs: 1,
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					stop: async () => {
						stopStarted.resolve();
						await finishStop.promise;
						return { transcript: "processed", roast: "done", stdout: "", stderr: "", exitCode: 0 };
					},
				}),
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => undefined,
		});

		app.handleInput("\n");
		await stopStarted.promise;
		app.handleInput("\n");
		app.handleInput("\n");
		app.handleInput("\n");

		expect(app.render(80).join("\n")).not.toContain("stand by — current ATC request is still running");
		finishStop.resolve();
	});

	test("reports an empty recording as a retry instead of credentials failure", async () => {
		const completed = Promise.withResolvers<void>();
		const app = new MadAtcTerminal({
			pushToTalkReleaseMs: 1,
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					stop: async () => {
						throw new Error("(nothing heard, try again)");
					},
				}),
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => {
				if (app.render(80).join("\n").includes("(nothing heard, try again)")) completed.resolve();
			},
		});

		app.handleInput("\n");
		await completed.promise;

		const frame = app.render(80).join("\n");
		expect(frame).toContain("(nothing heard, try again)");
		expect(frame).toContain("status:");
		expect(frame).not.toContain("check credentials");
	});
});
