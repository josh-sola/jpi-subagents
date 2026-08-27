/**
 * detach-blocking.test.ts — `AgentManager.detachBlocking` (ctrl+b): converts a
 * blocking `spawnAndWait` caller into a released one mid-run, without touching
 * the run itself.
 *
 * Modeled on foreground-concurrency.test.ts's harness (mocked `runAgent`,
 * `fg`/`bg`/`recordFor` helpers) since this is the same pool the queued-detach
 * cases exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;

/** Runs that settle only when their returned resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
    new Promise<any>(resolve => {
      resolvers.set(prompt as string, () => resolve({
        responseText: `${prompt}-result`,
        session: mockSession(),
        aborted: false,
        steered: false,
      }));
    }),
  );
  return resolvers;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const fg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawnAndWait(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    ...options,
  });

const recordFor = (manager: AgentManager, prompt: string) =>
  manager.listAgents().find(a => a.description === prompt)!;

describe("AgentManager.detachBlocking", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  afterEach(() => manager?.dispose());

  it("resolves a RUNNING blocking wait early, flips blocking/isBackground, and leaves the run alive", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();

    const waiter = fg(manager, "a");
    const record = recordFor(manager, "a");
    expect(record.status).toBe("running");
    expect(record.blocking).toBe(true);

    expect(manager.detachBlocking(record.id)).toBe(true);

    const result = await waiter;
    expect(result.detached).toBe(true);
    expect(result.record.id).toBe(record.id);
    expect(record.blocking).toBe(false);
    expect(record.isBackground).toBe(true);
    // The run itself is untouched — still running, its promise unresolved.
    expect(record.status).toBe("running");

    resolvers.get("a")!();
    await flush();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("a-result");
  });

  it("resolves a QUEUED blocking wait early, and the agent still starts normally once its slot frees", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "holder");
    const waiter = fg(manager, "victim");
    const record = recordFor(manager, "victim");
    expect(record.status).toBe("queued");

    expect(manager.detachBlocking(record.id)).toBe(true);
    const result = await waiter;
    expect(result.detached).toBe(true);
    expect(record.blocking).toBe(false);
    expect(record.isBackground).toBe(true);
    // Still queued — detaching the WAITER doesn't cut the line.
    expect(record.status).toBe("queued");

    resolvers.get("holder")!();
    await flush();
    expect(record.status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(2);

    resolvers.get("victim")!();
    await flush();
    expect(record.status).toBe("completed");
  });

  it("a later tool-signal abort does not kill an agent detached while RUNNING", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    const controller = new AbortController();

    const waiter = fg(manager, "a", { signal: controller.signal });
    const record = recordFor(manager, "a");
    manager.detachBlocking(record.id);
    await waiter;

    controller.abort();
    expect(record.status).toBe("running");

    resolvers.get("a")!();
    await flush();
    expect(record.status).toBe("completed");
  });

  // The sharper case: a queued detach must also disarm the SEPARATE listener
  // `armQueuedAbort` wires while queued (startAgent's own listener never gets
  // a chance to run until the agent actually starts) — otherwise the agent
  // dies the moment it leaves the queue and the caller's old signal fires.
  it("a later tool-signal abort does not kill an agent detached while QUEUED, once it starts running", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);
    const controller = new AbortController();

    void fg(manager, "holder");
    const waiter = fg(manager, "victim", { signal: controller.signal });
    const record = recordFor(manager, "victim");
    expect(record.status).toBe("queued");

    manager.detachBlocking(record.id);
    await waiter;

    resolvers.get("holder")!();
    await flush();
    expect(record.status).toBe("running");

    controller.abort();
    expect(record.status).toBe("running");

    resolvers.get("victim")!();
    await flush();
    expect(record.status).toBe("completed");
  });

  // `armQueuedAbort` (queued) and `startAgent` (running) each wire their OWN
  // listener on the same signal. Detaching while still queued exercises only
  // the first; this pins the case where the agent has already left the queue
  // and started before ctrl+b fires, which must strip both.
  it("a later tool-signal abort does not kill an agent that started running BEFORE it was detached", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);
    const controller = new AbortController();

    void fg(manager, "holder");
    const waiter = fg(manager, "victim", { signal: controller.signal });
    const record = recordFor(manager, "victim");
    expect(record.status).toBe("queued");

    resolvers.get("holder")!();
    await flush();
    expect(record.status).toBe("running");

    manager.detachBlocking(record.id);
    await waiter;

    controller.abort();
    expect(record.status).toBe("running");

    resolvers.get("victim")!();
    await flush();
    expect(record.status).toBe("completed");
  });

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.detachBlocking("nope")).toBe(false);
  });

  it("returns false once the wait has already settled", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();

    const waiter = fg(manager, "a");
    const record = recordFor(manager, "a");
    resolvers.get("a")!();
    await waiter;

    expect(manager.detachBlocking(record.id)).toBe(false);
  });

  it("returns false for a background (non-blocking) spawn", () => {
    controllableRuns();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "bg", {
      description: "bg",
      isBackground: true,
    });
    expect(manager.detachBlocking(id)).toBe(false);
  });

  it("listBlockingAgents lists only top-level records with a live blocking wait", async () => {
    controllableRuns();
    manager = new AgentManager();

    void fg(manager, "parent");
    const parent = recordFor(manager, "parent");
    void fg(manager, "child", { parentAgentId: parent.id, depth: 2 });

    const blocking = manager.listBlockingAgents();
    expect(blocking.map(r => r.id)).toEqual([parent.id]);
  });

  it("listBlockingAgents excludes a background spawn even though isBackground/blocking never applied", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "general-purpose", "bg", { description: "bg", isBackground: true });
    expect(manager.listBlockingAgents()).toEqual([]);
  });
});
