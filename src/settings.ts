// Persistence for pi-subagents operational settings: the `subagents { }`
// section of the shared `<agentDir>/jpi.kdl` (jpi-base's `Config`). No project
// tier — `.pi/subagents.json` and `<agentDir>/subagents.json` are dead.

import { Config, j } from "jpi-base";
import { NO_FALLBACK } from "./agent-types.js";
import type { AgentMentionMode, JoinMode, ViewerMarkdownMode, WidgetMode } from "./types.js";

export type ToolDescriptionMode = "full" | "compact" | "custom";

const subagentsSchema = j.node({
  fields: {
    maxConcurrent: j.number().default(10).describe("max concurrent background agents"),
    /**
     * Max concurrent FOREGROUND (blocking) agents — `0` = unlimited, the default,
     * which preserves the behaviour that has always applied: nothing bounds
     * foreground work, and pi dispatches a message's tool calls through
     * `Promise.all`, so an unqualified fan-out of blocking `Agent` calls runs all
     * at once. Set it to bound that (#253 — on local models, parallel agents
     * thrash the prompt cache).
     */
    maxConcurrentForeground: j
      .number()
      .default(0)
      .describe("max concurrent foreground (blocking) agents; 0 = unlimited"),
    /** 0 = unlimited — `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`. */
    defaultMaxTurns: j.number().default(0).describe("default max turns before wrap-up; 0 = unlimited"),
    graceTurns: j.number().default(5).describe("grace turns after wrap-up steer"),
    defaultJoinMode: j
      .union(j.literal("async"), j.literal("group"), j.literal("smart"))
      .default("smart")
      .describe("default join mode for background agents"),
    /**
     * Whether a top-level `Agent` spawn that doesn't say runs detached.
     * Defaults to `true`, following Claude Code. Top-level only — nested spawns
     * always default to foreground regardless (see nested-tools.ts).
     */
    backgroundByDefault: j
      .boolean()
      .default(true)
      .describe("an Agent call that doesn't say run_in_background runs detached"),
    /**
     * When true, the effective model of each subagent spawn is validated
     * against `enabledModels` from pi's settings. No-op when pi's
     * `enabledModels` is empty or absent. Defaults to false.
     */
    scopeModels: j
      .boolean()
      .default(false)
      .describe("validate subagent models against pi's enabledModels"),
    /**
     * When true, an unreadable or unparseable agent `.md` aborts extension load
     * instead of being skipped with a warning. Startup only.
     */
    strictAgentFiles: j
      .boolean()
      .default(false)
      .describe("abort extension load on a broken agent file instead of skipping it with a warning"),
    disableDefaultAgents: j
      .boolean()
      .default(false)
      .describe("skip registering the built-in default agents (general-purpose, Explore, Plan)"),
    /**
     * Which Agent tool description the LLM sees. Read once at tool
     * registration — changing it applies on the next pi session.
     */
    toolDescriptionMode: j
      .union(j.literal("full"), j.literal("compact"), j.literal("custom"))
      .default("full")
      .describe("Agent tool description sent to the LLM: full, compact, or custom"),
    fleetView: j
      .boolean()
      .default(true)
      .describe("show the Claude Code-style fleet list below the editor"),
    /**
     * Whether `@handle message` typed at the prompt is routed to that subagent.
     * `model`: a main-model turn spawns it via the Agent tool. `direct`: started
     * here instead, no main-model turn spent. `off`: mentions are inert. The
     * booleans this setting used to take are still accepted — `#true` as
     * `model`, `#false` as `off` (see applySettings).
     */
    agentMentions: j
      .union(j.literal("model"), j.literal("direct"), j.literal("off"), j.boolean())
      .default("model")
      .describe("route `@handle message` at the prompt to that subagent: model, direct, or off"),
    rememberAgents: j
      .boolean()
      .default(true)
      .describe("persist subagent sessions by default, so @handle can resume one after it finishes"),
    widgetMode: j
      .union(j.literal("all"), j.literal("background"), j.literal("off"))
      .default("background")
      .describe("above-editor agent widget: all, background (hide foreground), or off"),
    outputTranscript: j
      .boolean()
      .default(true)
      .describe("write each subagent's .output transcript by default"),
    worktreeIsolation: j
      .boolean()
      .default(true)
      .describe("allow isolation: worktree to create a git worktree"),
    /**
     * Hard ceiling on nested subagent delegation, counted from the main
     * session: main = 0, its subagents = 1, their children = 2.
     */
    maxSubagentDepth: j
      .number()
      .default(2)
      .describe("hard cap on nested subagent delegation depth; 0 or 1 disables nesting"),
    /**
     * Agent type substituted when a caller-supplied `subagent_type` doesn't
     * resolve to exactly one enabled agent. `false` disables the fallback so
     * dispatch fails closed (mapped to the internal NO_FALLBACK sentinel).
     */
    fallbackSubagent: j
      .union(j.string(), j.literal(false))
      .default("general-purpose")
      .describe("agent type substituted when subagent_type is unknown, disabled, or ambiguous; #false rejects the call instead"),
    reportUsage: j
      .boolean()
      .default(false)
      .describe("add subagent tokens and cost to this session's own totals"),
    showCost: j
      .boolean()
      .default(false)
      .describe("show an estimated dollar cost beside subagent token counts"),
    showModel: j
      .boolean()
      .default(false)
      .describe("name the model and thinking level on the widget's running rows"),
    viewerMarkdown: j
      .union(j.literal("off"), j.literal("assistant"), j.literal("all"))
      .default("assistant")
      .describe("how much of the conversation viewer's transcript renders as Markdown"),
  },
});

