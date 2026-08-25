import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FALLBACK } from "../src/agent-types.js";
import {
  applyAndEmitLoaded,
  applySettings,
  createSubagentsConfig,
  loadSubagentsSettings,
  persistToastFor,
  type SettingsAppliers,
  type SubagentsSettings,
  saveAndEmitChanged,
} from "../src/settings.js";

/**
 * jpi-base's own suite covers the KDL codec (union round-trips,
 * malformed-value issues, atomic writes) — these tests cover what's specific
 * to pi-subagents: the schema's shape and defaults, and the wiring between a
 * loaded value and the in-memory setters.
 *
 * `homeDir` is passed as `Config`'s `homeDirectory` with an empty `env`, so
 * `getAgentDirectory` resolves to `<homeDir>/.pi/agent` without touching
 * `process.env.PI_CODING_AGENT_DIR`.
 */
describe("subagents settings (jpi.kdl)", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-settings-home-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  const newConfig = () => createSubagentsConfig({}, homeDir);
  const kdlPath = () => join(homeDir, ".pi", "agent", "jpi.kdl");

  it("creates the subagents section with every field defaulted on first load", async () => {
    const loaded = await loadSubagentsSettings(newConfig());
    expect(loaded.issues).toEqual([]);
    expect(loaded.value).toEqual({
      maxConcurrent: 10,
      maxConcurrentForeground: 0,
      defaultMaxTurns: 0,
      graceTurns: 5,
      defaultJoinMode: "smart",
      backgroundByDefault: true,
      schedulingEnabled: true,
      scopeModels: false,
      strictAgentFiles: false,
      disableDefaultAgents: false,
      toolDescriptionMode: "full",
      fleetView: true,
      agentMentions: "model",
      rememberAgents: true,
      widgetMode: "background",
      outputTranscript: true,
      worktreeIsolation: true,
      workflowsEnabled: "auto",
      maxSubagentDepth: 2,
      fallbackSubagent: "general-purpose",
      reportUsage: false,
      showCost: false,
      showModel: false,
      viewerMarkdown: "assistant",
    } satisfies SubagentsSettings);
    expect(existsSync(kdlPath())).toBe(true);
  });

  it("round-trips a partial save: changed fields persist, the rest stay default", async () => {
    const saveResult = await newConfig().save({ maxConcurrent: 4, schedulingEnabled: false });
    expect(saveResult.issues).toEqual([]);

    const loaded = await loadSubagentsSettings(newConfig());
    expect(loaded.value.maxConcurrent).toBe(4);
    expect(loaded.value.schedulingEnabled).toBe(false);
    expect(loaded.value.graceTurns).toBe(5);
  });

  it("round-trips fallbackSubagent's #false arm alongside a named agent", async () => {
    await newConfig().save({ fallbackSubagent: false });
    expect((await loadSubagentsSettings(newConfig())).value.fallbackSubagent).toBe(false);

    await newConfig().save({ fallbackSubagent: "scout" });
    expect((await loadSubagentsSettings(newConfig())).value.fallbackSubagent).toBe("scout");
  });

  it("round-trips workflowsEnabled's auto/true/false arms", async () => {
    await newConfig().save({ workflowsEnabled: true });
    expect((await loadSubagentsSettings(newConfig())).value.workflowsEnabled).toBe(true);

    await newConfig().save({ workflowsEnabled: false });
    expect((await loadSubagentsSettings(newConfig())).value.workflowsEnabled).toBe(false);

    await newConfig().save({ workflowsEnabled: "auto" });
    expect((await loadSubagentsSettings(newConfig())).value.workflowsEnabled).toBe("auto");
  });

  // Back-compat: agentMentions took a plain boolean before "model"/"direct"/"off"
  // existed (README still documents #true/#false as accepted spellings).
  it("round-trips agentMentions' legacy boolean arm alongside its modes", async () => {
    await newConfig().save({ agentMentions: false });
    expect((await loadSubagentsSettings(newConfig())).value.agentMentions).toBe(false);

    await newConfig().save({ agentMentions: "direct" });
    expect((await loadSubagentsSettings(newConfig())).value.agentMentions).toBe("direct");
  });

  it("surfaces a validation issue and falls back to the field's default for a bad hand-edit", async () => {
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(kdlPath(), 'subagents {\n  max-concurrent "not-a-number"\n}\n');

    const loaded = await loadSubagentsSettings(newConfig());
    expect(loaded.issues.length).toBeGreaterThan(0);
    expect(loaded.issues[0]).toContain("subagents");
    // A parse failure on one field falls back to the WHOLE section's defaults
    // (Config.load's contract) — not just the bad field.
    expect(loaded.value.maxConcurrent).toBe(10);
  });

  it("exposes the file path a caller can show in a diagnostic", () => {
    expect(newConfig().path).toBe(kdlPath());
  });
});

