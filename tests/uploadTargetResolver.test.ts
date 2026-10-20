import { describe, expect, test } from "vite-plus/test";

import {
  buildUpicDomainPrefix,
  compileRemoteHostPrefixes,
  isOwnRemoteImageUrl,
  isSupportedUpicVersion,
  parseRemoteHostPrefix,
  resolveUploadTarget,
  suggestPrefixFromSampleUrl,
  type ResolverIo,
  type UploadTargetReason,
} from "../src/services/uploadTargetResolver";

const APP = "/Applications/uPic.app";
const EXECUTABLE = `${APP}/Contents/MacOS/uPic`;
const COMMAND = `${EXECUTABLE} -o url -u %s`;
const INFO = `${APP}/Contents/Info.plist`;
const PREFS = "/home/user/Library/Preferences/com.svend.uPic.macos.plist";
const CONTAINER_PREFS =
  "/home/user/Library/Containers/com.svend.uPic.macos/Data/Library/Preferences/com.svend.uPic.macos.plist";

interface HostFixture {
  id: string;
  type: string | number;
  data: Record<string, unknown> | string;
  name?: string;
}

interface IoFixture {
  files?: Record<string, string>;
  plists?: Record<string, Record<string, unknown>>;
  command?: string;
  service?: "uPic" | "Picsee" | "custom";
  platform?: string;
}

function fakeIo(fixture: IoFixture = {}): ResolverIo {
  const files = new Map(Object.entries(fixture.files ?? {}));
  const plists = fixture.plists ?? {};
  const io: ResolverIo = {
    platform: fixture.platform ?? "darwin",
    homeDir: () => "/home/user",
    async statSize(path) {
      if (plists[path]) return 100;
      const value = files.get(path);
      return value === undefined ? null : value.length;
    },
    async exec(_executable, args) {
      const key = args[1];
      const path = args.at(-1)!;
      const value = plists[path]?.[key];
      if (value === undefined) return null;
      return typeof value === "string" ? `${value}\n` : JSON.stringify(value);
    },
    async realpath() {
      return null;
    },
  };
  return io;
}

function hostItems(...hosts: HostFixture[]): string[] {
  return hosts.map((host) =>
    JSON.stringify({
      id: host.id,
      name: host.name ?? "Host",
      type: host.type,
      data: typeof host.data === "string" ? host.data : JSON.stringify(host.data),
    }),
  );
}

function plist(defaultId: string, items: string[]) {
  return {
    uPic_DefaultHostId: defaultId,
    uPic_hostItems: items,
  };
}

function resolve(
  fixture: IoFixture,
  overrides: { command?: string; service?: "uPic" | "Picsee" | "custom" } = {},
) {
  return resolveUploadTarget({
    service: overrides.service ?? fixture.service ?? "uPic",
    command: overrides.command ?? fixture.command ?? COMMAND,
    io: fakeIo(fixture),
  });
}

function expectReason(
  result: { reason: UploadTargetReason | null; prefixes: string[] },
  reason: UploadTargetReason,
) {
  expect(result.reason).toBe(reason);
  expect(result.prefixes).toEqual([]);
}