export type SubagentsSchema = typeof subagentsSchema;

export function createSubagentsConfig(
  env?: NodeJS.ProcessEnv,
  homeDirectory?: string,
): Config<SubagentsSchema> {
  return new Config("subagents", subagentsSchema, env, homeDirectory);
}

export type SubagentsSettings = j.infer<SubagentsSchema>;

export interface LoadedSubagentsSettings {
  readonly value: SubagentsSettings;
  readonly path: string;
  readonly issues: string[];
}

/** `config.load()`, carrying the config's file path alongside the result — the shape jpi-sidebar's config.ts returns. */
export async function loadSubagentsSettings(
  config: Config<SubagentsSchema>,
): Promise<LoadedSubagentsSettings> {
  const { value, issues } = await config.load();
  return { value, path: config.path, issues };
}

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setMaxConcurrentForeground: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setBackgroundByDefault: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setFallbackSubagent: (v: string) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
  setShowModel: (b: boolean) => void;
  setViewerMarkdown: (mode: ViewerMarkdownMode) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

/** Apply loaded settings to in-memory state via caller-supplied setters. Every field is always present. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  appliers.setMaxConcurrent(s.maxConcurrent);
  appliers.setMaxConcurrentForeground(s.maxConcurrentForeground);
  appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  appliers.setGraceTurns(s.graceTurns);
  appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  // The only non-string spelling: `false` is the KDL way to spell strict
  // dispatch (`fallback-subagent #false`) — mapped to the sentinel the
  // resolver checks for, matching every other agent-name comparison.
  appliers.setFallbackSubagent(s.fallbackSubagent === false ? NO_FALLBACK : s.fallbackSubagent);
  appliers.setDefaultJoinMode(s.defaultJoinMode);
  appliers.setBackgroundByDefault(s.backgroundByDefault);
  appliers.setScopeModels(s.scopeModels);
  appliers.setStrictAgentFiles(s.strictAgentFiles);
  appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  appliers.setToolDescriptionMode(s.toolDescriptionMode);
  appliers.setFleetView(s.fleetView);
  // The booleans this setting used to take are still accepted in the KDL —
  // `#true` reads as `model`, `#false` as `off`.
  appliers.setAgentMentions(
    typeof s.agentMentions === "boolean" ? (s.agentMentions ? "model" : "off") : s.agentMentions,
  );
  appliers.setRememberAgents(s.rememberAgents);
  appliers.setWidgetMode(s.widgetMode);
  appliers.setOutputTranscript(s.outputTranscript);
  appliers.setWorktreeIsolation(s.worktreeIsolation);
  appliers.setReportUsage(s.reportUsage);
  appliers.setShowCost(s.showCost);
  appliers.setShowModel(s.showModel);
  appliers.setViewerMarkdown(s.viewerMarkdown);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of a save into the right message + level so the
 * UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  issues: readonly string[],
): { message: string; level: "info" | "warning" } {
  return issues.length === 0
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist: ${issues.join("; ")})`, level: "warning" };
}

/**
 * Load settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init awaits this once.
 */
export async function applyAndEmitLoaded(
  config: Config<SubagentsSchema>,
  appliers: SettingsAppliers,
  emit: SettingsEmit,
): Promise<LoadedSubagentsSettings> {
  const loaded = await loadSubagentsSettings(config);
  applySettings(loaded.value, appliers);
  emit("subagents:settings_loaded", { settings: loaded.value });
  return loaded;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the
 * `persisted` flag so listeners can react to write failures.
 */
export async function saveAndEmitChanged(
  config: Config<SubagentsSchema>,
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
): Promise<{ message: string; level: "info" | "warning" }> {
  const { issues } = await config.save(snapshot);
  emit("subagents:settings_changed", { settings: snapshot, persisted: issues.length === 0 });
  return persistToastFor(successMsg, issues);
}
