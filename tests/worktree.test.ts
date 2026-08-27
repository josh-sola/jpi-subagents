import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeCleanupPeriodDays,
  setWorktreeIsolationEnabled,
} from "../extensions/subagents/worktree.js";

// Every test here shells out to real git, several times over (add, lock,
// status, branch --contains, remove, ...) — the default 5s budget is tight
// under a loaded full-suite run where those subprocesses queue behind others.
vi.setConfig({ testTimeout: 20_000 });

/**
 * Minimal stand-in for pi.exec(): runs the command for real, and — like the
 * host's implementation — REPORTS failure in the result instead of rejecting.
 * The source has to read `code`/`killed` rather than rely on a throw, so a stub
 * that threw would hide the branch that matters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: any) {
        return {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          code: err.status ?? 1,
          killed: false,
        };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one git subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv git is called with.
 */
function failingPi(
  match: (args: string[]) => boolean,
  failure: { code: number; killed: boolean },
): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(
      async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        if (match(args)) return { stdout: "", stderr: "boom", ...failure };
        return real.exec(command, args, options);
      },
    ),
  } as unknown as ExtensionAPI;
}

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Parse `git worktree list --porcelain` into basename → locked, for
 * assertions. Keyed by basename rather than the full path because git
 * reports worktree paths resolved (macOS's tmpdir() sits behind a
 * /var → /private/var symlink), while `createWorktree` hands back the
 * unresolved logical path.
 */
function listWorktreeLocks(repoDir: string): Map<string, boolean> {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    stdio: "pipe",
  }).toString();
  const locks = new Map<string, boolean>();
  let current = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = basename(line.slice("worktree ".length));
      locks.set(current, false);
    } else if (line === "locked" || line.startsWith("locked ")) {
      locks.set(current, true);
    }
  }
  return locks;
}

