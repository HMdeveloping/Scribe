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
const slExplicitKeys = new Set();
for (const match of source.matchAll(/\bsl:\s*\{([\s\S]*?)\}/g)) {
  for (const keyMatch of match[1].matchAll(/(?:^|[,{])\s*([a-zA-Z0-9_]+):/g)) {
    slExplicitKeys.add(keyMatch[1]);
  }
}
const slCompletionBlock = source.match(/const slovenianCompletionTranslations: Partial<Dictionary> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
for (const keyMatch of slCompletionBlock.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm)) {
  slExplicitKeys.add(keyMatch[1]);
}
const slIntentionalEnglishKeys = new Set(["small", "medium", "largeV3Turbo", "largeV3"]);
const missingSlExplicitKeys = enKeys.filter((key) => !slExplicitKeys.has(key) && !slIntentionalEnglishKeys.has(key));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const usedKeys = new Set();
for (const file of sourceFiles(resolve(root, "src")).filter((file) => !file.includes("/src/i18n/index.ts"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\bt\("([^"]+)"\)/g)) {
    usedKeys.add(match[1]);
  }
}
const missingUsedKeys = [...usedKeys].filter((key) => !enKeys.includes(key));
const allowedLiteralPatterns = [
  /^Scribe$/,
  /^Audio$/,
  /^General$/,
  /^Transcription$/,
  /^Appearance$/,
  /^Storage$/,
  /^About$/,
  /^Small$/,
  /^Medium$/,
  /^Large v3/,
  /^FFmpeg/,
  /^Whisper/,
  /^whisper/,
  /^audio\//,
  /^recording-/,
  /^import-/,
  /^whisper-/,
  /^model_/,
  /^[a-z0-9_-]+$/,
  /^#[0-9a-fA-F]+$/,
  /^\.[a-z0-9_-]+$/,
];

const userFacingAttributes = new Set(["aria-label", "title", "placeholder"]);
const suspiciousLiterals = [];
for (const file of sourceFiles(resolve(root, "src")).filter((file) => !file.includes("/src/i18n/index.ts"))) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^\s*(import|export type|type|const .*=\s*\[|\/\/|\*)/.test(line)) return;
    if (line.includes("console.") || line.includes("throw new Error") || line.includes("new Error(")) return;
    for (const match of line.matchAll(/(?<![\w])([a-zA-Z-]+)=["']([^"']*[A-Za-z][^"']*)["']/g)) {
      const [, attr, literal] = match;
      if (!userFacingAttributes.has(attr)) continue;
      if (literal.includes("{") || allowedLiteralPatterns.some((pattern) => pattern.test(literal))) continue;
      suspiciousLiterals.push(`${file}:${index + 1}: ${attr}="${literal}"`);
    }
    if (/<[A-Z][A-Za-z0-9.]*|<[a-z][a-z0-9-]*(\s|>)/.test(line) && !line.includes("=>")) {
      for (const match of line.matchAll(/>\s*([^<{]*[A-Za-z][^<{]*)\s*</g)) {
        const literal = match[1].trim();
        if (/[?:|=]/.test(literal)) continue;
        if (!literal || literal.includes("{") || allowedLiteralPatterns.some((pattern) => pattern.test(literal))) continue;
        suspiciousLiterals.push(`${file}:${index + 1}: text="${literal}"`);
      }
    }
  });
}

if (missingLocales.length || extraLocales.length || missingUsedKeys.length || missingSlExplicitKeys.length || suspiciousLiterals.length) {
  console.error("i18n audit failed");
  if (missingLocales.length) console.error(`Missing locales: ${missingLocales.join(", ")}`);
  if (extraLocales.length) console.error(`Unexpected locales: ${extraLocales.join(", ")}`);
  if (missingUsedKeys.length) console.error(`Used keys missing from English dictionary: ${missingUsedKeys.join(", ")}`);
  if (missingSlExplicitKeys.length) console.error(`Slovenian keys falling back to English: ${missingSlExplicitKeys.join(", ")}`);
  if (suspiciousLiterals.length) {
    console.error("Possible hardcoded app-facing strings:");
    for (const literal of suspiciousLiterals) console.error(`  ${literal}`);
  }
  process.exit(1);
}

console.log(`i18n audit passed: ${requiredLocales.length} locales, ${enKeys.length} base keys, ${usedKeys.size} statically referenced keys, ${suspiciousLiterals.length} suspicious literals, ${missingSlExplicitKeys.length} Slovenian fallbacks.`);