function makeAppliers(): SettingsAppliers {
  return {
    setMaxConcurrent: vi.fn(),
    setMaxConcurrentForeground: vi.fn(),
    setDefaultMaxTurns: vi.fn(),
    setGraceTurns: vi.fn(),
    setDefaultJoinMode: vi.fn(),
    setBackgroundByDefault: vi.fn(),
    setSchedulingEnabled: vi.fn(),
    setScopeModels: vi.fn(),
    setStrictAgentFiles: vi.fn(),
    setDisableDefaultAgents: vi.fn(),
    setToolDescriptionMode: vi.fn(),
    setFleetView: vi.fn(),
    setAgentMentions: vi.fn(),
    setRememberAgents: vi.fn(),
    setWidgetMode: vi.fn(),
    setOutputTranscript: vi.fn(),
    setWorktreeIsolation: vi.fn(),
    setWorkflowsEnabled: vi.fn(),
    setMaxSubagentDepth: vi.fn(),
    setFallbackSubagent: vi.fn(),
    setReportUsage: vi.fn(),
    setShowCost: vi.fn(),
    setShowModel: vi.fn(),
    setViewerMarkdown: vi.fn(),
  };
}

/** A fully-populated settings value, as `Config.load()` always returns — every field present. */
function fullSettings(overrides: Partial<SubagentsSettings> = {}): SubagentsSettings {
  return {
    maxConcurrent: 10,
    maxConcurrentForeground: 0,
    defaultMaxTurns: 0,
    graceTurns: 5,
    defaultJoinMode: "smart",
    backgroundByDefault: true,
    schedulingEnabled: true,
    scopeModels: false,
    strictAgentFiles: false,
    disableDefaultAgents: false,
    toolDescriptionMode: "full",
    fleetView: true,
    agentMentions: "model",
    rememberAgents: true,
    widgetMode: "background",
    outputTranscript: true,
    worktreeIsolation: true,
    workflowsEnabled: "auto",
    maxSubagentDepth: 2,
    fallbackSubagent: "general-purpose",
    reportUsage: false,
    showCost: false,
    showModel: false,
    viewerMarkdown: "assistant",
    ...overrides,
  };
}

describe("applySettings", () => {
  let appliers: SettingsAppliers;

  beforeEach(() => {
    appliers = makeAppliers();
  });

  it("calls every setter with the loaded value — every field is always present", () => {
    applySettings(fullSettings({ maxConcurrent: 4, graceTurns: 3, defaultJoinMode: "group" }), appliers);
    expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(4);
    expect(appliers.setGraceTurns).toHaveBeenCalledWith(3);
    expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("group");
    expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(0);
    expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(true);
    expect(appliers.setScopeModels).toHaveBeenCalledWith(false);
    expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(false);
    expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("full");
    expect(appliers.setWidgetMode).toHaveBeenCalledWith("background");
    expect(appliers.setViewerMarkdown).toHaveBeenCalledWith("assistant");
  });

  // 0 is a real value here (unlimited), so `if (s.x)` truthiness would silently
  // skip it — assert the exact call rather than just "was called".
  it("passes maxConcurrentForeground: 0 through, not just truthy values", () => {
    applySettings(fullSettings({ maxConcurrentForeground: 0 }), appliers);
    expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(0);
  });

  it("maps fallbackSubagent: false to the NO_FALLBACK sentinel", () => {
    applySettings(fullSettings({ fallbackSubagent: false }), appliers);
    expect(appliers.setFallbackSubagent).toHaveBeenCalledWith(NO_FALLBACK);
  });

  it("passes a named fallback agent through unchanged", () => {
    applySettings(fullSettings({ fallbackSubagent: "my-router" }), appliers);
    expect(appliers.setFallbackSubagent).toHaveBeenCalledWith("my-router");
  });

  it("does not call setWorkflowsEnabled when workflowsEnabled is 'auto' — leaves it unpinned", () => {
    applySettings(fullSettings({ workflowsEnabled: "auto" }), appliers);
    expect(appliers.setWorkflowsEnabled).not.toHaveBeenCalled();
  });

  it("calls setWorkflowsEnabled with a pinned boolean in either direction", () => {
    applySettings(fullSettings({ workflowsEnabled: true }), appliers);
    expect(appliers.setWorkflowsEnabled).toHaveBeenCalledWith(true);

    applySettings(fullSettings({ workflowsEnabled: false }), appliers);
    expect(appliers.setWorkflowsEnabled).toHaveBeenCalledWith(false);
  });

  // agentMentions used to be a plain boolean before the "model"/"direct"/"off"
  // modes existed; README still promises the booleans are read as `model`/`off`.
  it("maps the legacy agentMentions booleans to their modes", () => {
    applySettings(fullSettings({ agentMentions: true }), appliers);
    expect(appliers.setAgentMentions).toHaveBeenCalledWith("model");

    applySettings(fullSettings({ agentMentions: false }), appliers);
    expect(appliers.setAgentMentions).toHaveBeenCalledWith("off");
  });

  it("passes agentMentions modes through unchanged", () => {
    applySettings(fullSettings({ agentMentions: "direct" }), appliers);
    expect(appliers.setAgentMentions).toHaveBeenCalledWith("direct");
  });
});

