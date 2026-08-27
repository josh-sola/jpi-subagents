/**
 * background-shortcut-wiring.test.ts — ctrl+b through the REAL extension: the
 * `Agent` tool's foreground branch, the `session_start` key registration, and
 * the `background-shortcut` setting, together.
 *
 * Mirrors foreground-concurrency-wiring.test.ts's `controllableRuns` /
 * `callForeground` pattern — same tool, same mocked `runAgent`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  await subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** A UI whose `onTerminalInput` handler is captured for direct invocation. */
function captureUI() {
  let handler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  const ui = {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    onTerminalInput: vi.fn((h: any) => { handler = h; return vi.fn(); }),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
  return { ui, send: (data: string) => handler!(data) };
}

/** Runs that settle only when their resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation(
    (_c: any, _t: any, prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.onSessionCreated?.({
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
        });
        resolvers.set(prompt as string, () => resolve({
          responseText: `${prompt}-RESULT`,
          session: { dispose: vi.fn() },
          aborted: false,
          steered: false,
        }));
      }) as any,
  );
  return resolvers;
}

function callForeground(tools: Map<string, any>, prompt: string) {
  return tools.get("Agent").execute(
    `tc-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: false },
    undefined,
    undefined,
    ctx(),
  );
}

// ctrl+b, legacy raw-control-character encoding ('b'.charCodeAt(0) & 0x1f).
const CTRL_B = "\x02";
// ctrl+g, used to prove a custom `background-shortcut` value is actually read.
const CTRL_G = "\x07";

describe("ctrl+b background-shortcut, through the REAL extension", () => {
  it("does not consume the key when nothing is blocking", async () => {
    const { lifecycle } = await boot();
    const { ui, send } = captureUI();
    await lifecycle.get("session_start")?.({}, { ...ctx(), hasUI: true, ui });

    expect(send(CTRL_B)).toBeUndefined();
  });

  it("converts a blocking Agent call to background and returns immediately", async () => {
    const { pi, tools, lifecycle } = await boot();
    const resolvers = controllableRuns();
    const { ui, send } = captureUI();
    await lifecycle.get("session_start")?.({}, { ...ctx(), hasUI: true, ui });

    const call = callForeground(tools, "alpha");
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);

    expect(send(CTRL_B)).toEqual({ consume: true });

    const result = await call;
    expect(textOf(result)).toContain("moved to background");
    expect(textOf(result)).toMatch(/Agent ID: \S+/);
    const agentId = /Agent ID: (\S+)/.exec(textOf(result))![1];

    // The run itself is untouched — finishing it now still delivers a normal
    // background completion notification the caller never got inline.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    resolvers.get("alpha")!();
    await new Promise(r => setTimeout(r, 350));
    expect(pi.sendMessage).toHaveBeenCalled();
    expect(JSON.stringify(pi.sendMessage.mock.calls)).toContain(agentId);
  });

  it("falls through untouched for an unrelated key", async () => {
    const { tools, lifecycle } = await boot();
    controllableRuns();
    const { ui, send } = captureUI();
    await lifecycle.get("session_start")?.({}, { ...ctx(), hasUI: true, ui });

    void callForeground(tools, "alpha");
    await flush();

    expect(send("q")).toBeUndefined();
  });

  it("reads a custom background-shortcut key from settings", async () => {
    const { tools, lifecycle } = await boot({ backgroundShortcut: "ctrl+g" });
    controllableRuns();
    const { ui, send } = captureUI();
    await lifecycle.get("session_start")?.({}, { ...ctx(), hasUI: true, ui });

    const call = callForeground(tools, "alpha");
    await flush();

    expect(send(CTRL_B)).toBeUndefined(); // no longer the configured key
    expect(send(CTRL_G)).toEqual({ consume: true });

    expect(textOf(await call)).toContain("moved to background");
  });

  it("falls back to the default when the configured value is unparseable", async () => {
    const { tools, lifecycle } = await boot({ backgroundShortcut: "not a key" });
    controllableRuns();
    const { ui, send } = captureUI();
    await lifecycle.get("session_start")?.({}, { ...ctx(), hasUI: true, ui });

    const call = callForeground(tools, "alpha");
    await flush();

    expect(send(CTRL_B)).toEqual({ consume: true });
    expect(textOf(await call)).toContain("moved to background");
  });
});
