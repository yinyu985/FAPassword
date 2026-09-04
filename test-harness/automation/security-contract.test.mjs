import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../../manifest.json", import.meta.url), "utf8"));
const background = await readFile(new URL("../../src/background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../../src/content.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../../src/popup.js", import.meta.url), "utf8");
const checks = [
  ["no alarm/activeTab permission", !manifest.permissions.some((value) => ["alarms", "activeTab"].includes(value))],
  ["no MAIN-world passkey patch", !manifest.content_scripts.some((script) => script.world === "MAIN")],
  ["suggestions use a closed Shadow DOM", content.includes('attachShadow({ mode: "closed" })')],
  ["fills validate exact origin", content.includes("msg.expectedOrigin") && !content.includes("msg.expectedHost")],
  ["popup fill targets the top frame", /case "fillOnPage"[\s\S]*?sendFillToFrame\(\s*tab\.id,\s*0,/.test(background)],
  ["refresh targets its recorded frame", /case "refreshAndRefill"[\s\S]*?sendFillToFrame\(\s*tab\.id,\s*entry\.frameId \?\? 0,/.test(background)],
  ["popup sends no caller-controlled tab URL", !/fillOnPage[^\n]*tabId/.test(popup) && !/getLogins[^\n]*tabId/.test(popup)],
  ["deferred plaintext saves have an active expiry timer", /function retainPendingSave[\s\S]*?setTimeout/.test(background)],
  ["content memory retains password digests, not autofill/generated plaintext", !/lastAutofill\.password\b/.test(content) && !/lastGenerated\.password\b/.test(content)],
  ["stale inline fill responses are rejected", content.includes("msg.requestId !== fillRequestSeq")],
  ["dead background control messages are absent", !/case "(connect|disconnect|clearCache)"/.test(background)],
  ["locked-field click has a challenge fallback", content.includes('type: "beginUnlock"') && /case "beginUnlock"[\s\S]*?requestChallenge\(\{ ifNeeded: true \}\)/.test(background)],
  ["initial popup challenge errors are visible", /if \(!ch\?\.ok\)[\s\S]*?pinError\.hidden = false/.test(popup)],
];

for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
