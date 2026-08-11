import { describe, expect, jest, test } from "bun:test";

import { MadAtcTerminal } from "./app";

const flushMicrotasks = async (): Promise<void> => {
	await Promise.resolve();
};

const submitText = (app: MadAtcTerminal, value: string): void => {
	for (const char of value) app.handleInput(char);
	app.handleInput("\n");
};

// Matches PUSH_TO_TALK_RELEASE_QUIET_MS in app.ts — the quiet gap after the
// last SPACE press before a recording turn actually stops.
const RELEASE_QUIET_MS = 400;

describe("MadAtcTerminal", () => {
	test("records a Space-to-start, Space-to-transmit voice turn inside the Oh My Pi UI", async () => {
		const completed = Promise.withResolvers<void>();
		const uiCalls: string[] = [];
		let stopCalls = 0;
		const app = new MadAtcTerminal({
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					stop: async () => {
						stopCalls += 1;
						return { transcript: "tower request takeoff", roast: "hold short, keyboard hero", stdout: "", stderr: "", exitCode: 0 };
					},
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

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			expect(app.render(80).join("\n")).toContain("MIC LIVE");
			await flushMicrotasks();
			jest.advanceTimersByTime(10);
			expect(stopCalls).toBe(0);
			expect(app.render(80).join("\n")).not.toContain("hold short, keyboard hero");

			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await completed.promise;
		} finally {
			jest.useRealTimers();
		}

		const frame = app.render(80).join("\n");
		expect(frame).toContain("tower request takeoff");
		expect(frame).toContain("hold short, keyboard hero");
		expect(uiCalls).not.toContain("stop");
		expect(uiCalls).not.toContain("start");
	});

	test("waits out the release-quiet window after the recorder is ready before transmitting", async () => {
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let stopCalls = 0;
		const app = new MadAtcTerminal({
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

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			jest.advanceTimersByTime(10);
			expect(stopCalls).toBe(0);

			ready.resolve();
			await flushMicrotasks();
			jest.advanceTimersByTime(10);
			expect(stopCalls).toBe(0);

			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await stopped.promise;
		} finally {
			jest.useRealTimers();
		}
		expect(stopCalls).toBe(1);
	});

	test("keeps repeated Space key auto-repeat inside one starting push-to-talk turn", async () => {
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let recorderRuns = 0;
		let stopCalls = 0;
		const app = new MadAtcTerminal({
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => {
					recorderRuns += 1;
					return {
						ready: ready.promise,
						stop: async () => {
							stopCalls += 1;
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

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			jest.advanceTimersByTime(50);
			app.handleInput(" ");
			jest.advanceTimersByTime(50);
			app.handleInput(" ");
			jest.advanceTimersByTime(10);
			expect(recorderRuns).toBe(1);
			expect(stopCalls).toBe(0);

			ready.resolve();
			await flushMicrotasks();
			jest.advanceTimersByTime(10);
			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await stopped.promise;
		} finally {
			jest.useRealTimers();
		}

		expect(recorderRuns).toBe(1);
		expect(stopCalls).toBe(1);
	});

	test("ignores Enter while a Space-keyed recording is live", async () => {
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let stopCalls = 0;
		const app = new MadAtcTerminal({
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					ready: ready.promise,
					stop: async () => {
						stopCalls += 1;
						stopped.resolve();
						return { transcript: "space only", roast: "enter ignored", stdout: "", stderr: "", exitCode: 0 };
					},
				}),
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => undefined,
		});

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			ready.resolve();
			await flushMicrotasks();
			app.handleInput("\n");
			app.handleInput("\r");

			expect(stopCalls).toBe(0);
			expect(app.render(80).join("\n")).toContain("recording — press SPACE again to transmit");

			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await stopped.promise;
		} finally {
			jest.useRealTimers();
		}

		expect(stopCalls).toBe(1);
	});

	test("keeps held Space auto-repeat from stopping the recording, however long the hold", async () => {
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let stopCalls = 0;
		const app = new MadAtcTerminal({
			client: {
				sendText: async () => {
					throw new Error("sendText should not be called during push-to-talk");
				},
				startVoiceTurn: () => ({
					ready: ready.promise,
					stop: async () => {
						stopCalls += 1;
						stopped.resolve();
						return { transcript: "held repeat guarded", roast: "one released transmission", stdout: "", stderr: "", exitCode: 0 };
					},
				}),
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => undefined,
		});

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			ready.resolve();
			await flushMicrotasks();

			// Simulate holding the key for ~3s of real time with an uneven,
			// occasionally-slow OS auto-repeat cadence (some gaps well past the
			// old fixed 250ms debounce window, none past the release-quiet
			// window). None of these should stop the recording mid-hold.
			const repeatGapsMs = [40, 60, 45, 320, 55, 40, 300, 50, 60, 45, 350, 40];
			let held = 0;
			while (held < 3000) {
				for (const gap of repeatGapsMs) {
					jest.advanceTimersByTime(gap);
					app.handleInput(" ");
					held += gap;
					if (held >= 3000) break;
				}
			}
			expect(stopCalls).toBe(0);

			// Key released: no further presses, so once the quiet window
			// elapses the turn stops on its own.
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await stopped.promise;
		} finally {
			jest.useRealTimers();
		}

		expect(stopCalls).toBe(1);
	});

	test("ignores Space repeats while a released recording is processing", async () => {
		const stopStarted = Promise.withResolvers<void>();
		const finishStop = Promise.withResolvers<void>();
		const app = new MadAtcTerminal({
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

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			await flushMicrotasks();
			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await stopStarted.promise;
		} finally {
			jest.useRealTimers();
		}
		app.handleInput(" ");
		app.handleInput(" ");
		app.handleInput(" ");

		expect(app.render(80).join("\n")).not.toContain("stand by — current ATC request is still running");
		finishStop.resolve();
	});

	test("reports an empty recording as a retry instead of credentials failure", async () => {
		const completed = Promise.withResolvers<void>();
		const app = new MadAtcTerminal({
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

		jest.useFakeTimers();
		try {
			app.handleInput(" ");
			await flushMicrotasks();
			app.handleInput(" ");
			jest.advanceTimersByTime(RELEASE_QUIET_MS);
			await completed.promise;
		} finally {
			jest.useRealTimers();
		}

		const frame = app.render(80).join("\n");
		expect(frame).toContain("(nothing heard, try again)");
		expect(frame).toContain("ready — nothing heard");
		expect(frame).not.toContain("check credentials");
	});

	test("keeps manual PageUp position instead of snapping the log to the bottom", async () => {
		const completed = Promise.withResolvers<void>();
		const app = new MadAtcTerminal({
			client: {
				sendText: async () => ({
					prompt: "request",
					roast: Array.from({ length: 30 }, (_, index) => `tower line ${index}`).join("\n"),
					stderr: "",
				}),
				startVoiceTurn: () => {
					throw new Error("startVoiceTurn should not be called during /text");
				},
			},
		});
		app.attach({
			stop: () => undefined,
			start: () => undefined,
			requestRender: () => {
				if (app.render(80).join("\n").includes("tower line 29")) completed.resolve();
			},
		});

		submitText(app, "/text request");
		await completed.promise;
		expect(app.render(80).join("\n")).toContain("tower line 29");

		app.handleInput("\x1b[5~");

		expect(app.render(80).join("\n")).not.toContain("tower line 29");
	});
});
