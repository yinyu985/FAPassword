import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = [
  "crypto-vectors.test.mjs",
  "field-policy.test.mjs",
  "password-generator.test.mjs",
  "protocol-lifecycle.test.mjs",
  "security-contract.test.mjs",
  "pin-session.test.mjs",
];
let failed = 0;

for (const test of tests) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, test)], { stdio: "inherit" });
    child.on("close", resolve);
  });
  if (code !== 0) failed++;
}

process.exit(failed ? 1 : 0);
