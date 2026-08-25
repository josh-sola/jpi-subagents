// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";
import { renderSubagentsKdl } from "./helpers/boot-extension.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../examples/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  /** jpi.kdl lives under the hermetic agent dir, not the cwd. */
  const jpiKdlPath = () => join(hermeticAgentDir, "jpi.kdl");

  async function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real jpi.kdl
    // can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    if (settings) {
      writeFileSync(jpiKdlPath(), renderSubagentsKdl(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    await subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    // setup() without a `worktreeIsolation` key leaves the module singleton
    // wherever the previous test left it. Reset it so each setup()'s
    // settings decide, and so the "default" assertions below really test it.
    setWorktreeIsolationEnabled(true);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("defaults to the full description", async () => {
    const tools = await setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
    // Full agent descriptions are embedded (a late Explore sentence survives).
    expect(desc).toContain("very thorough");
  });

  it("compact mode swaps in the short description with one-line type list", async () => {
    const tools = await setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Launch an autonomous agent");
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    // Type list keeps every agent but only the first sentence of each description.
    expect(desc).toContain("- general-purpose:");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
    expect(desc).not.toContain("very thorough");
    // The point of the feature: materially smaller than the full version.
    expect(desc.length).toBeLessThan(1600);
  });

  it("invalid mode in the settings file is dropped — full description", async () => {
    const tools = await setup({ toolDescriptionMode: "tiny" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
  });

  it("compact keeps every load-bearing contract — fails when a behavior change forgets compact", async () => {
    const tools = await setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    // One keyword per behavioral contract the orchestrator must know about.
    // If you change one of these behaviors, update BOTH descriptions.
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      'isolation: "worktree"',
      ".agents/agents/",
      "self-contained",
    ]) {
      expect(desc).toContain(contract);
    }
  });

  // The compact test above pins the prose alone, which is right for compact —
  // it is the only place that mode states these. `full` is different: several
  // contracts are stated twice, in the description AND in the param schema, so
  // pinning prose alone would block a legitimate move of one into the other
  // while missing the failure that actually matters — a contract that ends up
  // in neither. Asserting over description + schema is the invariant that
  // survives either choice. The second test then keeps the schema half honest,
  // so "it's also in the schema" can never degrade to an empty stub.
  it("full states every load-bearing contract in the description or the schema", async () => {
    const tool = (await setup()).get("Agent");
    const visible = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      "worktree",
      ".agents/agents/",
      "self-contained",
      "model",
      "thinking",
      "inherit_context",
    ]) {
      expect(visible).toContain(contract);
    }
  });

  it("every strategy param carries a real description of its own", async () => {
    const props = (await setup()).get("Agent").parameters?.properties ?? {};
    for (const name of ["run_in_background", "model", "thinking", "inherit_context"]) {
      // Long enough to be an explanation the model can act on, not a bare label.
      expect(props[name]?.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("custom mode renders the global template with placeholders substituted", async () => {
    const tools = await setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(hermeticAgentDir, "agent-tool-description.md"),
        "My agents:\n{{typeList}}\n\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("My agents:");
    expect(desc).toContain("- general-purpose:"); // {{typeList}} expanded
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`); // {{agentDir}} expanded
    expect(desc).toContain("Unknown: {{nope}}"); // unknown placeholder left verbatim
    expect(desc).toContain("Cost: $& stays literal"); // no $-pattern expansion
    expect(desc).not.toContain("## Usage notes");
  });

  it("{{isolationGuideline}} expands to the isolation bullet when worktrees are on (default)", async () => {
    const tools = await setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain('RULES:\n- Use isolation: "worktree"');
  });

  it("{{isolationGuideline}} expands to the empty string when worktree isolation is disabled", async () => {
    const tools = await setup({ toolDescriptionMode: "custom", worktreeIsolation: false }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "RULES:{{isolationGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("RULES:\nEND");
    expect(desc).not.toContain("isolation");
  });

  it("every documented placeholder is replaced — no {{ }} residue", async () => {
    const tools = await setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(hermeticAgentDir, "agent-tool-description.md"),
        "A {{typeList}} B {{compactTypeList}} C {{agentDir}} D {{isolationGuideline}} F",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).not.toContain("{{");
    expect(desc).not.toContain("}}");
  });

  it("the shipped example template renders byte-identical to the full description", async () => {
    // Guards examples/agent-tool-description.md against going stale: it must
    // reproduce the full description exactly. If you edit one, edit the other.
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const tools = await setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), example);
    });
    const customDesc: string = tools.get("Agent").description;

    // Second instance in the same hermetic agent dir, flipped to full mode.
    writeFileSync(jpiKdlPath(), renderSubagentsKdl({ toolDescriptionMode: "full" }));
    const second = makePi();
    await subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to the full description with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = await setup({ toolDescriptionMode: "custom" });
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("## Usage notes");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
    } finally {
      warn.mockRestore();
    }
  });

  // The schema half of `worktreeIsolation: false` shipped without the prose
  // half: `isolationParam` dropped the field while both descriptions kept
  // telling the model to pass it. Nothing rejects the undeclared key (TypeBox
  // sets no additionalProperties: false) and, by design, nothing notes the
  // downgrade on the result — so the model had every reason to report a
  // `pi-agent-*` branch that was never created. Schema and prose have to move
  // together, which is why both are asserted here.
  describe("worktreeIsolation gates the isolation parameter and its prose", () => {
    const props = (tools: Map<string, any>) =>
      Object.keys(tools.get("Agent").parameters?.properties ?? {});

    it("advertises `isolation` in schema and prose by default", async () => {
      const tools = await setup();
      expect(props(tools)).toContain("isolation");
      expect(tools.get("Agent").description).toContain('Use isolation: "worktree"');
    });

    it("drops both when worktree isolation is disabled", async () => {
      const tools = await setup({ worktreeIsolation: false });
      const names = props(tools);
      expect(names).not.toContain("isolation");
      expect(tools.get("Agent").description).not.toContain("isolation");
      // One field, not the tool.
      expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type"]));
    });

    it("drops the compact description's bullet too", async () => {
      const enabled = await setup({ toolDescriptionMode: "compact" });
      expect(enabled.get("Agent").description).toContain('isolation: "worktree"');
    });

    it("compact mode says nothing about isolation when disabled", async () => {
      const tools = await setup({ toolDescriptionMode: "compact", worktreeIsolation: false });
      expect(tools.get("Agent").description).not.toContain("isolation");
      // The bullet above it survives — the gate trims a suffix, not the list.
      expect(tools.get("Agent").description).toContain("resume continues a previous agent by ID");
    });
  });

  // The tool description is the only thing the orchestrator LLM knows about an
  // agent's capabilities before spawning it. `tools: none` and an `ext:`-only
  // `tools:` both parse to zero built-ins (custom-agents.ts parseToolsField),
  // and test/fixtures/.agents/agents/tools-none.md pins that the *runtime* really
  // does drop every built-in. So the description must not claim otherwise —
  // an agent advertised as having `bash` that cannot run `bash` gets routed
  // work it can only fail at.
  describe("tool scope suffix reflects the real built-in set", () => {
    // Global tier — PI_CODING_AGENT_DIR is redirected to hermeticAgentDir by setup().
    async function withAgent(name: string, frontmatter: string, settings?: Record<string, unknown>) {
      const extra = frontmatter ? `${frontmatter}\n` : "";
      return await setup(settings, () => {
        const dir = join(hermeticAgentDir, "agents");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${name}.md`),
          `---\ndescription: ${name} agent.\n${extra}---\n\nBody.\n`,
        );
      });
    }

    it("`tools: none` never claims the full built-in set", async () => {
      const tools = await withAgent("quiet", "tools: none");
      const desc: string = tools.get("Agent").description;
      expect(desc).not.toContain("- quiet: quiet agent. (Tools: *)");
    });

    it("`tools: none` says none only when the agent can call nothing at all", async () => {
      // extensions: false and isolated: true both leave the agent with zero
      // built-ins AND zero extension tools — the one case "none" is true.
      for (const fm of ["tools: none\nextensions: false", "tools: none\nisolated: true"]) {
        const tools = await withAgent("silent", fm);
        expect(tools.get("Agent").description).toContain("- silent: silent agent. (Tools: none)");
      }
    });

    it("`tools: none` with extensions loaded is not described as having no tools", async () => {
      // Zero built-ins is not zero tools: test/fixtures/.agents/agents/tools-none.md
      // pins that such an agent still surfaces alpha_read, alpha_write, beta_tool.
      // Saying "none" understates it and routes work away from the only agent
      // that could do it — the mirror of the bug this suffix used to have.
      const tools = await withAgent("probe", 'tools: none\nextensions: "./ext-alpha.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- probe: probe agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: *)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: none)");
    });

    it("an ext:-only `tools:` is described by what it actually has", async () => {
      const tools = await withAgent("extonly", 'tools: "ext:probe.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- extonly: extonly agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- extonly: extonly agent. (Tools: *)");
    });

    it("compact mode shares the suffix builder and must not diverge", async () => {
      const tools = await withAgent("quiet", "tools: none\nextensions: false", { toolDescriptionMode: "compact" });
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- quiet: quiet agent. (Tools: none)");
      expect(desc).not.toContain("- quiet: quiet agent. (Tools: *)");
    });

    it("an omitted `tools:` still renders as * — absent means all built-ins", async () => {
      // Guards the fix from over-correcting: undefined (inherit everything,
      // as the shipped defaults do) is not the same as [] (explicitly zero).
      const tools = await withAgent("broad", "");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- broad: broad agent. (Tools: *)");
    });

    it("a narrowed `tools:` still lists the names it actually has", async () => {
      const tools = await withAgent("narrow", "tools: read, grep");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- narrow: narrow agent. (Tools: read, grep)");
    });
  });
});
