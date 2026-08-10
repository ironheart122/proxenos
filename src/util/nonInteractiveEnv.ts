/**
 * Environment for every subprocess spawned on behalf of a delegation (worker,
 * orchestrator git operations, verification). Invariant: a delegation must
 * never be able to open an interactive prompt on the operator's terminal.
 *
 * GPG_TTY is dropped so gpg/pinentry cannot seize the controlling TTY. Commit
 * and tag signing are disabled via GIT_CONFIG_* overrides rather than
 * `git config` — linked worktrees share the main repository's .git/config, so
 * writing there would silently disable signing for the operator's own
 * checkout. Credential and ssh prompts are forced to fail fast instead of
 * blocking on input nobody is watching.
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_EDITOR: "true",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
  };
  delete env.GPG_TTY;
  return env;
}
