import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/i18n/index.ts"), "utf8");

const requiredLocales = ["sl", "en", "de", "es", "it", "hr", "fr", "pt", "nl", "pl"];
const languageBlock = source.match(/export const languages = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
const declaredLocales = [...languageBlock.matchAll(/code: "([^"]+)"/g)].map((match) => match[1]);
const missingLocales = requiredLocales.filter((locale) => !declaredLocales.includes(locale));
const extraLocales = declaredLocales.filter((locale) => !requiredLocales.includes(locale));

const enBlock = source.match(/const en = \{([\s\S]*?)\n\};/)?.[1] ?? "";
const enKeys = [...enBlock.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm)].map((match) => match[1]);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const usedKeys = new Set();
for (const file of sourceFiles(resolve(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\bt\("([^"]+)"\)/g)) {
    usedKeys.add(match[1]);
  }
}
const missingUsedKeys = [...usedKeys].filter((key) => !enKeys.includes(key));

if (missingLocales.length || extraLocales.length || missingUsedKeys.length) {
  console.error("i18n audit failed");
  if (missingLocales.length) console.error(`Missing locales: ${missingLocales.join(", ")}`);
  if (extraLocales.length) console.error(`Unexpected locales: ${extraLocales.join(", ")}`);
  if (missingUsedKeys.length) console.error(`Used keys missing from English dictionary: ${missingUsedKeys.join(", ")}`);
  process.exit(1);
}

console.log(`i18n audit passed: ${requiredLocales.length} locales, ${enKeys.length} base keys, ${usedKeys.size} statically referenced keys.`);
