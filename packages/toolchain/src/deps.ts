/**
 * Third-party C sources fetched at build time, each pinned by the sha256 of its tarball and listed
 * with ordered mirrors (see `fetchPinned`). Our own copy comes first so an upstream outage (bearssl.org
 * returned HTTP 502 for hours on 2026-11-04) does not stop a build; the upstream stays as the fallback.
 *
 * The first URL is a GitHub release asset: `gh release create deps-bearssl-7bea48e5 bearssl-7bea48e.tar.gz`
 * with the exact file whose sha256 is below. Anything else served there is rejected by the hash anyway.
 */
export const BEARSSL_COMMIT = "7bea48e5e850ab4cafbe68d3765cdaba13a86d6f";
export const BEARSSL_VERSION = BEARSSL_COMMIT.slice(0, 7);
/** sha256 of the gitweb snapshot tarball (`git archive` of BEARSSL_COMMIT; `git get-tar-commit-id` agrees). */
export const BEARSSL_SHA256 = "ed397832b1613582737d9c1ce01c1af74ad6a9e9c52a341e24433987cda0f372";
export const BEARSSL_URLS = [
  `https://github.com/baronunread/sproutboat-packages/releases/download/deps-bearssl-${BEARSSL_COMMIT.slice(0, 8)}/bearssl-${BEARSSL_VERSION}.tar.gz`,
  `https://bearssl.org/gitweb/?p=BearSSL;a=snapshot;h=${BEARSSL_COMMIT};sf=tgz`,
] as const;
