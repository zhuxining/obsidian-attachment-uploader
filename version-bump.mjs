import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error(
    "version-bump.mjs 必须由 `npm version <patch|minor|major>` 触发，否则 npm_package_version 未设置，会写坏 manifest.json/versions.json。",
  );
  process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
