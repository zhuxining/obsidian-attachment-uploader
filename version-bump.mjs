import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

// 兼容两种调用方式：
// 1) `npm version <x>` 触发时，npm 通过 npm_package_version 环境变量传入目标版本；
// 2) 直接 `node version-bump.mjs <x>` 或 `npm run version -- <x>` 时，版本号作为 argv 传入。
const targetVersion = process.env.npm_package_version ?? process.argv[2];
if (!targetVersion) {
  console.error(
    "version-bump.mjs 需要能解析到目标版本号：\n" +
      "  - 由 `npm version <版本号>` 触发（通过 npm_package_version 环境变量），或\n" +
      "  - 直接 `node version-bump.mjs <版本号>` 传入。",
  );
  process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
// 使用 2 空格缩进并保留末尾换行，与仓库既有文件风格一致（避免无谓的大 diff）
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

// stage the bumped files so `npm version` includes them in its release commit
execSync("git add manifest.json versions.json", { stdio: "inherit" });
