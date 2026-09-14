import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bundleRoot = path.join(repoRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle");
const defaultAppPath = path.join(bundleRoot, "macos", "Scribe.app");
const defaultTarPath = path.join(bundleRoot, "macos", "Scribe.app.tar.gz");
const appIconName = "Scribe";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return output;
}

async function requireFile(label, filePath) {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
}

async function requireDir(label, dirPath) {
  const dirStats = await stat(dirPath);
  if (!dirStats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

function plistValue(infoPlist, key) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, infoPlist]).trim();
}

async function verifyApp(appPath) {
  await requireDir("Scribe.app", appPath);
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const executable = path.join(appPath, "Contents", "MacOS", "scribe-app");

  await requireFile("Assets.car", path.join(resourcesDir, "Assets.car"));
  await requireFile("Scribe.icns", path.join(resourcesDir, `${appIconName}.icns`));
  await requireFile("legacy icon.icns", path.join(resourcesDir, "icon.icns"));
  await requireFile("Info.plist", infoPlist);

  if (plistValue(infoPlist, "CFBundleIconName") !== appIconName) {
    throw new Error("CFBundleIconName is not Scribe");
  }
  if (plistValue(infoPlist, "CFBundleIconFile") !== appIconName) {
    throw new Error("CFBundleIconFile is not Scribe");
  }

  const fileOutput = run("file", [executable]);
  if (!fileOutput.includes("Mach-O") || !fileOutput.includes("arm64")) {
    throw new Error(`App executable is not arm64:\n${fileOutput}`);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  console.log(`PASS: verified final macOS app at ${appPath}`);
}

async function verifyTarball(tarPath) {
  await requireFile("updater app archive", tarPath);
  await requireFile("updater app archive signature", `${tarPath}.sig`);

  const tempDir = await mkdtemp(path.join(tmpdir(), "scribe-updater-verify-"));
  try {
    run("tar", ["-xzf", tarPath, "-C", tempDir]);
    await verifyApp(path.join(tempDir, "Scribe.app"));
    console.log(`PASS: verified updater archive at ${tarPath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const appPath = path.resolve(argValue("--app", defaultAppPath));
  const tarPath = path.resolve(argValue("--tar", defaultTarPath));
  await verifyApp(appPath);
  await verifyTarball(tarPath);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
