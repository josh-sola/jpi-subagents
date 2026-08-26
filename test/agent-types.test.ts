import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  getDefaultAgentNames,
  getToolNamesForType,
  getUserAgentNames,
  isDefaultsDisabled,
  isValidType,
  NO_FALLBACK,
  registerAgents,
  resolveEnabledTypeIn,
  resolveSpawnType,
  resolveSpawnTypeIn,
  resolveType,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("default agents", () => {
    it("recognizes all default agent types", () => {
      expect(isValidType("general-purpose")).toBe(true);
      expect(isValidType("Explore")).toBe(true);
      expect(isValidType("Plan")).toBe(true);
    });

    it("does not include removed agents", () => {
      expect(isValidType("statusline-setup")).toBe(false);
      expect(isValidType("claude-code-guide")).toBe(false);
    });

    it("rejects unknown types", () => {
      expect(isValidType("nonexistent")).toBe(false);
      expect(isValidType("")).toBe(false);
    });

    it("case-insensitive lookup works for isValidType", () => {
      expect(isValidType("explore")).toBe(true);
      expect(isValidType("EXPLORE")).toBe(true);
      expect(isValidType("General-Purpose")).toBe(true);
      expect(isValidType("plan")).toBe(true);
    });

    it("case-insensitive lookup works for getAgentConfig", () => {
      const config = getAgentConfig("Explore");
      expect(config?.name).toBe("explore");
      expect(config?.modelDefault).toBe("openai-codex/gpt-5.6-luna");
    });

    it("resolveType returns canonical key or undefined", () => {
      expect(resolveType("Explore")).toBe("explore");
      expect(resolveType("explore")).toBe("explore");
      expect(resolveType("GENERAL-PURPOSE")).toBe("general-purpose");
      expect(resolveType("nonexistent")).toBeUndefined();
    });

    it("returns correct config for default types", () => {
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("general-purpose");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(config.extensions).toBe(true);
      expect(config.skills).toBe(true);
    });

    it("explore has read-only tools", () => {
      const config = getConfig("explore");
      expect(config.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
      expect(config.builtinToolNames).not.toContain("edit");
      expect(config.builtinToolNames).not.toContain("write");
    });

    it("explore has model_default in config", () => {
      const cfg = getAgentConfig("explore");
      expect(cfg?.modelDefault).toBe("openai-codex/gpt-5.6-luna");
    });

    it("default agents are marked isDefault", () => {
      const cfg = getAgentConfig("general-purpose");
      expect(cfg?.isDefault).toBe(true);
    });

    // Regression guard for #37 — default agents must not bake in callsite-strategy
    // fields the caller didn't ask to lock. An explicit `false` here would
    // silently win over the caller's `true` via `??` in
    // resolveAgentInvocationConfig, breaking documented Agent tool params.
    // `inherit_context` is a deliberate exception: all three defaults pin it to
    // `false` for a fresh context on every run.
    it("default agents leave run_in_background / isolated to the caller, and pin inherit_context to false", () => {
      for (const name of ["general-purpose", "explore", "plan"]) {
        const cfg = getAgentConfig(name);
        expect(cfg?.runInBackground, `${name}.runInBackground`).toBeUndefined();
        expect(cfg?.inheritContext, `${name}.inheritContext`).toBe(false);
        expect(cfg?.isolated, `${name}.isolated`).toBeUndefined();
      }
    });

    it("getDefaultAgentNames returns default agent names", () => {
      const names = getDefaultAgentNames();
      expect(names).toContain("general-purpose");
      expect(names).toContain("explore");
      expect(names).toContain("plan");
    });

    it("BUILTIN_TOOL_NAMES includes all built-in tools", () => {
      expect(BUILTIN_TOOL_NAMES).toContain("read");
      expect(BUILTIN_TOOL_NAMES).toContain("bash");
      expect(BUILTIN_TOOL_NAMES).toContain("edit");
      expect(BUILTIN_TOOL_NAMES).toContain("write");
      expect(BUILTIN_TOOL_NAMES).toContain("grep");
      expect(BUILTIN_TOOL_NAMES).toContain("find");
      expect(BUILTIN_TOOL_NAMES).toContain("ls");
      expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("disable defaults", () => {
    // Module-level flag — always reset so later describes see the default roster.
    afterEach(() => {
      setDefaultsDisabled(false);
      registerAgents(new Map());
    });

    it("defaults to enabled", () => {
      expect(isDefaultsDisabled()).toBe(false);
    });

    it("registerAgents skips DEFAULT_AGENTS when disabled", () => {
      setDefaultsDisabled(true);
      registerAgents(new Map());

      expect(getAvailableTypes()).toEqual([]);
      expect(isValidType("general-purpose")).toBe(false);
      expect(isValidType("explore")).toBe(false);
      expect(isValidType("plan")).toBe(false);
    });

    it("user agents are unaffected when defaults are disabled", () => {
      setDefaultsDisabled(true);
      registerAgents(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));

      expect(getAvailableTypes()).toEqual(["auditor"]);
      expect(isValidType("auditor")).toBe(true);
      expect(getDefaultAgentNames()).toEqual([]);
    });

    it("re-enabling restores defaults on next registerAgents", () => {
      setDefaultsDisabled(true);
      registerAgents(new Map());
      expect(isValidType("general-purpose")).toBe(false);

      setDefaultsDisabled(false);
      registerAgents(new Map());
      expect(isValidType("general-purpose")).toBe(true);
      expect(isValidType("explore")).toBe(true);
      expect(isValidType("plan")).toBe(true);
    });

    it("getConfig falls back to the hardcoded config when defaults are disabled and no user agents exist", () => {
      setDefaultsDisabled(true);
      registerAgents(new Map());

      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(config.promptMode).toBe("append");
    });
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Auditor" })]]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("includes user agents in available types", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);

      const types = getAvailableTypes();
      expect(types).toContain("general-purpose");
      expect(types).toContain("explore");
      expect(types).toContain("auditor");
    });

    it("lists user agent names separately", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
        ["reviewer", makeAgentConfig({ name: "reviewer" })],
      ]);
      registerAgents(agents);

      const names = getUserAgentNames();
      expect(names).toEqual(["auditor", "reviewer"]);
      expect(names).not.toContain("general-purpose");
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        description: "Security auditor",
        builtinToolNames: ["read", "grep"],
        extensions: false,
        skills: true,
      })]]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(true);
    });

    it("getConfig returns extension allowlist for user agents", () => {
      const agents = new Map([["partial", makeAgentConfig({
        name: "partial",
        extensions: ["web-search"],
        skills: ["planning"],
      })]]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensions).toEqual(["web-search"]);
      expect(config.skills).toEqual(["planning"]);
    });

    it("getToolNamesForType works for user agents", () => {
      const agents = new Map([["auditor", makeAgentConfig({
        name: "auditor",
        builtinToolNames: ["read", "grep", "find"],
      })]]);
      registerAgents(agents);

      const names = getToolNamesForType("auditor");
      expect(names).toEqual(["read", "grep", "find"]);
    });

    it("getToolNamesForType honors an explicit empty builtinToolNames as zero built-ins", () => {
      // `tools: none` and `tools:` with only `ext:` entries both produce `[]`.
      const agents = new Map([["ext-only", makeAgentConfig({
        name: "ext-only",
        builtinToolNames: [],
      })]]);
      registerAgents(agents);

      expect(getToolNamesForType("ext-only")).toEqual([]);
    });

    it("getConfig falls back to general-purpose for unknown types", () => {
      const config = getConfig("nonexistent");
      expect(config.displayName).toBe("general-purpose");
      expect(config.description).toBe(DEFAULT_AGENTS.get("general-purpose")?.description);
    });

    it("clearing user agents works (defaults remain)", () => {
      const agents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
      expect(isValidType("general-purpose")).toBe(true);
    });

    it("user agent overrides default with same name", () => {
      const agents = new Map([["explore", makeAgentConfig({
        name: "explore",
        description: "Custom Explore",
        builtinToolNames: BUILTIN_TOOL_NAMES,
      })]]);
      registerAgents(agents);

      const config = getConfig("explore");
      expect(config.description).toBe("Custom Explore");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([["plan", makeAgentConfig({
        name: "plan",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("plan")).toBe(false);
      expect(getAvailableTypes()).not.toContain("plan");
    });

    it("general-purpose can be disabled but fallback still works", () => {
      const agents = new Map([["general-purpose", makeAgentConfig({
        name: "general-purpose",
        enabled: false,
      })]]);
      registerAgents(agents);

      expect(isValidType("general-purpose")).toBe(false);
      // getConfig fallback should still return something reasonable
      const config = getConfig("general-purpose");
      expect(config.displayName).toBe("Agent");
    });
  });

  describe("BUILTIN_TOOL_NAMES", () => {
    // BUILTIN_TOOL_NAMES is derived dynamically from pi's tool factories
    // (createCodingTools + createReadOnlyTools). This guards against pi-mono
    // dropping/renaming a built-in: the set must still contain at least these
    // 7. It's a superset check ("at least") — pi adding a new built-in is fine
    // and won't fail this test.
    const EXPECTED = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    it("contains at least the 7 known built-ins", () => {
      for (const name of EXPECTED) {
        expect(BUILTIN_TOOL_NAMES).toContain(name);
      }
    });

    it("has no duplicate entries", () => {
      expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
    });
  });
});

