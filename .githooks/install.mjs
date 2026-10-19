import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(root, ".git"))) {
  console.log("Git hooks skipped: this directory has no checkout metadata.");
} else {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const read = (...args) => {
    try {
      return git("config", ...args);
    } catch (error) {
      if (error.status === 1) return undefined;
      throw error;
    }
  };
  const hooks = read("--get", "core.hooksPath");
  if (hooks && resolve(root, hooks) !== join(root, ".githooks")) {
    throw new Error(
      "Existing core.hooksPath is in use; preserve it and integrate pre-push manually.",
    );
  }
  if (!hooks && existsSync(resolve(root, git("rev-parse", "--git-path", "hooks/pre-push")))) {
    throw new Error("An existing pre-push hook is in use; preserve it and integrate manually.");
  }
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  // Git requires these main-worktree settings to stop being shared when enabling worktree config.
  for (const key of ["core.worktree", "core.bare", "core.hooksPath"]) {
    const value = read("--local", "--get", key);
    if (value !== undefined) {
      git("config", "--file", join(common, "config.worktree"), key, value);
      git("config", "--local", "--unset-all", key);
    }
  }
  git("config", "--local", "extensions.worktreeConfig", "true");
  git("config", "--worktree", "core.hooksPath", ".githooks");
  console.log("Installed pre-push format/lint checks for this worktree.");
}
