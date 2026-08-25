---
description: "memory read-only — an agent without write tools gets a read-only memory block."
memory: user
tools: read, grep
expect_tools_present: "read, grep"
expect_tools_absent: "write, edit"
expect_prompt_contains: "Agent Memory (read-only), Memory scope: user"
expect_prompt_absent: "persistent memory directory"
---
A read-only memory agent. Per the README, agents without write/edit tools
auto-get a read-only memory fallback: existing memory is injected, no write
access is granted, and no memory directory is created — and the read-only
branch never writes to disk regardless, so this is safe against the real
`user` memory dir even without the test's hermetic PI_CODING_AGENT_DIR.