describe("resolveSpawnType — fail-closed dispatch (#183)", () => {
  afterEach(() => {
    setFallbackSubagent(undefined);
    setDefaultsDisabled(false);
    registerAgents(new Map());
  });

  const roster = () => new Map([
    ["scout", makeAgentConfig({ name: "scout" })],
    ["retired", makeAgentConfig({ name: "retired", enabled: false })],
    ["router", makeAgentConfig({ name: "router" })],
  ]);

  it("resolves an enabled type case-insensitively", () => {
    registerAgents(roster());
    expect(resolveSpawnType("SCOUT")).toEqual({ ok: true, type: "scout" });
  });

  it("falls back to general-purpose when unset, reporting what was asked for", () => {
    registerAgents(roster());
    expect(resolveSpawnType("typoo")).toEqual({
      ok: true, type: "general-purpose", fellBackFrom: "typoo",
    });
  });

  it("rejects unknown types under `none` and names what is available", () => {
    registerAgents(roster());
    setFallbackSubagent(NO_FALLBACK);
    const r = resolveSpawnType("typoo");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.message).toContain('Unknown or disabled agent type: "typoo"');
    expect(r.message).toContain("scout");
    expect(r.message).not.toContain("retired"); // disabled agents aren't offered
  });

  it("treats a disabled type as unresolvable, not as a valid name", () => {
    // Regression: the old path used resolveType(), which ignores `enabled`, so a
    // disabled agent dispatched with its own prompt and general-purpose's tools.
    registerAgents(roster());
    expect(resolveSpawnType("retired")).toEqual({
      ok: true, type: "general-purpose", fellBackFrom: "retired",
    });
    setFallbackSubagent(NO_FALLBACK);
    expect(resolveSpawnType("retired").ok).toBe(false);
  });

  it("refuses to guess between two types differing only by case", () => {
    registerAgents(new Map([
      ["Scout", makeAgentConfig({ name: "Scout" })],
      ["scout", makeAgentConfig({ name: "scout" })],
    ]));
    // An exact match is still unambiguous...
    expect(resolveSpawnType("scout")).toEqual({ ok: true, type: "scout" });
    // ...but a differently-cased spelling matches both, so it must not pick one.
    expect(resolveSpawnType("SCOUT").ok).toBe(true);
    expect(resolveSpawnType("SCOUT")).toEqual({
      ok: true, type: "general-purpose", fellBackFrom: "SCOUT",
    });
  });

  it("routes unresolvable types to a named fallback agent", () => {
    registerAgents(roster());
    setFallbackSubagent("router");
    expect(resolveSpawnType("typoo")).toEqual({
      ok: true, type: "router", fellBackFrom: "typoo",
    });
  });

  it("fails loudly when the configured fallback is itself unusable", () => {
    // Explicit configuration that cannot work is a misconfiguration, not a
    // second chance to guess — never a silent drop to general-purpose.
    registerAgents(roster());
    setFallbackSubagent("retired");
    const r = resolveSpawnType("typoo");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.message).toContain("fallbackSubagent");
  });

  it("treats a missing type like any other unresolvable one", () => {
    // Before this setting existed an empty type fell back like a typo; only
    // opting in should change that, so the default must stay permissive.
    registerAgents(roster());
    for (const empty of ["", "   ", undefined]) {
      expect(resolveSpawnType(empty)).toMatchObject({ ok: true, type: "general-purpose" });
    }

    setFallbackSubagent(NO_FALLBACK);
    for (const empty of ["", "   ", undefined]) {
      const r = resolveSpawnType(empty);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected rejection");
      expect(r.message).toContain("No agent type given");
    }
  });

  it("resolves strictly regardless of the setting, for nested delegation", () => {
    // Nested delegation uses this seam so a project-level fallback can't hand a
    // nested caller an agent its allowlist never named.
    const registry = roster();
    setFallbackSubagent("router");
    expect(resolveEnabledTypeIn(registry, "typoo")).toBeUndefined();
    expect(resolveEnabledTypeIn(registry, "retired")).toBeUndefined();
    expect(resolveEnabledTypeIn(registry, " SCOUT ")).toBe("scout");
    // ...while the policy layer still honors it.
    expect(resolveSpawnTypeIn(registry, "typoo")).toEqual({
      ok: true, type: "router", fellBackFrom: "typoo",
    });
  });
});