describe("uPic read-only target detection", () => {
  test("selects the current default host and builds a bounded prefix", async () => {
    const result = await resolve({
      plists: {
        [INFO]: {
          CFBundleIdentifier: "com.svend.uPic.macos",
          CFBundleShortVersionString: "1.4.9",
        },
        [PREFS]: plist("default", [
          ...hostItems(
            {
              id: "other",
              type: "aliyun_oss",
              data: { domain: "https://other.example", saveKeyPath: "images/{year}/{random}" },
            },
            {
              id: "default",
              type: "aliyun_oss",
              data: { domain: "https://cdn.example.com/base", saveKeyPath: "blog/{year}/a.png" },
            },
          ),
        ]),
      },
    });
    expect(result.status).toBe("detected");
    expect(result.prefixes).toEqual(["https://cdn.example.com/base/blog/"]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.reason).toBeNull();
  });

  test("accepts legacy numeric host types and nested data strings", async () => {
    const result = await resolve({
      plists: {
        [INFO]: {
          CFBundleIdentifier: "com.svend.uPic.macos",
          CFBundleShortVersionString: "1.4.9",
        },
        [PREFS]: plist("1", [
          ...hostItems({
            id: "1",
            type: 4,
            data: JSON.stringify({
              domain: "https://cdn.example.com",
              saveKeyPath: "{year}/a.png",
            }),
          }),
        ]),
      },
    });
    expect(result.status).toBe("detected");
    expect(result.prefixes).toEqual(["https://cdn.example.com/"]);
  });

  test("uses the sandbox container preference path when needed", async () => {
    const result = await resolve({
      plists: {
        [INFO]: {
          CFBundleIdentifier: "com.svend.uPic.macos",
          CFBundleShortVersionString: "1.4.9",
        },
        [CONTAINER_PREFS]: plist("h", [
          ...hostItems({ id: "h", type: "s3", data: { domain: "https://s3.example.com/bucket" } }),
        ]),
      },
    });
    expect(result.prefixes).toEqual(["https://s3.example.com/bucket/"]);
  });

  test("resolves a configured uPic symlink before reading its bundle", async () => {
    const io = fakeIo({
      plists: {
        [INFO]: {
          CFBundleIdentifier: "com.svend.uPic.macos",
          CFBundleShortVersionString: "1.4.9",
        },
        [PREFS]: plist("h", [
          ...hostItems({ id: "h", type: "s3", data: { domain: "https://cdn.example.com" } }),
        ]),
      },
    });
    io.realpath = async (path) => (path === "/usr/local/bin/uPic" ? EXECUTABLE : null);
    const result = await resolveUploadTarget({
      service: "uPic",
      command: "/usr/local/bin/uPic -o url -u %s",
      io,
    });
    expect(result.status).toBe("detected");
    expect(result.prefixes).toEqual(["https://cdn.example.com/"]);
  });

  test.each<[string, IoFixture, UploadTargetReason]>([
    ["missing version", { plists: {} }, "app-missing"],
    [
      "unsupported version",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "2.0.0",
          },
        },
      },
      "unsupported-version",
    ],
    [
      "no preferences",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
        },
      },
      "preferences-unavailable",
    ],
    [
      "malformed host items",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
          [PREFS]: { uPic_DefaultHostId: "x", uPic_hostItems: "not-an-array" },
        },
      },
      "invalid-structure",
    ],
    [
      "default host missing",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
          [PREFS]: plist("missing", hostItems({ id: "a", type: "s3", data: {} })),
        },
      },
      "no-default-host",
    ],
    [
      "host without public domain",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
          [PREFS]: plist("a", hostItems({ id: "a", type: "s3", data: { domain: "" } })),
        },
      },
      "no-public-domain",
    ],
    [
      "dynamic provider without domain",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
          [PREFS]: plist("a", hostItems({ id: "a", type: "imgur", data: { domain: "" } })),
        },
      },
      "no-public-domain",
    ],
    [
      "shared host domain is too broad",
      {
        plists: {
          [INFO]: {
            CFBundleIdentifier: "com.svend.uPic.macos",
            CFBundleShortVersionString: "1.4.9",
          },
          [PREFS]: plist(
            "a",
            hostItems({
              id: "a",
              type: "github",
              data: { domain: "https://raw.githubusercontent.com" },
            }),
          ),
        },
      },
      "shared-host-too-broad",
    ],
  ])("degrades safely for %s", async (_label, fixture, reason) => {
    expect.hasAssertions();
    const result = await resolve(fixture);
    expectReason(result, reason);
  });

  test("does not return configuration secrets", async () => {
    const result = await resolve({
      plists: {
        [INFO]: {
          CFBundleIdentifier: "com.svend.uPic.macos",
          CFBundleShortVersionString: "1.4.9",
        },
        [PREFS]: plist("a", [
          ...hostItems({
            id: "a",
            type: "aliyun_oss",
            data: {
              domain: "https://cdn.example.com",
              saveKeyPath: "images/{year}",
              accessKey: "SECRET_ACCESS_KEY",
              secretKey: "SECRET_SECRET_KEY",
            },
          }),
        ]),
      },
    });
    expect(result.status).toBe("detected");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(Object.keys(result).sort()).toEqual([
      "appVersion",
      "fingerprint",
      "prefixes",
      "reason",
      "source",
      "status",
    ]);
  });

  test("rejects non-uPic commands and non-macOS platforms", async () => {
    expect.hasAssertions();
    expectReason(await resolve({}, { command: "/usr/local/bin/other %s" }), "not-upic");
    expectReason(await resolve({ platform: "win32" }), "not-macos");
    expectReason(await resolve({}, { service: "Picsee" }), "not-upic");
  });

  test("gates on a supported uPic version range", () => {
    expect(isSupportedUpicVersion("1.4.0")).toBe(true);
    expect(isSupportedUpicVersion("1.4.9")).toBe(true);
    expect(isSupportedUpicVersion("1.5.0")).toBe(true);
    expect(isSupportedUpicVersion("1.3.9")).toBe(false);
    expect(isSupportedUpicVersion("2.0.0")).toBe(false);
    expect(isSupportedUpicVersion("unknown")).toBe(false);
  });
});

