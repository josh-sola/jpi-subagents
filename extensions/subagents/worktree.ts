/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of
 * the repo. On completion, a clean worktree (no uncommitted changes, HEAD
 * unmoved) is removed. A worktree the agent left dirty is kept on disk
 * exactly as the agent left it — no auto-commit, no branch — and its path is
 * handed back so the caller can inspect or merge from it directly.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

/**
 * How many days an unlocked, clean, reachable `pi-agent-*` worktree may sit
 * in tmpdir before the sweep reclaims it. Default `30` (`worktreeCleanupPeriodDays`).
 */
let worktreeCleanupPeriodDays = 30;

export function setWorktreeCleanupPeriodDays(days: number): void {
  worktreeCleanupPeriodDays = days;
}

export function getWorktreeCleanupPeriodDays(): number {
  return worktreeCleanupPeriodDays;
}

export interface WorktreeCleanupResult {
  /** Whether the worktree was left with uncommitted changes or a moved HEAD. */
  hasChanges: boolean;
  /** Worktree path — set whenever the worktree was kept on disk. */
  path?: string;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout: number,
): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Copy untracked files matching `<topLevel>/.worktreeinclude` (gitignore
 * syntax) into the worktree at the same relative paths — e.g. a local `.env`
 * an agent needs but git never tracks. Enumerated via git rather than a
 * hand-written matcher, so the same engine that understands `.gitignore`
 * syntax decides what matches. Best-effort throughout: a missing file, a
 * permission error, anything — the worktree is still returned either way.
 */
async function applyWorktreeInclude(
  pi: ExtensionAPI,
  topLevel: string,
  worktreePath: string,
): Promise<void> {
  const includeFile = join(topLevel, ".worktreeinclude");
  if (!existsSync(includeFile)) return;

  try {
    const output = await git(
      pi,
      topLevel,
      ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude"],
      10000,
    );
    if (!output) return;

    for (const rel of output.split("\n").filter(Boolean)) {
      try {
        const src = join(topLevel, rel);
        const dest = join(worktreePath, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        chmodSync(dest, statSync(src).mode);
      } catch {
        // One file's failure doesn't cost the rest.
      }
    }
  } catch {
    // No .worktreeinclude support this run — the worktree is still usable.
  }
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree info, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  let topLevel: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    topLevel = realpathSync(await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000));
    subdir = relative(topLevel, realpathSync(cwd));
  } catch {
    return undefined;
  }

  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000);
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }

  // Locked while the agent works in it so the TTL sweep — which runs
  // independently of any particular run — can never reap a worktree still in
  // use. Best-effort: an older git without `worktree lock`, or any other
  // failure, must not fail creation.
  try {
    await git(pi, cwd, ["worktree", "lock", worktreePath], 5000);
  } catch {
    // Unlocked is the pre-existing behavior — the sweep's other checks
    // (mtime, status, reachability) still protect it.
  }

  await applyWorktreeInclude(pi, topLevel, worktreePath);

  return {
    path: worktreePath,
    baseSha,
    workPath: subdir ? join(worktreePath, subdir) : worktreePath,
  };
}

/**
 * Clean up a worktree after agent completion.
 *
 * - Clean (no uncommitted changes, HEAD unmoved): the worktree is removed.
 * - Dirty, or HEAD moved: the worktree is left on disk untouched — no `git
 *   add`, no commit, no branch — and its path is returned.
 * - On an unexpected git failure: the worktree is kept rather than
 *   force-removed. A worktree we can no longer confirm is clean might hold
 *   the only copy of the agent's work.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
): Promise<WorktreeCleanupResult> {
  // Best-effort: lets the sweep consider this worktree again once the run
  // that locked it is done, whether or not it's kept.
  try {
    await git(pi, cwd, ["worktree", "unlock", worktree.path], 5000);
  } catch {
    // Never locked, already unlocked, or the worktree is already gone.
  }

  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const status = await git(pi, worktree.path, ["status", "--porcelain"], 10000);
    if (!status) {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);
      if (currentSha === worktree.baseSha) {
        await removeWorktree(pi, cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    // Dirty, or HEAD moved — hand the worktree back as-is.
    return { hasChanges: true, path: worktree.path };
  } catch {
    return { hasChanges: true, path: worktree.path };
  }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
  } catch {
    // If git worktree remove fails, try pruning
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000);
    } catch {
      /* ignore */
    }
  }
}

interface RegisteredWorktree {
  path: string;
  head?: string;
  locked: boolean;
}

/** Parse `git worktree list --porcelain` into the fields the sweep needs. */
function parseWorktreeList(output: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false };
      entries.push(current);
    } else if (current) {
      if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
      else if (line === "locked" || line.startsWith("locked ")) current.locked = true;
    }
  }
  return entries;
}

/**
 * Reclaim `pi-agent-*` worktrees the normal hand-off left behind: old,
 * unlocked, clean copies nobody merged from, and crash leftovers where a
 * locked registration's directory is already gone. Never removes a worktree
 * that is locked (a run may still be using it), younger than
 * `cleanupPeriodDays`, dirty, or whose HEAD isn't reachable from any branch —
 * any of those could be the only copy of real work.
 */
async function sweepStaleWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  // git reports worktree paths resolved (macOS's tmpdir() sits behind a
  // /var → /private/var symlink), so the prefix check has to compare against
  // the resolved root or every candidate misses it silently.
  const tmpRoot = realpathSync(tmpdir());
  const cleanupPeriodMs = worktreeCleanupPeriodDays * 24 * 60 * 60 * 1000;

  const output = await git(pi, cwd, ["worktree", "list", "--porcelain"], 10000);
  const entries = parseWorktreeList(output);

  for (const entry of entries) {
    if (!entry.path.startsWith(tmpRoot)) continue;
    if (!basename(entry.path).startsWith("pi-agent-")) continue;

    if (!existsSync(entry.path)) {
      // Crash leftover: `git worktree prune` above skips locked entries even
      // with the directory gone, so unlock first and prune again.
      if (entry.locked) {
        try {
          await git(pi, cwd, ["worktree", "unlock", entry.path], 5000);
        } catch {
          /* ignore */
        }
        try {
          await git(pi, cwd, ["worktree", "prune"], 5000);
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    if (entry.locked) continue;

    let mtimeMs: number;
    try {
      mtimeMs = statSync(entry.path).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtimeMs < cleanupPeriodMs) continue;

    try {
      const status = await git(pi, entry.path, ["status", "--porcelain"], 10000);
      if (status) continue;
    } catch {
      continue;
    }

    if (!entry.head) continue;
    try {
      const containing = await git(pi, cwd, ["branch", "--contains", entry.head], 5000);
      if (!containing) continue;
    } catch {
      continue;
    }

    await removeWorktree(pi, cwd, entry.path);
  }
}

/**
 * Prune orphaned worktree registrations (crash recovery) and sweep stale
 * `pi-agent-*` worktrees past their TTL. Best-effort throughout — this runs
 * on session teardown and must never throw.
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch {
    /* ignore */
  }

  try {
    await sweepStaleWorktrees(pi, cwd);
  } catch {
    /* a stale copy is not worth losing agent output over */
  }
}