describe("persistToastFor", () => {
  it("returns an info-level toast with the plain message when there are no issues", () => {
    expect(persistToastFor("Max concurrency set to 7", [])).toEqual({
      message: "Max concurrency set to 7",
      level: "info",
    });
  });

  it("returns a warning-level toast naming the issues on failure", () => {
    const result = persistToastFor("Max concurrency set to 7", ["disk full"]);
    expect(result.level).toBe("warning");
    expect(result.message).toContain("Max concurrency set to 7");
    expect(result.message).toContain("disk full");
  });
});

describe("applyAndEmitLoaded", () => {
  let homeDir: string;
  let appliers: SettingsAppliers;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-settings-home-"));
    appliers = makeAppliers();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("loads, applies, and emits subagents:settings_loaded with the full settings value", async () => {
    const config = createSubagentsConfig({}, homeDir);
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(homeDir, ".pi", "agent", "jpi.kdl"),
      "subagents {\n  max-concurrent 16\n  grace-turns 7\n}\n",
    );
    const emit = vi.fn();

    const loaded = await applyAndEmitLoaded(config, appliers, emit);

    expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
    expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
    expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(0);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: loaded.value });
    expect(loaded.value.maxConcurrent).toBe(16);
    expect(loaded.value.graceTurns).toBe(7);
  });

  it("still applies and emits defaults when jpi.kdl doesn't exist yet", async () => {
    const config = createSubagentsConfig({}, homeDir);
    const emit = vi.fn();

    const loaded = await applyAndEmitLoaded(config, appliers, emit);

    expect(loaded.value.maxConcurrent).toBe(10);
    expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(10);
    expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: loaded.value });
  });
});

describe("saveAndEmitChanged", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-settings-home-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists, emits with persisted=true, and returns an info toast on success", async () => {
    const config = createSubagentsConfig({}, homeDir);
    const emit = vi.fn();
    const snapshot = fullSettings({ maxConcurrent: 5, graceTurns: 2 });

    const toast = await saveAndEmitChanged(config, snapshot, "Max concurrency set to 5", emit);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("subagents:settings_changed", { settings: snapshot, persisted: true });
    expect(toast).toEqual({ message: "Max concurrency set to 5", level: "info" });

    const loaded = await loadSubagentsSettings(createSubagentsConfig({}, homeDir));
    expect(loaded.value.maxConcurrent).toBe(5);
    expect(loaded.value.graceTurns).toBe(2);
  });

  it("emits with persisted=false and returns a warning toast when save reports issues", async () => {
    const config = createSubagentsConfig({}, homeDir);
    const emit = vi.fn();
    // An unsupported key can't be saved as a scalar field — Config.save
    // reports it as an issue without writing anything.
    const snapshot = { ...fullSettings(), notAField: true } as unknown as SubagentsSettings;

    const toast = await saveAndEmitChanged(config, snapshot, "Max concurrency set to 5", emit);

    expect(emit).toHaveBeenCalledWith(
      "subagents:settings_changed",
      expect.objectContaining({ persisted: false }),
    );
    expect(toast.level).toBe("warning");
    expect(toast.message).toContain("Max concurrency set to 5");
  });
});
