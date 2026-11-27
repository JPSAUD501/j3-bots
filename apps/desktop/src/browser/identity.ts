// SPDX-License-Identifier: AGPL-3.0-or-later
// The brand list follows Chromium's GenerateBrandVersionList, as T3 Code v0.1.13
// mirrors it in apps/desktop/src/preview/BrowserSession.ts (`lowEntropyClientHints`,
// MIT License, Copyright (c) 2026 T3 Tools Inc.; see apps/desktop/NOTICE).
// Changed here: the list carries the Google Chrome brand, as Chrome's own does, and
// the same list serves the request headers and the page's `navigator.userAgentData`.

// How the app's browser presents itself to sites (decision 0110): as Google
// Chrome of the version Electron's Chromium is, on the system it runs on,
// with nothing that names Electron or the app.

export type IdentityPlatform = "linux" | "darwin" | "win32";
export type IdentityArch = "x64" | "arm64";

/** One brand and its version, as `Sec-CH-UA` and `userAgentData.brands` list them. */
export interface Brand {
  readonly brand: string;
  readonly version: string;
}

/** What `Emulation.setUserAgentOverride` takes as `userAgentMetadata`. */
export interface UserAgentMetadata {
  readonly brands: ReadonlyArray<Brand>;
  readonly fullVersionList: ReadonlyArray<Brand>;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
  readonly bitness: string;
  readonly wow64: boolean;
  readonly formFactors: ReadonlyArray<string>;
}

export interface Identity {
  /** Chrome's reduced User-Agent: `Chrome/<major>.0.0.0`. */
  readonly userAgent: string;
  /** `navigator.platform`, as Chrome reports it on the system. */
  readonly navigatorPlatform: string;
  readonly metadata: UserAgentMetadata;
  /** The low-entropy hints Chrome sends on every navigation of a secure page. */
  readonly navigationHeaders: Readonly<Record<string, string>>;
}

const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];
/** The orders Chromium permutes three brands into, picked by the major version. */
const ORDERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

const brandsOf = (major: number, version: (brand: "grease" | "chrome") => string) => {
  const grease = `Not${GREASE_CHARS[major % 11]}A${GREASE_CHARS[(major + 1) % 11]}Brand`;
  const listed: ReadonlyArray<Brand> = [
    { brand: grease, version: version("grease") },
    { brand: "Chromium", version: version("chrome") },
    { brand: "Google Chrome", version: version("chrome") },
  ];
  const order = ORDERS[major % 6] ?? ORDERS[0];
  const placed: Array<Brand> = [];
  order?.forEach((position, index) => {
    const brand = listed[index];
    if (brand !== undefined) placed[position] = brand;
  });
  return placed;
};

const platformName = (platform: IdentityPlatform) =>
  platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";

/**
 * The system token of Chrome's reduced User-Agent, frozen per system: it
 * names neither the real version nor the processor, which the high-entropy
 * hints carry.
 */
const SYSTEM_TOKEN: Readonly<Record<IdentityPlatform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

const NAVIGATOR_PLATFORM: Readonly<Record<IdentityPlatform, string>> = {
  darwin: "MacIntel",
  win32: "Win32",
  linux: "Linux x86_64",
};

const quoted = (brands: ReadonlyArray<Brand>) =>
  brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");

/**
 * The identity of a browser built on Chromium `chromeVersion` (such as
 * `152.0.7977.169`), running on `platform` and `arch`. `platformVersion`
 * is what the system reports for the high-entropy hint, empty where Chrome
 * leaves it empty.
 */
export const identityOf = (input: {
  readonly chromeVersion: string;
  readonly platform: IdentityPlatform;
  readonly arch: IdentityArch;
  readonly platformVersion: string;
}): Identity => {
  const major = Number.parseInt(input.chromeVersion, 10);
  const greaseMajor = GREASE_VERSIONS[major % 3] ?? "8";
  const brands = brandsOf(major, (brand) => (brand === "grease" ? greaseMajor : String(major)));
  const fullVersionList = brandsOf(major, (brand) =>
    brand === "grease" ? `${greaseMajor}.0.0.0` : input.chromeVersion,
  );
  const platform = platformName(input.platform);
  return {
    userAgent: `Mozilla/5.0 (${SYSTEM_TOKEN[input.platform]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    navigatorPlatform: NAVIGATOR_PLATFORM[input.platform],
    metadata: {
      brands,
      fullVersionList,
      platform,
      platformVersion: input.platformVersion,
      architecture: input.arch === "arm64" ? "arm" : "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
      formFactors: ["Desktop"],
    },
    navigationHeaders: {
      "sec-ch-ua": quoted(brands),
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"${platform}"`,
    },
  };
};

/**
 * Whether Chromium sends client hints to `url`: only to a potentially
 * trustworthy origin, HTTPS or a loopback name.
 */
export const takesClientHints = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  if (protocol === "https:") return true;
  return (
    protocol === "http:" &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname))
  );
};

/**
 * The request headers of a navigation, with `identity`'s hints added where
 * Electron left them out: it sends them on subresources only, and some
 * sites compare the two. Null when nothing changes.
 */
export const withNavigationHints = (
  identity: Identity,
  request: {
    readonly url: string;
    readonly resourceType: string;
    readonly requestHeaders: Readonly<Record<string, string>>;
  },
): Record<string, string> | null => {
  if (request.resourceType !== "mainFrame" && request.resourceType !== "subFrame") return null;
  if (!takesClientHints(request.url)) return null;
  const present = Object.keys(request.requestHeaders).some(
    (name) => name.toLowerCase() === "sec-ch-ua",
  );
  if (present) return null;
  return { ...request.requestHeaders, ...identity.navigationHeaders };
};
