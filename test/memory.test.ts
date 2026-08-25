import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir so the user-scope legacy fallback check (~/.pi/agent-memory)
// resolves against a controlled temp home rather than the developer's real
// ~/.pi state. The default return must be a valid string: pi-coding-agent
// evaluates getAgentDir() at module load, so an undefined homedir throws at import.
const mockHomedir = vi.hoisted(() => vi.fn(() => "/tmp"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: mockHomedir };
});

import { isSymlink, isUnsafeName, safeReadFile } from "../src/fs-safety.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock, ensureMemoryDir, readMemoryIndex, resolveMemoryDir } from "../src/memory.js";

describe("memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-mem-test-"));
    // Point homedir at a clean temp home with no legacy agent-memory dirs, so
    // user-scope resolution deterministically returns the agent-dir location.
    const fakeHome = join(tmpDir, "home");
    mkdirSync(fakeHome, { recursive: true });
    mockHomedir.mockReturnValue(fakeHome);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveMemoryDir", () => {
    // "user" is the only remaining scope — project/local memory is gone, and
    // custom-agents.ts's parseMemory already collapses those frontmatter
    // values to "user" before they ever reach here.
    it("resolves under the agent dir (honors PI_CODING_AGENT_DIR), ignoring cwd", () => {
      const originalEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(tmpDir, "custom-agent-dir");
      try {
        const dir = resolveMemoryDir("auditor", "user", "/workspace");
        expect(dir).toBe(join(tmpDir, "custom-agent-dir", "agent-memory", "auditor"));
        expect(dir).not.toContain("/workspace");
      } finally {
        if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalEnv;
      }
    });

    it("throws on names with path traversal (..)", () => {
      expect(() => resolveMemoryDir("../../etc/evil", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with forward slash", () => {
      expect(() => resolveMemoryDir("foo/bar", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with backslash", () => {
      expect(() => resolveMemoryDir("foo\\bar", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with null byte", () => {
      expect(() => resolveMemoryDir("foo\0bar", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on empty name", () => {
      expect(() => resolveMemoryDir("", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names starting with dot", () => {
      expect(() => resolveMemoryDir(".hidden", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with spaces", () => {
      expect(() => resolveMemoryDir("foo bar", "user", "/workspace")).toThrow("Unsafe agent name");
    });

    it("allows hyphens, underscores, and dots in names", () => {
      expect(() => resolveMemoryDir("my-agent_v2.1", "user", "/workspace")).not.toThrow();
    });
  });

  describe("isUnsafeName (whitelist validation)", () => {
    it("rejects empty string", () => {
      expect(isUnsafeName("")).toBe(true);
    });

    it("rejects names longer than 128 chars", () => {
      expect(isUnsafeName("a".repeat(129))).toBe(true);
    });

    it("rejects path traversal", () => {
      expect(isUnsafeName("../../etc")).toBe(true);
    });

    it("rejects names starting with dot", () => {
      expect(isUnsafeName(".hidden")).toBe(true);
    });

    it("rejects names with spaces", () => {
      expect(isUnsafeName("foo bar")).toBe(true);
    });

    it("rejects names with special characters", () => {
      expect(isUnsafeName("foo;bar")).toBe(true);
      expect(isUnsafeName("foo|bar")).toBe(true);
      expect(isUnsafeName("foo`bar")).toBe(true);
    });

    it("allows valid names", () => {
      expect(isUnsafeName("my-agent")).toBe(false);
      expect(isUnsafeName("agent_v2")).toBe(false);
      expect(isUnsafeName("Agent123")).toBe(false);
      expect(isUnsafeName("my-agent.v2")).toBe(false);
    });
  });

  describe("ensureMemoryDir", () => {
    it("creates directory if it doesn't exist", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      expect(existsSync(dir)).toBe(false);
      ensureMemoryDir(dir);
      expect(existsSync(dir)).toBe(true);
    });

    it("no-ops if directory already exists", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      mkdirSync(dir, { recursive: true });
      ensureMemoryDir(dir); // should not throw
      expect(existsSync(dir)).toBe(true);
    });

    it("throws on symlinked directory", () => {
      const realDir = join(tmpDir, "real-dir");
      const linkDir = join(tmpDir, "symlink-dir");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir);
      expect(() => ensureMemoryDir(linkDir)).toThrow("symlinked memory directory");
    });
  });

  describe("isSymlink", () => {
    it("returns false for regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "content");
      expect(isSymlink(file)).toBe(false);
    });

    it("returns true for symlink", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "content");
      symlinkSync(file, link);
      expect(isSymlink(link)).toBe(true);
    });

    it("returns false for nonexistent path", () => {
      expect(isSymlink(join(tmpDir, "nope"))).toBe(false);
    });
  });

  describe("safeReadFile", () => {
    it("reads regular files", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "hello");
      expect(safeReadFile(file)).toBe("hello");
    });

    it("rejects symlinked files", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "secret");
      symlinkSync(file, link);
      expect(safeReadFile(link)).toBeUndefined();
    });

    it("returns undefined for nonexistent files", () => {
      expect(safeReadFile(join(tmpDir, "nope.txt"))).toBeUndefined();
    });
  });

  describe("readMemoryIndex", () => {
    it("returns undefined when MEMORY.md doesn't exist", () => {
      const result = readMemoryIndex(tmpDir);
      expect(result).toBeUndefined();
    });

    it("reads MEMORY.md content", () => {
      writeFileSync(join(tmpDir, "MEMORY.md"), "# Memories\n- Item 1\n- Item 2");
      const result = readMemoryIndex(tmpDir);
      expect(result).toBe("# Memories\n- Item 1\n- Item 2");
    });

    it("rejects symlinked memory directory", () => {
      const realDir = join(tmpDir, "real-mem");
      const linkDir = join(tmpDir, "link-mem");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      symlinkSync(realDir, linkDir);
      expect(readMemoryIndex(linkDir)).toBeUndefined();
    });

    it("rejects symlinked MEMORY.md file", () => {
      const realFile = join(tmpDir, "secret.md");
      writeFileSync(realFile, "# Secret");
      const memDir = join(tmpDir, "mem-dir");
      mkdirSync(memDir);
      symlinkSync(realFile, join(memDir, "MEMORY.md"));
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("truncates content beyond 200 lines", () => {
      const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`);
      writeFileSync(join(tmpDir, "MEMORY.md"), lines.join("\n"));
      const result = readMemoryIndex(tmpDir)!;
      expect(result).toContain("Line 200");
      expect(result).not.toContain("Line 201");
      expect(result).toContain("truncated at 200 lines");
    });
  });

  describe("buildMemoryBlock", () => {
    it("builds memory block with no existing MEMORY.md", () => {
      const block = buildMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("Agent Memory");
      expect(block).toContain("agent-memory/test-agent");
      expect(block).toContain("No MEMORY.md exists yet");
      expect(block).toContain("Memory Instructions");
    });

    it("builds memory block with existing MEMORY.md", () => {
      const memDir = join(tmpDir, "home", ".pi", "agent", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
      expect(block).not.toContain("No MEMORY.md exists yet");
    });

    it("creates memory directory if it doesn't exist", () => {
      const memDir = join(tmpDir, "home", ".pi", "agent", "agent-memory", "new-agent");
      expect(existsSync(memDir)).toBe(false);
      buildMemoryBlock("new-agent", "user", tmpDir);
      expect(existsSync(memDir)).toBe(true);
    });

    it("includes Read/Write/Edit instructions", () => {
      const block = buildMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("Read, Write, and Edit tools");
    });

    it("resolves under the agent dir, ignoring cwd (honors PI_CODING_AGENT_DIR)", () => {
      const originalEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent-dir");
      try {
        const block = buildMemoryBlock("test-agent", "user", join(tmpDir, "workspace"));
        expect(block).toContain(join(tmpDir, "agent-dir", "agent-memory", "test-agent"));
        expect(block).not.toContain(join(tmpDir, "workspace"));
      } finally {
        if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalEnv;
      }
    });

    it("includes the scope label in the header", () => {
      expect(buildMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });
  });

  describe("buildReadOnlyMemoryBlock", () => {
    it("returns read-only instructions without write/edit mention", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("read-only");
      expect(block).not.toContain("Write");
      expect(block).not.toContain("Edit");
      expect(block).not.toContain("Memory Instructions");
    });

    it("does NOT create the memory directory", () => {
      const memDir = join(tmpDir, "home", ".pi", "agent", "agent-memory", "ro-agent");
      expect(existsSync(memDir)).toBe(false);
      buildReadOnlyMemoryBlock("ro-agent", "user", tmpDir);
      expect(existsSync(memDir)).toBe(false);
    });

    it("includes existing MEMORY.md content", () => {
      const memDir = join(tmpDir, "home", ".pi", "agent", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildReadOnlyMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
    });

    it("returns 'no memory available' when no MEMORY.md exists", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain("No memory is available yet");
      expect(block).not.toContain("Create one");
    });

    it("includes the scope label in the header", () => {
      expect(buildReadOnlyMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });

    it("does not mention memory directory path for write access", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "user", tmpDir);
      expect(block).not.toContain("persistent memory directory at:");
      expect(block).not.toContain("Create one at");
    });

    it("rejects symlinked memory directory in read-only mode", () => {
      const memoryRoot = join(tmpDir, "home", ".pi", "agent", "agent-memory");
      const realDir = join(memoryRoot, "test-agent");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      const linkDir = join(memoryRoot, "linked-agent");
      symlinkSync(realDir, linkDir);
      // Should not read through the symlink
      const block = buildReadOnlyMemoryBlock("linked-agent", "user", tmpDir);
      expect(block).toContain("No memory is available yet");
    });
  });
});
