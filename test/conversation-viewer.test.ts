import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;
/**
 * Bumped per `new Markdown(...)`. Only observes the literal ("off") path's own
 * direct `Markdown` usage — pi-coding-agent ships its own nested copy of
 * pi-tui, so this mock never sees the `Markdown` instances pi's real
 * AssistantMessageComponent/UserMessageComponent build internally for the
 * enriched path. Those are asserted by spying on the component classes
 * themselves instead (see the "Markdown rendering" describe block).
 */
let markdownConstructions = 0;
/** Forces the (literal-path-visible) Markdown component to throw. */
let markdownThrows = false;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        markdownConstructions++;
        super(...args);
      }
      render(width: number): string[] {
        // Real trigger is ~54 nested blockquotes overflowing pi-tui's recursive
        // renderer. Forced rather than reproduced: a real overflow costs ~2.4s
        // and its depth depends on the platform's stack limit, so reproducing it
        // makes the test both slow and liable to stop triggering silently.
        if (markdownThrows) throw new RangeError("Maximum call stack size exceeded");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { AssistantMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
const { ConversationViewer, RESULT_MAX_CHARS } = await import("../src/ui/conversation-viewer.js");

// The enriched transcript reuses pi's own chat components, which read colors
// off pi's global theme singleton — real only once initTheme() has run, which
// a live pi process always does before any extension can render (see main.js).
// Tests stand in for that with the default (env-detected) theme.
initTheme();

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    sessionManager: { getCwd: () => "/tmp/test-cwd" },
    extensionRunner: { getMarkdownTransformers: () => [], getMessageRenderer: () => undefined },
    getToolDefinition: () => undefined,
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
  markdownConstructions = 0;
  markdownThrows = false;
});