describe("worktree", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });

  afterEach(async () => {
    // Clean up any lingering worktrees first, then remove repo
    try {
      await pruneWorktrees(pi, repoDir);
    } catch {
      /* ignore */
    }
    setWorktreeCleanupPeriodDays(30);
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", async () => {
      const wt = await createWorktree(pi, repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.baseSha).toBe(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoDir,
          stdio: "pipe",
        })
          .toString()
          .trim(),
      );

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try {
        execFileSync("git", ["worktree", "unlock", wt!.path], { cwd: repoDir, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("locks the worktree, so the TTL sweep can't reap one still in use", async () => {
      const wt = (await createWorktree(pi, repoDir, "lock-test"))!;
      expect(listWorktreeLocks(repoDir).get(basename(wt.path))).toBe(true);

      try {
        execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("returns undefined for non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = await createWorktree(pi, nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = await createWorktree(pi, emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("returns undefined when `git worktree add` reports a non-zero exit", async () => {
      // pi.exec resolves with a failure code instead of throwing, so a port that
      // only caught exceptions would hand back a worktree path that isn't there.
      const wt = await createWorktree(
        failingPi((args) => args[0] === "worktree" && args[1] === "add", {
          code: 128,
          killed: false,
        }),
        repoDir,
        "add-fails",
      );
      expect(wt).toBeUndefined();
    });

    it("returns undefined when a git call is killed by its timeout", async () => {
      // A killed process reports code 0 with killed: true — the one failure
      // shape that looks like success if only the exit code is checked.
      const wt = await createWorktree(
        failingPi((args) => args[0] === "rev-parse" && args[1] === "HEAD", {
          code: 0,
          killed: true,
        }),
        repoDir,
        "timed-out",
      );
      expect(wt).toBeUndefined();
    });

    it("still returns a worktree when locking fails", async () => {
      // Best-effort: an older git without `worktree lock`, or any other
      // failure, must not fail creation.
      const wt = await createWorktree(
        failingPi((args) => args[0] === "worktree" && args[1] === "lock", {
          code: 1,
          killed: false,
        }),
        repoDir,
        "lock-fails",
      );
      expect(wt).toBeDefined();
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt!.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("workPath equals path when created from the repo root", async () => {
      const wt = (await createWorktree(pi, repoDir, "root-wp"))!;
      expect(wt.workPath).toBe(wt.path);
      try {
        execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", async () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = (await createWorktree(pi, join(repoDir, "packages", "api"), "subdir-wp"))!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try {
        execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("uses unique paths for multiple worktrees", async () => {
      const wt1 = await createWorktree(pi, repoDir, "multi-1");
      const wt2 = await createWorktree(pi, repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      for (const wt of [wt1!, wt2!]) {
        try {
          execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
        } catch {
          /* ignore */
        }
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt.path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      }
    });

    it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
      // The reason for the port: several isolated agents can start at once, so
      // no call may block the caller until the previous one has finished.
      const order: string[] = [];
      const tracking = {
        exec: async (
          command: string,
          args: string[],
          options?: { cwd?: string; timeout?: number },
        ) => {
          order.push(`start:${args[0]}`);
          const result = await pi.exec(command, args, options);
          order.push(`end:${args[0]}`);
          return result;
        },
      } as unknown as ExtensionAPI;

      const [a, b] = await Promise.all([
        createWorktree(tracking, repoDir, "par-1"),
        createWorktree(tracking, repoDir, "par-2"),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Interleaving proves the two chains ran together: with blocking calls the
      // log would be strictly start/end paired.
      const interleaved = order.some(
        (entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"),
      );
      expect(interleaved).toBe(true);

      for (const wt of [a!, b!]) {
        try {
          execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
        } catch {
          /* ignore */
        }
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt.path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      }
    });

    describe(".worktreeinclude", () => {
      it("copies untracked files matching the include patterns, preserving nested paths and mode", async () => {
        mkdirSync(join(repoDir, "config", "local"), { recursive: true });
        writeFileSync(join(repoDir, "config", "local", "settings.json"), '{"local":true}');
        writeFileSync(join(repoDir, ".env"), "SECRET=1", { mode: 0o600 });
        writeFileSync(join(repoDir, "scratch.txt"), "not included");
        writeFileSync(join(repoDir, ".worktreeinclude"), ".env\nconfig/local/**\n");

        const wt = (await createWorktree(pi, repoDir, "include-1"))!;
        expect(wt).toBeDefined();

        expect(existsSync(join(wt.path, ".env"))).toBe(true);
        expect(statSync(join(wt.path, ".env")).mode & 0o777).toBe(0o600);
        expect(existsSync(join(wt.path, "config", "local", "settings.json"))).toBe(true);
        // A pattern the file doesn't match is never copied.
        expect(existsSync(join(wt.path, "scratch.txt"))).toBe(false);

        try {
          execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
        } catch {
          /* ignore */
        }
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt.path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      });

      it("is a no-op when there is no .worktreeinclude file", async () => {
        writeFileSync(join(repoDir, ".env"), "SECRET=1");
        const wt = (await createWorktree(pi, repoDir, "include-2"))!;
        expect(existsSync(join(wt.path, ".env"))).toBe(false);
        try {
          execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
        } catch {
          /* ignore */
        }
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt.path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      });

      it("still returns the worktree when copying fails", async () => {
        writeFileSync(join(repoDir, ".env"), "SECRET=1");
        writeFileSync(join(repoDir, ".worktreeinclude"), ".env\n");
        const failing = failingPi((args) => args[0] === "ls-files", { code: 1, killed: false });
        const wt = await createWorktree(failing, repoDir, "include-fails");
        expect(wt).toBeDefined();
        try {
          execFileSync("git", ["worktree", "unlock", wt!.path], { cwd: repoDir, stdio: "pipe" });
        } catch {
          /* ignore */
        }
        try {
          execFileSync("git", ["worktree", "remove", "--force", wt!.path], {
            cwd: repoDir,
            stdio: "pipe",
          });
        } catch {
          /* ignore */
        }
      });
    });
  });

  describe("cleanupWorktree", () => {
    it("removes a clean worktree", async () => {
      const wt = (await createWorktree(pi, repoDir, "clean-1"))!;
      expect(wt).toBeDefined();

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(false);
      expect(result.path).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    });

    it("unlocks the worktree first — a clean removal fails on a still-locked one", async () => {
      // createWorktree locks; `git worktree remove --force` (single) refuses a
      // locked worktree outright. If cleanupWorktree stopped unlocking, this
      // regresses to every clean worktree being kept behind by mistake.
      const wt = (await createWorktree(pi, repoDir, "unlock-1"))!;
      expect(listWorktreeLocks(repoDir).get(basename(wt.path))).toBe(true);

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(false);
      expect(existsSync(wt.path)).toBe(false);
    });

    it("keeps a worktree with an untracked file, uncommitted and unbranched", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-untracked"))!;
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(true);
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);
      expect(existsSync(join(wt.path, "new-file.txt"))).toBe(true);

      // Nothing was staged, committed, or branched on the agent's behalf.
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: wt.path,
        stdio: "pipe",
      }).toString();
      expect(status).toContain("new-file.txt");
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-*"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(branches).toBe("");

      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("keeps a worktree with a modified tracked file", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-modified"))!;
      writeFileSync(join(wt.path, "README.md"), "# Modified by agent");

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(true);
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);

      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("keeps a worktree whose HEAD moved (agent committed its own work)", async () => {
      const wt = (await createWorktree(pi, repoDir, "head-moved"))!;

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path,
        stdio: "pipe",
      })
        .toString()
        .trim();

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(true);
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);
      // The worktree itself is the hand-off — the commit lives there, not on a branch.
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, stdio: "pipe" })
          .toString()
          .trim(),
      ).toBe(agentCommit);

      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });

    it("handles already-deleted worktree gracefully", async () => {
      const wt = (await createWorktree(pi, repoDir, "gone-1"))!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = await cleanupWorktree(pi, repoDir, wt);
      expect(result.hasChanges).toBe(false);
      expect(result.path).toBeUndefined();
    });

    it("falls back to pruning when `git worktree remove` fails on a clean worktree", async () => {
      // Removal failing is not fatal — the registration is pruned instead, and
      // the caller still hears that there were no changes.
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi((args) => args[0] === "worktree" && args[1] === "remove", {
        code: 1,
        killed: false,
      });

      const result = await cleanupWorktree(failing, repoDir, wt);

      expect(result.hasChanges).toBe(false);
      expect(
        vi
          .mocked(failing.exec)
          .mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune"),
      ).toBe(true);
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt.path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* ignore */
      }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject on a clean repo", async () => {
      await expect(pruneWorktrees(pi, repoDir)).resolves.toBeUndefined();
    });

    it("does not reject on non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(pruneWorktrees(pi, nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

// cleanupWorktree's outer catch is the only place in the repo where a caught
// error could DESTROY user work while reporting success-shaped output. The new
// contract makes that impossible by construction: any unexpected git failure
// during evaluation keeps the worktree rather than removing it.
describe("cleanupWorktree — failure path", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });
  afterEach(async () => {
    try {
      await pruneWorktrees(pi, repoDir);
    } catch {
      /* ignore */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("keeps the worktree when `git status` fails unexpectedly", async () => {
    const wt = (await createWorktree(pi, repoDir, "status-fails"))!;

    const result = await cleanupWorktree(
      failingPi((args) => args[0] === "status", { code: 1, killed: false }),
      repoDir,
      wt,
    );

    expect(result.hasChanges).toBe(true);
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);

    try {
      execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
    } catch {
      /* ignore */
    }
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });

  it("keeps the worktree when it is corrupted (git cannot operate in it)", async () => {
    const wt = (await createWorktree(pi, repoDir, "corrupt"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    // Break the worktree's link back to the repo.
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    const result = await cleanupWorktree(pi, repoDir, wt);

    expect(result.hasChanges).toBe(true);
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
  });
});

/**
 * The stale-worktree sweep (`pruneWorktrees`). Only `pi-agent-*` worktrees
 * under tmpdir are candidates, and every one of locked / young / dirty /
 * unreachable has to independently veto removal, or a sweep bug could delete
 * someone's only copy of real work.
 */
describe("pruneWorktrees — TTL sweep", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });
  afterEach(async () => {
    try {
      await pruneWorktrees(pi, repoDir);
    } catch {
      /* ignore */
    }
    setWorktreeCleanupPeriodDays(30);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("removes an old, unlocked, clean, reachable worktree", async () => {
    setWorktreeCleanupPeriodDays(0); // 0 days: "old enough" the instant it exists
    const wt = (await createWorktree(pi, repoDir, "sweep-old"))!;
    execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(wt.path)).toBe(false);
    expect(listWorktreeLocks(repoDir).has(basename(wt.path))).toBe(false);
  });

  it("keeps a worktree younger than the cleanup period", async () => {
    // Default period (30 days) — a worktree created moments ago is never old enough.
    const wt = (await createWorktree(pi, repoDir, "sweep-young"))!;
    execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(wt.path)).toBe(true);
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });

  it("keeps a dirty worktree regardless of age", async () => {
    setWorktreeCleanupPeriodDays(0);
    const wt = (await createWorktree(pi, repoDir, "sweep-dirty"))!;
    execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(wt.path, "leftover.txt"), "still here");

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(wt.path)).toBe(true);
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });

  it("keeps a locked worktree regardless of age", async () => {
    setWorktreeCleanupPeriodDays(0);
    const wt = (await createWorktree(pi, repoDir, "sweep-locked"))!;
    // Left locked — as it would be for the duration of a real run.

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(wt.path)).toBe(true);
    expect(listWorktreeLocks(repoDir).get(basename(wt.path))).toBe(true);
    execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });

  it("keeps a clean, old, unlocked worktree whose HEAD isn't reachable from any branch", async () => {
    setWorktreeCleanupPeriodDays(0);
    const wt = (await createWorktree(pi, repoDir, "sweep-unreachable"))!;
    execFileSync("git", ["worktree", "unlock", wt.path], { cwd: repoDir, stdio: "pipe" });
    // A commit on top of a detached HEAD, with no branch ever pointing at it —
    // "clean" per status --porcelain, but its tip is an orphan.
    writeFileSync(join(wt.path, "orphan.txt"), "unreachable work");
    execFileSync("git", ["add", "orphan.txt"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "orphan commit"], { cwd: wt.path, stdio: "pipe" });

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(wt.path)).toBe(true);
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt.path], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });

  it("unlocks and prunes a locked registration whose directory is already gone (crash recovery)", async () => {
    setWorktreeCleanupPeriodDays(0);
    const wt = (await createWorktree(pi, repoDir, "sweep-crash"))!;
    // Simulate a hard crash: the directory is gone, but git's registration —
    // still locked — survives in .git/worktrees.
    rmSync(wt.path, { recursive: true, force: true });
    expect(listWorktreeLocks(repoDir).get(basename(wt.path))).toBe(true);

    await pruneWorktrees(pi, repoDir);

    expect(listWorktreeLocks(repoDir).has(basename(wt.path))).toBe(false);
  });

  it("ignores a tmpdir worktree without the pi-agent- prefix", async () => {
    setWorktreeCleanupPeriodDays(0);
    const otherPath = mkdtempSync(join(tmpdir(), "manual-worktree-"));
    rmSync(otherPath, { recursive: true, force: true }); // worktree add wants a fresh path
    execFileSync("git", ["worktree", "add", "--detach", otherPath, "HEAD"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    await pruneWorktrees(pi, repoDir);

    expect(existsSync(otherPath)).toBe(true);
    try {
      execFileSync("git", ["worktree", "remove", "--force", otherPath], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      /* ignore */
    }
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). Its consumers —
 * agent-manager, both tool schemas, the invocation resolver — all mock this
 * module, so without this block the real singleton is never executed and its
 * default is never exercised. That default is what every "worktree isolation
 * still behaves as before" claim rests on.
 */
describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  // The switch gates callers; it deliberately does not disarm createWorktree
  // itself, so a caller that has already decided (agent-manager checks first)
  // still gets a real worktree rather than a silent no-op.
  it("does not disable createWorktree directly", async () => {
    const repoDir = initGitRepo();
    const pi = mockPi();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = await createWorktree(pi, repoDir, "switch-test");
      expect(wt).toBeDefined();
      await cleanupWorktree(pi, repoDir, wt!);
    } finally {
      await pruneWorktrees(pi, repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