describe("host prefix matching", () => {
  const prefix = parseRemoteHostPrefix("https://cdn.example.com/blog/")!;

  test.each([
    "https://cdn.example.com/blog/a.png",
    "https://cdn.example.com/blog/nested/a.png?token=1",
    "https://cdn.example.com/blog/",
  ])("covers %s", (url) => {
    expect(isOwnRemoteImageUrl(url, [prefix])).toBe(true);
  });

  test.each([
    "https://cdn.example.com/blog-other/a.png",
    "https://cdn.example.com/Blog/a.png",
    "http://cdn.example.com/blog/a.png",
    "https://cdn.example.com:8443/blog/a.png",
    "https://cdn.example.com.evil.test/blog/a.png",
    "https://cdn.example.com/other/a.png",
  ])("does not cover %s", (url) => {
    expect(isOwnRemoteImageUrl(url, [prefix])).toBe(false);
  });

  test("rejects credentials, queries, fragments and broad shared hosts", () => {
    expect(parseRemoteHostPrefix("https://user:pass@cdn.example.com/")).toBeNull();
    expect(parseRemoteHostPrefix("https://cdn.example.com/?a=1")).toBeNull();
    expect(parseRemoteHostPrefix("https://cdn.example.com/#x")).toBeNull();
    expect(parseRemoteHostPrefix("ftp://cdn.example.com/")).toBeNull();
    expect(parseRemoteHostPrefix("https://raw.githubusercontent.com/owner/")).toBeNull();
    expect(
      parseRemoteHostPrefix("https://raw.githubusercontent.com/owner/repo/main/"),
    ).not.toBeNull();
  });

  test("normalizes and deduplicates configured prefixes", () => {
    const prefixes = compileRemoteHostPrefixes([
      "https://cdn.example.com/blog",
      "https://cdn.example.com/blog/",
      "not a url",
      "https://raw.githubusercontent.com/owner/repo/main/",
    ]);
    expect(prefixes.map((item) => item.text)).toEqual([
      "https://cdn.example.com/blog/",
      "https://raw.githubusercontent.com/owner/repo/main/",
    ]);
  });

  test("builds domain and save-path prefixes", () => {
    expect(buildUpicDomainPrefix("https://cdn.example.com", "images/{year}/x.png")).toEqual({
      prefix: "https://cdn.example.com/images/",
    });
    expect(buildUpicDomainPrefix("https://cdn.example.com/base", "images/{year}")).toEqual({
      prefix: "https://cdn.example.com/base/images/",
    });
    expect(
      buildUpicDomainPrefix("https://raw.githubusercontent.com/owner/repo/main", "img/"),
    ).toEqual({
      prefix: "https://raw.githubusercontent.com/owner/repo/main/img/",
    });
    expect(buildUpicDomainPrefix("https://raw.githubusercontent.com", "{year}/x.png")).toEqual({
      reason: "shared-host-too-broad",
    });
    expect(buildUpicDomainPrefix("https://user:pass@cdn.example.com")).toEqual({
      reason: "no-public-domain",
    });
    expect(buildUpicDomainPrefix("https://cdn.example.com", "../{year}/x.png")).toEqual({
      reason: "invalid-structure",
    });
  });
});

describe("sample prefix suggestions", () => {
  test.each([
    ["https://cdn.example.com/blog/a.png", "https://cdn.example.com/blog/"],
    ["https://cdn.example.com/a.png", "https://cdn.example.com/"],
    ["https://cdn.example.com/blog/", "https://cdn.example.com/blog/"],
    [
      "https://raw.githubusercontent.com/owner/repo/main/a.png",
      "https://raw.githubusercontent.com/owner/repo/main/",
    ],
  ])("suggests a reviewable prefix for %s", (sample, expected) => {
    expect(suggestPrefixFromSampleUrl(sample)).toBe(expected);
  });

  test("ignores query parameters on a signed sample URL", () => {
    expect(suggestPrefixFromSampleUrl("https://cdn.example.com/blog/a.png?token=secret")).toBe(
      "https://cdn.example.com/blog/",
    );
  });

  test("refuses a sample that cannot identify a shared-host repository", () => {
    expect(suggestPrefixFromSampleUrl("https://raw.githubusercontent.com/a.png")).toBeNull();
    expect(suggestPrefixFromSampleUrl("https://user:pass@cdn.example.com/a.png")).toBeNull();
  });
});

test("does not infer a prefix from uPic's custom URL rules", async () => {
  expect.hasAssertions();
  const result = await resolve({
    plists: {
      [INFO]: {
        CFBundleIdentifier: "com.svend.uPic.macos",
        CFBundleShortVersionString: "1.4.9",
      },
      [PREFS]: plist("a", [
        ...hostItems({
          id: "a",
          type: "custom",
          data: {
            domain: "https://cdn.example.com",
            saveKeyPath: "img/",
            url: "https://api.example.com/upload",
          },
        }),
      ]),
    },
  });
  expectReason(result, "no-public-domain");
});
