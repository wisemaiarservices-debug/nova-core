import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cwd = resolve(process.argv[2] ?? ".");
const wranglerConfig = process.argv[3] ?? "wrangler.jsonc";
const expected = process.argv[4] ?? "rate-limit";
const port = Number(process.env.PORT ?? 8791);
const persistence = await mkdtemp(join(tmpdir(), "nova-rate-limit-proof-"));
const child = spawn(
  "uv",
  [
    "run",
    "--project",
    ".",
    "pywrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persistence,
    "--config",
    wranglerConfig,
  ],
  { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited early (${child.exitCode}):\n${output}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Wrangler did not become ready:\n${output}`);
}

try {
  const first = await waitForServer();
  const firstBody = await first.text();

  if (expected === "rate-limit") {
    assert.equal(first.status, 200, `first request should reach ASGI route: ${firstBody}`);
    assert.equal(firstBody, "route reached");
    const second = await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(10_000) });
    const secondBody = await second.text();
    assert.equal(second.status, 429, `second request should be rate limited: ${secondBody}`);
    assert.equal(secondBody, "rate limit exceeded");
    const third = await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(third.status, 429, "subsequent request should remain rate limited in the same window");
  } else {
    assert.equal(first.status, 503, `missing binding must fail closed: ${firstBody}`);
    assert.equal(firstBody, "rate limiter binding unavailable");
  }
} finally {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  if (child.exitCode === null) {
    signalGroup("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) {
    signalGroup("SIGKILL");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
    });
  }
  await rm(persistence, { recursive: true, force: true });
}
