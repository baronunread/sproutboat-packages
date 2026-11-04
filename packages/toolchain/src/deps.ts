import { join } from "node:path";

/**
 * Third-party C sources needed at build time, each pinned by the sha256 of its tarball (see `fetchPinned`).
 * The tarball is vendored in this repo (`vendor/bearssl/`) and read locally first, so a build does not
 * depend on a server; bearssl.org stays as the fallback (it returned HTTP 502 for hours on 2026-11-04).
 */
export const BEARSSL_COMMIT = "7bea48e5e850ab4cafbe68d3765cdaba13a86d6f";
export const BEARSSL_VERSION = BEARSSL_COMMIT.slice(0, 7);
/** sha256 of the gitweb snapshot tarball (`git archive` of BEARSSL_COMMIT; `git get-tar-commit-id` agrees). */
export const BEARSSL_SHA256 = "ed397832b1613582737d9c1ce01c1af74ad6a9e9c52a341e24433987cda0f372";
/** The vendored copy in this repository. Absent in a published package, where `fetchPinned` just skips it. */
export const BEARSSL_VENDORED_PATH = join(
  import.meta.dir,
  "../../../vendor/bearssl",
  `bearssl-${BEARSSL_VERSION}.tar.gz`,
);
export const BEARSSL_URLS = [`https://bearssl.org/gitweb/?p=BearSSL;a=snapshot;h=${BEARSSL_COMMIT};sf=tgz`] as const;
