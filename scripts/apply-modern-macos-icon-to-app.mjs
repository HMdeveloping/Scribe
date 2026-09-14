import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultAppPath = path.join(repoRoot, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "Scribe.app");
const defaultCompiledDir = path.join(repoRoot, "src-tauri", "target", "modern-macos-icon");
const appIconName = "Scribe";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function requirePath(label, filePath) {
  try {
    const fileStats = await stat(filePath);
    if (fileStats.isFile() && fileStats.size <= 0) {
      throw new Error(`${label} is empty: ${filePath}`);
    }
    return fileStats;
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function plistValue(infoPlist, key) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, infoPlist], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Unable to read ${key} from ${infoPlist}`));
      }
    });
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const appPath = path.resolve(argValue("--app", defaultAppPath));
  const compiledDir = path.resolve(argValue("--compiled", defaultCompiledDir));
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const assetsCar = path.join(compiledDir, "Assets.car");
  const generatedIcns = path.join(compiledDir, `${appIconName}.icns`);

  const appStats = await requirePath("Scribe.app", appPath);
  if (!appStats.isDirectory()) {
    throw new Error(`Scribe.app is not a directory: ${appPath}`);
  }
  await requirePath("Info.plist", infoPlist);
  await requirePath("Compiled Assets.car", assetsCar);
  await requirePath("Generated legacy ICNS", generatedIcns);

  await copyFile(assetsCar, path.join(resourcesDir, "Assets.car"));
  await copyFile(generatedIcns, path.join(resourcesDir, `${appIconName}.icns`));

  await run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIconFile ${appIconName}`, infoPlist]);
  await run("/usr/libexec/PlistBuddy", ["-c", `Delete :CFBundleIconName`, infoPlist]).catch(() => {});
  await run("/usr/libexec/PlistBuddy", ["-c", `Add :CFBundleIconName string ${appIconName}`, infoPlist]);

  await requirePath("Applied Assets.car", path.join(resourcesDir, "Assets.car"));
  await requirePath("Applied Scribe.icns", path.join(resourcesDir, `${appIconName}.icns`));
  const bundleIconFile = await plistValue(infoPlist, "CFBundleIconFile");
  const bundleIconName = await plistValue(infoPlist, "CFBundleIconName");
  if (bundleIconFile !== appIconName) {
    throw new Error(`CFBundleIconFile is ${bundleIconFile}, expected ${appIconName}`);
  }
  if (bundleIconName !== appIconName) {
    throw new Error(`CFBundleIconName is ${bundleIconName}, expected ${appIconName}`);
  }

  console.log(`Applied modern macOS icon resources to ${appPath}`);
  console.log("IMPORTANT: run this before final app signing, updater archive creation, and DMG packaging.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
