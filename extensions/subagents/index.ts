import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function jpiSubagentsDeprecated(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "jpi-subagents has moved into the consolidated jpi plugin. Run " +
        "`pi install git:github.com/josh-sola/jpi` to get it back, then " +
        "`pi remove git:github.com/josh-sola/jpi-subagents` to drop this stub.",
      "warning",
    );
  });
}
