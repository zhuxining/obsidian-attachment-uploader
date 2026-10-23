import { expect, test } from "vite-plus/test";

import { compileRemoteHostPrefixes, isOwnRemoteImageUrl } from "../src/upload/remoteImages";

test("matches exact origins and path directories", () => {
  const prefixes = compileRemoteHostPrefixes([
    "https://cdn.example/blog",
    "https://cdn.example/blog/",
    "bad",
    "ftp://cdn.example/",
  ]);
  expect(prefixes).toHaveLength(1);
  expect(isOwnRemoteImageUrl("https://cdn.example/blog/a.png?token=1", prefixes)).toBe(true);
  for (const url of [
    "https://cdn.example/blogger/a.png",
    "https://cdn.example.evil/blog/a.png",
    "http://cdn.example/blog/a.png",
    "https://cdn.example:8443/blog/a.png",
  ]) {
    expect(isOwnRemoteImageUrl(url, prefixes)).toBe(false);
  }
});

test("rejects credentials, queries and fragments in configured prefixes", () => {
  expect(
    compileRemoteHostPrefixes([
      "https://user:pass@cdn.example/",
      "https://cdn.example/?x=1",
      "https://cdn.example/#fragment",
    ]),
  ).toEqual([]);
  expect(isOwnRemoteImageUrl("invalid", compileRemoteHostPrefixes(["https://cdn.example/"]))).toBe(
    false,
  );
});
