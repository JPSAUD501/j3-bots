// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VerificationFailure } from "@j3-bots/contracts";

// Cases every verifier of a release runs, as data, so the server, the desktop
// app and the phone check the same bytes the same way. They are signed with a
// throwaway Ed25519 key made for them, whose private half was never kept: only
// its public key is here, and it is no release key.

/** The throwaway key's public half, which signed every signature here. */
export const TEST_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGYWUXVzOetxZ+qN76K9gWKN2vvVlC0tIY3Ul3Cj/JPc=\n-----END PUBLIC KEY-----";

/** The release the vectors are of. */
export const TEST_VERSION = "0.3.1";

/** Each file of the release, by name, with its contents. */
export const TEST_FILES: Readonly<Record<string, string>> = {
  "j3-bots-0.3.1-linux-x64.tar.gz": "the x64 server archive of 0.3.1\n",
  "j3-bots-0.3.1-linux-arm64.tar.gz": "the arm64 server archive of 0.3.1\n",
  "j3-bots-0.3.1-android-arm64.apk": "the Android app of 0.3.1\n",
  "J3-Bots-x64.AppImage": "the desktop app of 0.3.1\n",
  "install.sh": "#!/bin/sh\n",
};

const SUMS =
  "722646c61e1967ad9ef030a60996aed97541291127d75d509742ca865fd678be  j3-bots-0.3.1-linux-x64.tar.gz\nc88fd55d16dde2942b0fb236f6a6a883522fed27ec85f174477b30eb605b9f0b  j3-bots-0.3.1-linux-arm64.tar.gz\n5bd1accaf05b620913b4450ef0e81f7be7d76dac0dd49289c716062d3f1f109d  j3-bots-0.3.1-android-arm64.apk\nbfb73792e7f4e15a63fcc69c2168633243166182d030c3c3fa1fa4d89327fb3c  J3-Bots-x64.AppImage\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  install.sh\n";
const OLDER_SUMS =
  "1eed0803fc8bb5a7b9ecad5eddc1578cf911801b85122dbc7c0ca25eba9e8b3b  j3-bots-0.3.0-linux-x64.tar.gz\n9694381342d9c4394fd6974e984bc3fcf6d64d25ea1429fd38bc0ce17c306716  J3-Bots-x64.AppImage\n";
const MALFORMED_SUMS =
  "722646c61e1967ad9ef030a60996aed97541291127d75d509742ca865fd678be  j3-bots-0.3.1-linux-x64.tar.gz\nc88fd55d16dde2942b0fb236f6a6a883522fed27ec85f174477b30eb605b9f0b  j3-bots-0.3.1-linux-arm64.tar.gz\n5bd1accaf05b620913b4450ef0e81f7be7d76dac0dd49289c716062d3f1f109d  j3-bots-0.3.1-android-arm64.apk\nbfb73792e7f4e15a63fcc69c2168633243166182d030c3c3fa1fa4d89327fb3c  J3-Bots-x64.AppImage\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  install.sh\nnot a digest  j3-bots-0.3.1-linux-x64.tar.gz\n";

const BINARY_SUMS =
  "722646c61e1967ad9ef030a60996aed97541291127d75d509742ca865fd678be *j3-bots-0.3.1-linux-x64.tar.gz\nc88fd55d16dde2942b0fb236f6a6a883522fed27ec85f174477b30eb605b9f0b  j3-bots-0.3.1-linux-arm64.tar.gz\n5bd1accaf05b620913b4450ef0e81f7be7d76dac0dd49289c716062d3f1f109d  j3-bots-0.3.1-android-arm64.apk\nbfb73792e7f4e15a63fcc69c2168633243166182d030c3c3fa1fa4d89327fb3c  J3-Bots-x64.AppImage\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  install.sh\n";
const DOT_DOT_SUMS =
  "722646c61e1967ad9ef030a60996aed97541291127d75d509742ca865fd678be  j3-bots-0.3.1-linux-x64.tar.gz\nc88fd55d16dde2942b0fb236f6a6a883522fed27ec85f174477b30eb605b9f0b  j3-bots-0.3.1-linux-arm64.tar.gz\n5bd1accaf05b620913b4450ef0e81f7be7d76dac0dd49289c716062d3f1f109d  j3-bots-0.3.1-android-arm64.apk\nbfb73792e7f4e15a63fcc69c2168633243166182d030c3c3fa1fa4d89327fb3c  J3-Bots-x64.AppImage\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  install.sh\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  ..\n";
const UNTERMINATED_SUMS =
  "722646c61e1967ad9ef030a60996aed97541291127d75d509742ca865fd678be  j3-bots-0.3.1-linux-x64.tar.gz\nc88fd55d16dde2942b0fb236f6a6a883522fed27ec85f174477b30eb605b9f0b  j3-bots-0.3.1-linux-arm64.tar.gz\n5bd1accaf05b620913b4450ef0e81f7be7d76dac0dd49289c716062d3f1f109d  j3-bots-0.3.1-android-arm64.apk\nbfb73792e7f4e15a63fcc69c2168633243166182d030c3c3fa1fa4d89327fb3c  J3-Bots-x64.AppImage\na8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf  install.sh";

