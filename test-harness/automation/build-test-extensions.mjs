// mock extension variants for headless tests: copy real src/, swap helper-backed
// handlers for mocks so no macOS helper or real PIN needed. output to .builds/
//   node build-test-extensions.mjs
// builds:
//   unlocked - inlineLogins returns 1 login; inlineFill pushes mock cred
//   multi    - inlineLogins returns 2 logins (chooser test)
//   locked   - inlineLogins reports locked and beginUnlock returns a mock challenge

import { mkdir, rm, cp, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT = join(HERE, ".builds");

const KINDS = ["unlocked", "multi", "locked", "privacy"];

await rm(OUT, { recursive: true, force: true });
for (const kind of KINDS) {
  const dst = join(OUT, kind);
  await mkdir(dst, { recursive: true });
  for (const item of ["manifest.json", "src", "icons", "_locales"]) {
    await cp(join(REPO, item), join(dst, item), { recursive: true });
  }
  const bgPath = join(dst, "src", "background.js");
  const mock = (await readFile(join(HERE, "mock-background.js"), "utf8")).replace(
    "__FAPASSWORD_MOCK_KIND__",
    kind,
  );
  await writeFile(bgPath, mock);
  // Production deliberately uses a closed shadow root. Test builds open only that root and
  // tag the inner listbox so browser automation can inspect/click it.
  const contentPath = join(dst, "src", "content.js");
  let content = await readFile(contentPath, "utf8");
  if (kind !== "privacy") {
    content = content
      .replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })')
      .replace('box.setAttribute("role", "listbox");', 'box.setAttribute("role", "listbox");\n  box.setAttribute("data-fapassword", "suggestions");');
  }
  await writeFile(contentPath, content);
  console.log(`built ${kind} -> ${dst}`);
}
console.log("\nDone. Test builds are in test-harness/automation/.builds/");
