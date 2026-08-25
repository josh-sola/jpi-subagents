/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  type TruncationResult,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Input, type MarkdownTheme, matchesKey, Spacer, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/**
 * Height ceiling shared by the overlay's `maxHeight` and the viewer's internal
 * viewport cap. 100 makes the overlay a full-screen swap rather than a
 * floating box — see fleet-list.ts's `openSelected()`.
 */
export const VIEWPORT_HEIGHT_PCT = 100;

/**
 * Cap on a single tool result or bash output before the literal path elides
 * the rest. (The enriched path has no equivalent cap — pi's own
 * ToolExecutionComponent previews instead of dumping the whole result; see
 * `buildEnrichedLines`.)
 *
 * The cap is not cosmetic — it bounds render cost. `buildRawLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.slice(RESULT_MAX_CHARS).split("\n").length,
  };
}

function truncationNote(elided: number): string {
  return `... (truncated, ${elided} more line${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /**
   * Enriched pi chat components for message types that never mutate once
   * appended (user, bash, custom, compaction, branch summary) — one instance
   * per message object, built once and reused across renders and scroll keys.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly blockCache = new WeakMap<object, Component>();
  /**
   * Assistant blocks additionally track the text they were built from: the
   * last message keeps mutating in place while its turn streams in, so this
   * is how a re-render tells "settled" from "grew since last time".
   */
  private readonly assistantCache = new WeakMap<object, { component: AssistantMessageComponent; text: string }>();
  /**
   * Tool-call boxes, keyed by call id rather than in `blockCache`: one
   * assistant message can hold several, and the matching result — a later,
   * separate message — has to reach the same instance to fill it in.
   */
  private readonly toolCallComponents = new Map<string, ToolExecutionComponent>();
  /** Call ids whose result has already been applied, so a re-render doesn't rebuild the box's renderer on every scroll key. */
  private readonly appliedToolResults = new Set<string>();

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    lines.push(row(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
      // at 80 columns with steer + stop present, and this group has no
      // degradation step below "drop the line-count readout".
      actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;

    if (messages.length === 0) {
      return [th.fg("dim", "(waiting for first message...)")];
    }

    let lines: string[];
    if (this.markdownMode() === "off") {
      lines = this.buildRawLines(messages, width);
    } else {
      try {
        lines = this.buildEnrichedLines(messages, width);
      } catch {
        // pi's own chat components carry no equivalent guard — interactive-mode.js
        // constructs them the same way — but render() is on our critical path
        // too, so a parser throw (e.g. pathologically nested Markdown) degrades
        // to the literal transcript rather than taking the overlay down.
        lines = this.buildRawLines(messages, width);
      }
    }

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    return lines.map(l => truncateToWidth(l, width));
  }

  /** Literal fallback for markdown mode `off` — the escape hatch to unformatted source. */
  private buildRawLines(messages: AgentSession["messages"], width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") {
            toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
          }
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          const text = textParts.join("\n").trim();
          lines.push(...this.rawLines(text, width, false));
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === "toolResult") {
        const { text, elided } = capResult(extractText(msg.content).trim());
        if (!text) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        lines.push(...this.rawLines(text, width, true));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        if (bash.output?.trim()) {
          // Same cap as a tool result, never Markdown: command output is the one
          // thing here that is definitionally not authored as Markdown.
          const { text, elided } = capResult(bash.output.trim());
          lines.push(...this.rawLines(text, width, true));
          if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }
    return lines;
  }

  /**
   * Enriched transcript — reuses pi's own chat renderers (Markdown, diffs,
   * tool boxes) so an agent's transcript reads the same as pi's main chat.
   * Spacing between blocks mirrors pi's own `addMessageToChat`/
   * `renderSessionItems` (interactive-mode.js): some components pad
   * themselves, so only user/compaction/branch messages get an external
   * spacer here.
   *
   * Message objects are stable once appended — `session.messages` never
   * replaces one in place — so each block is built once and cached; only the
   * actively-streaming assistant message is re-checked, since its text keeps
   * growing on the same object.
   *
   * Tool/bash/custom output starts collapsed to a preview, matching pi's own
   * default (there is no expand keybinding wired here to un-collapse it).
   * Compaction and branch summaries are expanded outright — their text is
   * short, so a collapsed preview would hide everything useful.
   */
  private buildEnrichedLines(messages: AgentSession["messages"], width: number): string[] {
    const container = new Container();
    const cwd = this.session.sessionManager.getCwd();
    const transformers = this.session.extensionRunner.getMarkdownTransformers();
    const isRunning = this.record.status === "running";

    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text.trim()) continue;
        if (container.children.length > 0) container.addChild(new Spacer(1));
        let component = this.blockCache.get(msg);
        if (!component) {
          component = new UserMessageComponent(text, this.markdownTheme, 1, transformers);
          this.blockCache.set(msg, component);
        }
        container.addChild(component);
      } else if (msg.role === "assistant") {
        const text = msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        let entry = this.assistantCache.get(msg);
        if (!entry) {
          const component = new AssistantMessageComponent(msg, false, this.markdownTheme, undefined, 1, transformers);
          entry = { component, text };
          this.assistantCache.set(msg, entry);
        } else if (entry.text !== text) {
          entry.component.updateContent(msg, isRunning);
          entry.text = text;
        }
        container.addChild(entry.component);

        for (const content of msg.content) {
          if (content.type !== "toolCall") continue;
          let toolComponent = this.toolCallComponents.get(content.id);
          if (!toolComponent) {
            toolComponent = new ToolExecutionComponent(
              content.name,
              content.id,
              content.arguments,
              undefined,
              this.session.getToolDefinition(content.name),
              this.tui,
              cwd,
            );
            toolComponent.markExecutionStarted();
            toolComponent.setArgsComplete();
            this.toolCallComponents.set(content.id, toolComponent);
          }
          // The turn ended without a result (abort/error) — there is no later
          // toolResult message to pair this call with, so fill it in here
          // instead. Checked on every pass, not just at construction: the
          // message mutates in place as the turn streams, so a viewer open
          // while it is still running builds the box before stopReason is
          // set — the abort (e.g. the viewer's own stop key) can land after.
          if (!this.appliedToolResults.has(content.id) && (msg.stopReason === "aborted" || msg.stopReason === "error")) {
            const errorMessage = msg.stopReason === "aborted" ? "Operation aborted" : msg.errorMessage || "Error";
            toolComponent.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
            this.appliedToolResults.add(content.id);
          }
          container.addChild(toolComponent);
        }
      } else if (msg.role === "toolResult") {
        const toolComponent = this.toolCallComponents.get(msg.toolCallId);
        if (toolComponent && !this.appliedToolResults.has(msg.toolCallId)) {
          toolComponent.updateResult(msg);
          this.appliedToolResults.add(msg.toolCallId);
        }
      } else if (msg.role === "bashExecution") {
        let component = this.blockCache.get(msg);
        if (!component) {
          const bash = new BashExecutionComponent(msg.command, this.tui, msg.excludeFromContext);
          if (msg.output) bash.appendOutput(msg.output);
          // Only `.truncated` is read by the component's display logic; the rest
          // of TruncationResult's fields describe a truncation pass we never ran.
          const truncation = msg.truncated ? ({ truncated: true } as TruncationResult) : undefined;
          bash.setComplete(msg.exitCode, msg.cancelled, truncation, msg.fullOutputPath);
          component = bash;
          this.blockCache.set(msg, component);
        }
        container.addChild(component);
      } else if (msg.role === "custom") {
        if (!msg.display) continue;
        let component = this.blockCache.get(msg);
        if (!component) {
          const renderer = this.session.extensionRunner.getMessageRenderer(msg.customType);
          component = new CustomMessageComponent(msg, renderer, this.markdownTheme, 1);
          this.blockCache.set(msg, component);
        }
        container.addChild(component);
      } else if (msg.role === "compactionSummary") {
        container.addChild(new Spacer(1));
        let component = this.blockCache.get(msg);
        if (!component) {
          const summary = new CompactionSummaryMessageComponent(msg, this.markdownTheme);
          summary.setExpanded(true);
          component = summary;
          this.blockCache.set(msg, component);
        }
        container.addChild(component);
      } else if (msg.role === "branchSummary") {
        container.addChild(new Spacer(1));
        let component = this.blockCache.get(msg);
        if (!component) {
          const summary = new BranchSummaryMessageComponent(msg, this.markdownTheme);
          summary.setExpanded(true);
          component = summary;
          this.blockCache.set(msg, component);
        }
        container.addChild(component);
      }
    }

    return container.render(width);
  }
}
