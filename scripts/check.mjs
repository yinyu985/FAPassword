import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "dist", ".builds", "node_modules"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const files = await walk(root);
for (const file of files.filter((path) => [".js", ".mjs"].includes(extname(path)))) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
for (const file of files.filter((path) => extname(path) === ".sh")) {
  execFileSync("sh", ["-n", file], { stdio: "inherit" });
}
for (const file of files.filter((path) => extname(path) === ".py")) {
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file], {
    stdio: "inherit",
  });
}

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  ...manifest.content_scripts.flatMap((script) => script.js || []),
];
for (const relative of new Set(referenced)) await access(join(root, relative));

const localeNames = [manifest.default_locale, "zh_CN"];
const locales = new Map();
for (const locale of localeNames) {
  const messages = JSON.parse(await readFile(join(root, "_locales", locale, "messages.json"), "utf8"));
  locales.set(locale, messages);
  for (const key of ["extensionName", "extensionDescription", "openPopupCommand"]) {
    if (!messages[key]?.message) throw new Error(`missing locale key ${locale}.${key}`);
  }
}

const localeKeys = new Set([...locales.values()].flatMap((messages) => Object.keys(messages)));
for (const [locale, messages] of locales) {
  for (const key of localeKeys) {
    if (!messages[key]?.message) throw new Error(`locale catalogs disagree: missing ${locale}.${key}`);
  }
}

const localizedSources = await Promise.all(
  ["manifest.json", "src/popup.html", "src/popup.js", "src/content.js"].map((path) =>
    readFile(join(root, path), "utf8"),
  ),
);
const usedLocaleKeys = new Set();
for (const source of localizedSources) {
  for (const match of source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) usedLocaleKeys.add(match[1]);
  for (const match of source.matchAll(/data-i18n(?:-title|-aria-label)?="([A-Za-z0-9_]+)"/g)) {
    usedLocaleKeys.add(match[1]);
  }
  for (const match of source.matchAll(/\b(?:t|tr)\(\s*"([A-Za-z0-9_]+)"/g)) usedLocaleKeys.add(match[1]);
}
for (const key of usedLocaleKeys) {
  for (const [locale, messages] of locales) {
    if (!messages[key]?.message) throw new Error(`localized UI uses missing key ${locale}.${key}`);
  }
}

const content = await readFile(join(root, "src", "content.js"), "utf8");
if (/content script v\d/i.test(content)) throw new Error("content script contains a hard-coded version");

console.log(`Checked ${files.length} files and ${new Set(referenced).size} manifest resources.`);
