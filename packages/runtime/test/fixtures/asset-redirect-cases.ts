/** What a `_redirects` matcher must answer, from Cloudflare's rules engine: [file text, request path, [status, location] or null]. */
export type RedirectCase = [text: string, path: string, want: [status: number, location: string] | null];

export const REDIRECT_CASES: RedirectCase[] = [
  ["/compare /compare/ 308", "/compare", [308, "/compare/"]],
  ["/compare /compare/ 308", "/compare/", null],
  ["/compare/ /compare 308", "/compare/", [308, "/compare"]],
  ["/compare/ /compare 308", "/compare", null],
  ["/user/:id /profile/:id", "/user/42", [302, "/profile/42"]],
  ["/user/:id /profile/:id", "/user/42/", null],
  ["/user/:id /profile/:id", "/user/", null],
  ["/user/:id /profile/:id", "/user", null],
  ["/blog/* /posts/:splat 301", "/blog/", [301, "/posts/"]],
  ["/blog/* /posts/:splat 301", "/blog", null],
  ["/blog/* /posts/:splat 301", "/blog/a/b/", [301, "/posts/a/b/"]],
  ["/a/*/c /x/:splat", "/a/b/b2/c", [302, "/x/b/b2"]],
  ["/a/*/c /x/:splat", "/a/c", null],
  ["/:lang/docs /docs/:lang 301", "/fr/docs", [301, "/docs/fr"]],
  ["/:lang/docs /docs/:lang 301", "/fr/docs/", null],
  ["/files/:name.html /pages/:name", "/files/about.html", [302, "/pages/about"]],
  ["/:a-:b /x/:b/:a", "/one-two", [302, "/x/two/one"]],
  ["/:a/:a /x", "/p/p", null],
  ["/*/*/ /x", "/a/b/", null],
  ["/a:1 /b", "/a:1", [302, "/b"]],
  ["/blog/* /dynamic/:splat\n/blog/old /static\n/blog/old /static-2", "/blog/old", [302, "/static"]],
  ["/blog/* /dynamic/:splat\n/blog/old /static", "/blog/new", [302, "/dynamic/new"]],
  ["/x/:a /first\n/x/:b /second", "/x/1", [302, "/first"]],
];