/** `SHA256SUMS.sig` files, base64 with a line break as `base64` writes it. */
const SIGNATURES = {
  good: "X1Nk8VwvIppnEDBYO+H8hCOricLYB8slx18sT+71Q4701Ueztop8mu0IPp9KCcYeacCG4naEPQX5zLZrjumgDw==\n",
  anotherKey:
    "YbegANxHR69HOqN3iZdYONplKwGBd5AMCLdOXeFPhw8jWCSmoOZJyoLB9MTjjMQ8bTuIn7PUZojJc/VOO/5jDg==\n",
  otherBytes:
    "tc8krQhxcrnlOzAnyH8CWk6LnNQX2yoUJq5tacdU9ApAyXQ+2nNlhm+r60kRjZ+o3HrB/k4YuxQqiuy55CwKAg==\n",
  older:
    "UDg2Wr5s6BTx0V2rmmbpKJ7ljC148HuVPOCUSp8whoIEjVOCRwSGCH1Qk8jN6NCoU+dfaNXRAGKdE0lRxxE4Dw==\n",
  malformed:
    "qz5/JHnSJQ5sU/Z3ZUnHWeQuJV7gPsp8rMAr42Qu0910Y8kP0SIJ0pdGGkrHcJaC1+2/Z/qEBKopnK3zkxcYCA==\n",
  binary:
    "s6YL2299r2aFpobMA5HEtc/2PVrfcHBBO/vyWLVdyV0Rs8mV9nza75vtoxBbUShzljBerNBTrk9VBdDqkBlRDw==\n",
  dotDot:
    "OPXUwvf+A/ww4Cg0zRSG1gF3iX9MzgQoGSMGBMpTIrnugxlGixd2uBKw16fuH4Es/4DamBz0HbkCqmAxD6Z5Ag==\n",
  unterminated:
    "ts8yRBEubmkHHHfES4A4mZDAEhExnG8Wwzxn+fF3npf0K82VV8hEbnn+3ug0VgdbNoAWJsLAFwpl+KRbucbMBg==\n",
};

/** One check of a release's `SHA256SUMS`, and of a file against it. */
export interface VerificationCase {
  readonly name: string;
  /** The release the files are said to be of. */
  readonly version: string;
  /** `SHA256SUMS` as text (UTF-8). */
  readonly sums: string;
  /** `SHA256SUMS.sig` as text; null when the release has none. */
  readonly signature: string | null;
  /** The file checked against the list once it verifies, and its contents. */
  readonly file: { readonly name: string; readonly contents: string };
  /** What the check ends with. */
  readonly expect: "verified" | VerificationFailure;
}

const x64 = "j3-bots-0.3.1-linux-x64.tar.gz";
const appImage = "J3-Bots-x64.AppImage";
const file = (name: string, contents = TEST_FILES[name] ?? "") => ({ name, contents });

export const VERIFICATION_CASES: ReadonlyArray<VerificationCase> = [
  {
    name: "a server archive that matches",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.good,
    file: file(x64),
    expect: "verified",
  },
  {
    name: "a desktop package that matches",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.good,
    file: file(appImage),
    expect: "verified",
  },
  {
    name: "a signature that is not base64",
    version: TEST_VERSION,
    sums: SUMS,
    signature: "not a signature\n",
    file: file(x64),
    expect: "signature-invalid",
  },
  {
    name: "a release without a signature",
    version: TEST_VERSION,
    sums: SUMS,
    signature: null,
    file: file(x64),
    expect: "signature-missing",
  },
  {
    name: "a signature by another key",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.anotherKey,
    file: file(x64),
    expect: "signature-invalid",
  },
  {
    name: "a signature over other bytes",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.otherBytes,
    file: file(x64),
    expect: "signature-invalid",
  },
  {
    name: "a list changed after it was signed",
    version: TEST_VERSION,
    sums: SUMS.replace("install.sh", "install.sh.old"),
    signature: SIGNATURES.good,
    file: file(x64),
    expect: "signature-invalid",
  },
  {
    name: "a signed list with a line that is not a digest",
    version: TEST_VERSION,
    sums: MALFORMED_SUMS,
    signature: SIGNATURES.malformed,
    file: file(x64),
    expect: "checksums-malformed",
  },
  {
    name: "a signed list with a line in binary mode",
    version: TEST_VERSION,
    sums: BINARY_SUMS,
    signature: SIGNATURES.binary,
    file: file(x64),
    expect: "checksums-malformed",
  },
  {
    name: "a signed list that names the parent folder",
    version: TEST_VERSION,
    sums: DOT_DOT_SUMS,
    signature: SIGNATURES.dotDot,
    file: file(x64),
    expect: "checksums-malformed",
  },
  {
    name: "a signed list whose last line has no line feed",
    version: TEST_VERSION,
    sums: UNTERMINATED_SUMS,
    signature: SIGNATURES.unterminated,
    file: file(x64),
    expect: "checksums-malformed",
  },
  {
    name: "an older release's signed list, replayed for this one",
    version: TEST_VERSION,
    sums: OLDER_SUMS,
    signature: SIGNATURES.older,
    file: file(appImage, "the desktop app of 0.3.0\n"),
    expect: "wrong-release",
  },
  {
    name: "a file the list does not name",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.good,
    file: file("J3-Bots-Setup.exe", "an installer\n"),
    expect: "entry-missing",
  },
  {
    name: "a file whose digest is not the listed one",
    version: TEST_VERSION,
    sums: SUMS,
    signature: SIGNATURES.good,
    file: file(x64, "a changed archive\n"),
    expect: "digest-mismatch",
  },
];
