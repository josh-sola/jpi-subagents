import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Byte-exact test fixture (tests/tool-description-mode.test.ts pins it against
    // the extension's built-in description) — reformatting it breaks that pin.
    ignorePatterns: ["examples/agent-tool-description.md"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // pi.on/registerCommand take these methods as plain closures with no `this`.
      "typescript/unbound-method": "off",
      "no-control-regex": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // The print-mode e2e tests register a faux pi-ai provider and need the session
    // to stream through that same pi-ai instance. npm duplicates pi-ai (top-level +
    // nested under pi-coding-agent), yielding two registries and "No API provider
    // registered". Inlining routes the @earendil-works packages through Vite's
    // resolver so dedupe can collapse pi-ai; dedupe alone skips externalized modules.
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
