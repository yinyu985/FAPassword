// Browser suite. It builds test extensions and starts the local fixture server itself.
// It never installs or downloads a browser; see README.md for the explicit prerequisite.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
await import("./e2e-playwright.mjs"); // fail before starting anything if the caller did not provide Playwright

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";
const drivers = [
  ["UI suite (login/OTP/forum, offer flow)", "drive.mjs"],
  ["Adversarial field classification", "drive-adversarial.mjs"],
  ["Combined positive/negative testbench", "drive-bench.mjs"],
  ["Fill targets the acted-on form", "drive-anchor.mjs"],
  ["Dropdown reappears after click-away", "drive-clickback.mjs"],
  ["Input/change events fire on fill", "drive-events.mjs"],
  ["Hidden password fields remain empty", "drive-clickjack.mjs"],
  ["Multi-account chooser", "drive-multi.mjs"],
  ["Page cannot read the closed-shadow account list", "drive-privacy.mjs"],
  ["Scripted submit cannot trigger save", "drive-save-intent.mjs"],
  ["Same-origin iframe login", "drive-iframe.mjs"],
  ["Cross-origin iframe gets no offer", "drive-xorigin.mjs"],
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("close", (code) => resolve({ code, output }));
  });
}

let server;
async function ensureServer() {
  try {
    const response = await fetch(`${base}/index.html`);
    if (response.ok) return;
  } catch {}
  if (process.env.FAPASSWORD_BASE) throw new Error(`Harness server is unavailable at ${base}`);
  server = spawn("python3", ["-m", "http.server", "8799", "--bind", "127.0.0.1"], {
    cwd: join(here, ".."),
    stdio: "ignore",
  });
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`${base}/index.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out starting the local test server");
}

try {
  await ensureServer();
  const build = await run("build-test-extensions.mjs");
  if (build.code !== 0) throw new Error(build.output || "mock extension build failed");

  let passed = 0;
  const failures = [];
  console.log("Running FAPassword browser suite\n" + "=".repeat(50));
  for (const [name, file] of drivers) {
    process.stdout.write(`\n▶ ${name}\n`);
    const { code, output } = await run(file);
    const summary = (output.match(/====.*====|PASS .*|FAIL .*/g) || []).slice(-1)[0] || "(no summary)";
    if (code === 0) {
      passed++;
      console.log(`  PASS ${summary.trim()}`);
    } else {
      failures.push(name);
      console.log(`  FAIL (exit ${code})`);
      console.log(output.split("\n").filter((line) => /FAIL|Error|throw/.test(line)).slice(0, 8).join("\n"));
    }
  }
  console.log(`\n${passed}/${drivers.length} browser suites passed`);
  if (failures.length) {
    console.log("FAILED: " + failures.join(", "));
    process.exitCode = 1;
  }
} finally {
  if (server) server.kill();
}
