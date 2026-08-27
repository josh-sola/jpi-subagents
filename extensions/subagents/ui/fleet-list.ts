/**
 * fleet-list.ts — Claude Code-style "FleetView" list, normally rendered below
 * the editor.
 *
 * Shows `main` + each running/queued subagent, with nested children indented
 * under their parent, as a navigable list. Pressing ↓ (or ←) at an empty
 * prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): by default the list is a `belowEditor` widget (render-only).
 * When a consumer attaches (see `attachConsumer` — `fleet-footer-bridge.ts` hands one
 * to jpi-status so it can draw the rows below its own status footer instead), the
 * widget is torn down and every place that would otherwise register or refresh it
 * asks the consumer to re-render instead. ALL key handling goes through
 * `onTerminalInput`, which fires before the focused component and can consume its
 * keys. The focus gate therefore reads from the external consumer when attached,
 * or from the fallback widget's TUI, so dialogs receive their own navigation keys.
 * Unknown focus stays permissive so normal FleetView activation still works.
 */

import {
  Editor,
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, formatCost, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal surface a fleet render consumer (e.g. jpi-status's footer) needs. */
export interface FleetConsumer {
  requestRender(): void;
  /** Optional for compatibility with a consumer updated independently. */
  getFocusedComponent?(): unknown;
}

/** Narrow view of Pi's TUI focus API, with the legacy/private fallback. */
type FocusAwareTui = {
  getFocusedComponent?(): unknown;
  focusedComponent?: unknown;
};

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content:
      | undefined
      | ((
          tui: any,
          theme: Theme,
        ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: any,
      theme: Theme,
      keybindings: any,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type MainEntry = { kind: "main" };
/** `depth` is the row's visual nesting level: 0 for top-level and orphaned agents, 1+ for a shown descendant. */
type AgentEntry = { kind: "agent"; record: AgentRecord; depth: number };
type FleetEntry = MainEntry | AgentEntry;

/** One row of `orderAgentsAsTree`'s output. */
export interface AgentTreeEntry {
  record: AgentRecord;
  depth: number;
}

/**
 * Depth-first order: each top-level agent is followed immediately by its
 * visible descendants (each level sorted by `startedAt`), so a tree reads as
 * one column instead of a shuffle. `records` must already be the visibility-
 * filtered set — a record whose parent isn't in it (already lingered out, or
 * owned by something the fleet doesn't show) surfaces as an unindented
 * top-level row rather than being dropped.
 */
export function orderAgentsAsTree(records: readonly AgentRecord[]): AgentTreeEntry[] {
  const visibleIds = new Set(records.map((r) => r.id));
  const childrenByParent = new Map<string, AgentRecord[]>();
  const roots: AgentRecord[] = [];
  for (const record of records) {
    const parentId = record.parentAgentId;
    if (parentId !== undefined && visibleIds.has(parentId)) {
      const siblings = childrenByParent.get(parentId);
      if (siblings) siblings.push(record);
      else childrenByParent.set(parentId, [record]);
    } else {
      roots.push(record);
    }
  }
  roots.sort((a, b) => a.startedAt - b.startedAt);
  for (const siblings of childrenByParent.values())
    siblings.sort((a, b) => a.startedAt - b.startedAt);

  const entries: AgentTreeEntry[] = [];
  const visit = (record: AgentRecord, depth: number) => {
    entries.push({ record, depth });
    for (const child of childrenByParent.get(record.id) ?? []) visit(child, depth + 1);
  };
  for (const record of roots) visit(record, 0);
  return entries;
}

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Set once a consumer attaches; `update()` refreshes it instead of the widget. */
  private consumer: FleetConsumer | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Hand rendering to an external consumer (jpi-status's footer) instead of the
   * `belowEditor` widget. Tears the widget down immediately, and `update()` calls
   * `consumer.requestRender()` from then on. The consumer may also expose its
   * TUI's focused component so the global input listener does not intercept a
   * dialog's keys after the local widget TUI is released. Last attach wins; the
   * returned detach only clears the consumer if it is still the current one, and
   * the next `update()` restores the widget fallback.
   */
  attachConsumer(consumer: FleetConsumer): () => void {
    this.consumer = consumer;
    if (this.ui && this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    return () => {
      if (this.consumer !== consumer) return;
      this.consumer = undefined;
      this.update();
    };
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) {
      this.viewerClose();
      this.viewerClose = undefined;
    }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    this.consumer = undefined;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /**
   * Re-render for whichever surface owns the fleet rows right now: an attached
   * consumer, or (the default) the below-editor widget — registered/refreshed,
   * or cleared when nothing remains.
   */
  update(): void {
    if (!this.ui) return;
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && this.roster().length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.active = false;
      this.selectedIndex = 0;
      this.consumer?.requestRender();
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (this.consumer) {
      this.consumer.requestRender();
      return;
    }

    if (!this.widgetRegistered) {
      this.ui.setWidget(
        FLEET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (w: number) => this.renderBar(w, theme),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  /**
   * Render the fleet rows for an external consumer — the same output
   * `renderBar` gives the `belowEditor` widget, including the activation hint
   * and selection markers. Empty when the fleet view is off or has no rows.
   */
  renderForConsumer(width: number, theme: Theme): string[] {
    if (!this.enabled) return [];
    return this.renderBar(width, theme);
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, as a depth-first tree: each agent immediately
   * followed by its visible nested children (see `orderAgentsAsTree`). Every
   * row is openable (has a session), so Enter never dead-ends. Included:
   * running/queued, plus the agent currently being viewed, plus
   * recently-finished ones (they linger briefly before dropping out). Pending
   * agents with no session yet are hidden until they start.
   */
  private agentRecords(): AgentTreeEntry[] {
    const now = Date.now();
    const visible = this.manager
      .listAgents()
      .filter(
        (a) =>
          a.session &&
          (a.status === "running" ||
            a.status === "queued" ||
            a.id === this.viewingAgentId ||
            (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)),
      );
    return orderAgentsAsTree(visible);
  }

  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.agentRecords().map(({ record, depth }) => ({
        kind: "agent" as const,
        record,
        depth,
      })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose) return undefined;
    // Global input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. Focus may
    // come from the external footer consumer or the fallback widget TUI; either
    // way, stay out of another component's keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) {
        this.deactivate();
        return { consume: true };
      }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) {
      this.openSelected();
      return { consume: true };
    }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check.
   *
   * An attached consumer owns the live TUI after the fallback widget is removed,
   * so its focus accessor must win. Otherwise use Pi's public
   * `getFocusedComponent()` on the widget TUI, with `focusedComponent` retained
   * only as a fallback for older/test TUI shapes. Unknowable focus counts as the
   * editor so activation still works before either render path has supplied one.
   */
  private editorHasFocus(): boolean {
    const tui = this.tui as FocusAwareTui | undefined;
    const focused =
      this.consumer?.getFocusedComponent?.() ??
      tui?.getFocusedComponent?.() ??
      tui?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui
      .custom<undefined>(
        (tui, theme, keybindings, done) => {
          this.viewerClose = () => done(undefined);
          return new ConversationViewer(
            tui,
            session,
            record,
            activity,
            theme,
            done,
            () => {
              if (this.manager.abort(record.id))
                this.ui?.notify(`Stopped "${record.description}".`, "info");
            },
            keybindings,
            (message: string) => this.manager.steer(record.id, message),
            this.showCost(),
            this.viewerMarkdown,
            this.onViewerMarkdown,
          );
        },
        {
          overlay: true,
          // Full-screen: the view should read as a swap to the agent's
          // conversation, not a floating box over the fleet list.
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
          },
        },
      )
      .then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex((e) => e.kind === "agent" && e.record.id === viewed);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as AgentEntry[];
    if (rows.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(this.renderAgentRow(a + 1, sel, row.record, width, theme, row.depth));
    }
    if (hiddenBelow > 0)
      lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  private renderAgentRow(
    rosterIndex: number,
    sel: number,
    record: AgentRecord,
    width: number,
    theme: Theme,
    depth = 0,
  ): string {
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentName(
      record.type,
      theme,
      selected
        ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
        : { fallbackColor: "muted" },
    );
    const description = selected ? theme.fg("text", record.description) : record.description;
    const prefix = depth > 0 ? `${"  ".repeat(depth)}${theme.fg("dim", "└─")} ` : "";
    const left = `  ${prefix}${this.bullet(rosterIndex, sel, theme)} ${name}  ${description}`;
    // The record, not the activity tracker — see the note in AgentWidget's
    // running line: only the record carries a nested child's spend, and only it
    // outlives the agent.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
