import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [, , artifact, signature, publicKey] = process.argv;
if (!artifact || !signature || !publicKey) {
  console.error("Usage: node scripts/verify-updater-signature.mjs <artifact> <signature> <public-key>");
  process.exit(2);
}

for (const file of [artifact, signature]) {
  if (!existsSync(file)) throw new Error(`Missing updater verification input: ${file}`);
}

const rawSignatureText = readFileSync(signature, "utf8");
const signatureText = rawSignatureText.trim();
if (/Your file was signed successfully|Public signature:|Make sure to include|\r|\n/.test(signatureText)) {
  throw new Error(`Updater signature is not a single clean payload: ${signature}`);
}
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText) || signatureText.length % 4 !== 0) {
  throw new Error(`Updater signature is not valid base64: ${signature}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifierManifest = path.join(scriptDir, "updater-signature-verifier", "Cargo.toml");
execFileSync("cargo", ["run", "--quiet", "--manifest-path", verifierManifest, "--", artifact, signature, publicKey], {
  stdio: "inherit",
});
