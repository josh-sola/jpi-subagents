/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 *
 * The markdown-mode counters below only see the literal ("off") path's own
 * direct pi-tui usage — pi-coding-agent ships its own nested copy of pi-tui,
 * so the mock never sees the `Markdown` instances pi's real
 * AssistantMessageComponent builds internally for the enriched path. Those
 * paths spy on the component's `updateContent` instead, which is the one
 * operation that does real reparsing work (see the "markdown path" tests).
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/** Counters for the pi-tui leaves the viewer wraps its text with (literal path only — see header). */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../extensions/subagents/ui/agent-widget.js");
const { AssistantMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
const { ConversationViewer } = await import("../../extensions/subagents/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui } =
  await import("../helpers/perf-fixtures.js");

// The enriched path reuses pi's own chat components, which read colors off
// pi's global theme singleton — real only once initTheme() has run.
initTheme();

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — cost stays linear in transcript length", () => {
  /** Leaf calls one render makes over a transcript of `n` messages. */
  function wrapsFor(n: number, mode: string): number {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => mode);
    viewer.render(120); // prime, so caches are warm and only steady state counts
    counts.wrap = 0;
    counts.markdownRender = 0;
    viewer.render(120);
    return counts.wrap + counts.markdownRender;
  }

  // The viewer rebuilds every line of the transcript on every frame, so the work
  // is expected to grow with it. What must not happen is growing FASTER than it:
  // ten times the messages, at most ~ten times the work. A quadratic here is
  // invisible on a short conversation and locks the TUI on a long one.
  it("does ~10x the work for 10x the messages (raw wrap path)", () => {
    const small = wrapsFor(30, "off");
    const large = wrapsFor(300, "off");

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
  });

  // The enriched path's leaf isn't a top-level pi-tui call (see header) — it's
  // pi's AssistantMessageComponent building its Markdown, once per assistant
  // message, on the frame that first sees each one (priming). Same shape as
  // the raw-wrap check above: linear in the transcript, not quadratic.
  it("does ~10x the work for 10x the messages (markdown path)", () => {
    const updateSpy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const buildsFor = (n: number) => {
      updateSpy.mockClear();
      mountViewer(ConversationViewer, makeSession(n), undefined, () => "assistant").render(120);
      return updateSpy.mock.calls.length;
    };

    const small = buildsFor(30);
    const large = buildsFor(300);

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
    updateSpy.mockRestore();
  });

  // The cache is a WeakMap keyed by the message object. If a refactor ever
  // rebuilds messages, or keys the cache on something that changes per frame,
  // every frame re-parses the whole transcript. Nothing else in the suite
  // would notice.
  it("re-renders without re-parsing: the markdown cache survives a frame", () => {
    const updateSpy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const viewer = mountViewer(ConversationViewer, makeSession(60), undefined, () => "assistant");
    viewer.render(120);
    const afterFirst = updateSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    viewer.render(120);
    viewer.render(120);

    expect(updateSpy.mock.calls.length).toBe(afterFirst);
    updateSpy.mockRestore();
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(
      manager,
      makeActivity(records),
      () => "all",
      () => false,
      () => false,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_k: string, c: any) => {
        factory = c;
      },
    } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
