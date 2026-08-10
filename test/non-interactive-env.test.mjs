import assert from "node:assert/strict";
import test from "node:test";
import { nonInteractiveEnv } from "../dist/util/nonInteractiveEnv.js";

test("drops GPG_TTY and disables signing without touching git config", () => {
  process.env.GPG_TTY = "/dev/pts/0";
  try {
    const env = nonInteractiveEnv();
    assert.equal("GPG_TTY" in env, false);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_KEY_0, "commit.gpgsign");
    assert.equal(env.GIT_CONFIG_VALUE_0, "false");
    assert.equal(env.GIT_CONFIG_KEY_1, "tag.gpgsign");
    assert.equal(env.GIT_CONFIG_VALUE_1, "false");
  } finally {
    delete process.env.GPG_TTY;
  }
});

test("preserves the rest of the caller's environment", () => {
  process.env.PROXENOS_TEST_MARKER = "keep-me";
  try {
    assert.equal(nonInteractiveEnv().PROXENOS_TEST_MARKER, "keep-me");
  } finally {
    delete process.env.PROXENOS_TEST_MARKER;
  }
});