describe("ConversationViewer invocation line", () => {
  /** The `↳` metadata row for a record, or "" when the viewer renders none. */
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    // The row arrives inside the overlay's frame, padded out to the right
    // border; what is under test is the metadata it carries.
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  // The canonical id, not the short label the widget uses: this overlay is
  // opened to inspect one agent and has the width to disambiguate providers.
  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      requestedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (asked google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }, { type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", id: "t1", name: "very_long_tool_name_" + "x".repeat(200), arguments: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Markdown rendering", () => {
    /** ANSI stripped, so an assertion is about the text and not the styling. */
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    function viewerFor(
      messages: any[],
      mode?: "off" | "assistant" | "all",
      onMode?: (m: any) => void,
      /** Tall enough that the assertion reads the whole transcript, not the scrolled window. */
      rows = 200,
    ) {
      return new ConversationViewer(
        mockTui(rows, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(), undefined, undefined, undefined, false,
        mode ? () => mode : undefined, onMode,
      );
    }

    const assistant = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    /** A standalone result, with no call to pair it to — only meaningful on the literal ("off") path. */
    const result = (text: string) => [{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text }] }];
    /** A resolved tool call — the shape a real transcript always has (a call is always followed by its result). */
    const toolPair = (text: string, id = "t1") => [
      { role: "assistant", content: [{ type: "toolCall", id, name: "ctx_execute", arguments: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: id, toolName: "ctx_execute", content: [{ type: "text", text }], isError: false },
    ];

    it("renders assistant Markdown by default instead of raw source markers", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n- first\n- second\n\n**bold**")).render(80).join("\n"));

      expect(out).toContain("Heading");
      expect(out).not.toContain("# Heading");
      expect(out).not.toContain("**bold**");
      expect(out).toContain("bold");
    });

    it("leaves assistant text verbatim under `off`", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n**bold**"), "off").render(80).join("\n"));

      expect(out).toContain("# Heading");
      expect(out).toContain("**bold**");
    });

    it("leaves tool results byte-exact under `off`", () => {
      const raw = [
        "#!/bin/sh",
        "# section",
        "3) alpha",
        "7) beta",
        "9) gamma",
        "Section",
        "---",
        "next",
      ].join("\n");
      const out = strip(viewerFor(result(raw), "off").render(80).join("\n"));

      for (const line of raw.split("\n")) expect(out).toContain(line);
    });

    // A generic tool (no built-in or extension-registered renderer) falls back
    // to pi's own literal preview — unlike assistant/user text, there is no
    // Markdown pass over tool output at any markdown mode. `3) a / 7) b` would
    // renumber to `4. b` under a Markdown pass; its survival here is the tell.
    it("never rewrites a generic tool's result, in any markdown mode", () => {
      for (const mode of ["assistant", "all"] as const) {
        const out = strip(viewerFor(toolPair("## ctx_execute\n\n3) alpha\n7) beta"), mode).render(80).join("\n"));

        expect(out).toContain("## ctx_execute");
        expect(out).toContain("3) alpha");
        expect(out).not.toContain("4. beta");
      }
    });

    it("fills in the abort error for a tool box built while the turn was still streaming", () => {
      // The viewer can be open while an agent runs: the box is built pending
      // (stopReason unset), then the same assistant message object gets its
      // stopReason set once the turn settles — e.g. via the viewer's own stop
      // key — with no toolResult message ever following it.
      const msg: any = {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "ctx_execute", arguments: {} }],
      };
      const viewer = viewerFor([msg]);
      const before = strip(viewer.render(80).join("\n"));
      expect(before).not.toContain("Operation aborted");

      msg.stopReason = "aborted";
      const after = strip(viewer.render(80).join("\n"));

      expect(after).toContain("Operation aborted");
    });

    it("`m` cycles the mode, persists it, and shows it in the footer", () => {
      const onMode = vi.fn();
      const viewer = viewerFor(assistant("# Heading"), "assistant", onMode);

      expect(strip(viewer.render(80).join("\n"))).toContain("m md");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("all");
      expect(strip(viewer.render(80).join("\n"))).toContain("m md+");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("off");
      const off = strip(viewer.render(80).join("\n"));
      expect(off).toContain("m raw");
      // The override, not just the label, is what took effect.
      expect(off).toContain("# Heading");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("assistant");
    });

    it("`m` still cycles when no persist hook is wired", () => {
      const viewer = viewerFor(assistant("# Heading"), "assistant");
      viewer.handleInput("m");
      viewer.handleInput("m");

      expect(strip(viewer.render(80).join("\n"))).toContain("# Heading");
    });

    it("`m` disarms a pending stop rather than confirming it", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");
      viewer.handleInput("m");
      viewer.handleInput("x");

      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps the footer's navigation hints intact at 80 columns", () => {
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
      );
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);

      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("m md");
      expect(footer).toContain("Esc close");
    });

    // These next several are `off`-mode ("raw") tests: RESULT_MAX_CHARS/capResult
    // is the literal path's own bound, unrelated to the enriched-mode preview
    // pi's ToolExecutionComponent applies below.
    it("caps a tool result at RESULT_MAX_CHARS, not 500, and says what it dropped", () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const out = strip(viewerFor(result(lines.join("\n")), "off", undefined, 4000).render(80).join("\n"));

      expect(out).toContain("line 100");                       // far past the old 500-char cut
      expect(out).not.toContain("line 2999");                  // but still bounded
      expect(out).toMatch(/\.\.\. \(truncated, \d+ more lines\)/);
    });

    it("puts the truncation notice outside the code fence it cut into", () => {
      const text = `\`\`\`js\n${"const a = 1;\n".repeat(2000)}\`\`\``;
      const viewer = viewerFor(result(text), "off", undefined, 4000);
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);
      const note = content.find(l => l.includes("... (truncated"));

      // Appended into the content it lands inside the unterminated fence, where
      // it picks up the code-block indent and reads as a line of the tool's source.
      expect(note).toMatch(/^\.\.\. \(truncated, \d+ more lines\)$/);
    });

    it("falls back to the literal transcript when a chat component's render throws", () => {
      // render() is on the TUI's critical path, so a throw inside pi's own
      // AssistantMessageComponent — which has no guard of its own, and whose
      // internal Markdown instance the top-level pi-tui mock above can't reach
      // (pi-coding-agent ships its own nested copy) — must still not take the
      // overlay down. Spying on the component directly stands in for the real
      // trigger: ~54 nested blockquotes overflowing pi-tui's recursive
      // renderer, too slow and platform-dependent to reproduce here.
      const viewer = viewerFor(assistant("# heading"), "all");
      const renderSpy = vi.spyOn(AssistantMessageComponent.prototype, "render").mockImplementation(() => {
        throw new RangeError("Maximum call stack size exceeded");
      });

      expect(() => viewer.render(80)).not.toThrow();
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");

      // No per-message memory: the whole transcript recovers to enriched
      // rendering as soon as the component stops throwing.
      renderSpy.mockRestore();
      expect(strip(viewer.render(80).join("\n"))).not.toContain("# heading");
    });

    it("tracks a tool result that keeps growing past the cap", () => {
      // The live case: the capped prefix never changes, so the parse is reused,
      // but the count of what is being held back has to keep moving. Only true
      // on the literal path — a real toolResult never grows in place once a
      // paired call resolves it (see the enriched-path caching tests below).
      const msg = { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: `${"row\n".repeat(4500)}` }] };
      const viewer = viewerFor([msg], "off");
      const elided = () => Number(
        strip(((viewer as any).buildContentLines(76) as string[]).join("\n"))
          .match(/truncated, (\d+) more/)?.[1],
      );

      const before = elided();
      msg.content[0].text += "row\n".repeat(1000);
      const after = elided();

      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(before);
      expect(markdownConstructions).toBe(0); // the literal path never touches Markdown
    });

    it("leaves a result under the cap untouched", () => {
      // Deliberately between the old 500-char cap and the new one, so the test
      // discriminates the cap's value and not merely its existence.
      const text = `head\n${"filler line\n".repeat(200)}tail`;
      const out = strip(viewerFor(result(text), "off", undefined, 600).render(80).join("\n"));

      expect(text.length).toBeLessThan(RESULT_MAX_CHARS);
      expect(out).toContain("head");
      expect(out).toContain("tail");
      expect(out).not.toContain("truncated");
    });

    it("caps bash output with the same rule as a tool result", () => {
      const messages = [{ role: "bashExecution", command: "yes", output: "y\n".repeat(20000) }];
      const out = strip(viewerFor(messages, "off").render(80).join("\n"));

      expect(out).toMatch(/\.\.\. \(truncated, \d+ more lines\)/);
    });

    it("keeps tool results dim on the literal path", () => {
      // Reads the content line directly: every bordered row carries the theme's
      // escape on its `│`, so asserting on rendered output would pass either way.
      const viewer = viewerFor(result("plain result text"), "off");
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("reuses one assistant block per message across renders", () => {
      // The cache is keyed by message object identity: a re-render that finds
      // the same object with the same text reuses the built component instead
      // of calling back into pi's AssistantMessageComponent to reparse it.
      // updateContent() is what does that (re)parsing, including the one call
      // baked into the constructor — so counting its calls stands in for
      // counting parses, the way the removed markdownConstructions counter did
      // before the enriched path stopped constructing Markdown directly.
      const updateSpy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
      const viewer = viewerFor(assistant("# Heading"));
      viewer.render(80);
      const afterFirst = updateSpy.mock.calls.length;
      viewer.render(80);
      viewer.render(80);

      expect(afterFirst).toBe(1); // built once, from construction
      expect(updateSpy.mock.calls.length).toBe(afterFirst); // unchanged text isn't reparsed
      updateSpy.mockRestore();
    });

    it("re-renders a message whose text is still streaming", () => {
      const updateSpy = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
      const messages = assistant("# One");
      const viewer = viewerFor(messages);
      expect(strip(viewer.render(80).join("\n"))).toContain("One");
      const afterFirst = updateSpy.mock.calls.length;

      messages[0].content[0].text = "# Two";
      const out = strip(viewer.render(80).join("\n"));

      expect(out).toContain("Two");
      expect(out).not.toContain("One");
      // Growth on the same message object is picked up: the cache's stored
      // text no longer matches, so updateContent() runs again.
      expect(updateSpy.mock.calls.length).toBeGreaterThan(afterFirst);
      updateSpy.mockRestore();
    });

    it("renders Markdown to fit, so the overwidth clamp never has to cut it", () => {
      const text = `# ${"Heading ".repeat(20)}\n\n| a | b |\n|---|---|\n| ${"x".repeat(90)} | 2 |\n\n\`\`\`js\nconst x = ${"1".repeat(120)};\n\`\`\``;
      // From 20 up: below that the `[Assistant]` role label is itself wider than
      // the viewport, so the clamp legitimately fires on chrome rather than content.
      // Narrower widths stay covered by the wrapTextWithAnsi safety net above.
      for (const w of [20, 40, 80, 120]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(assistant(text)), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        const content = (viewer as any).buildContentLines(w) as string[];

        assertAllLinesFit(content, w);
        // `truncateToWidth` is the #7 backstop, not what keeps these in bounds —
        // if it fires on Markdown output, content is being silently cut.
        expect(content.filter(l => strip(l).endsWith("..."))).toEqual([]);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "tool", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});
