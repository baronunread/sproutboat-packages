# `@sproutboat/assets`

Static asset manifests, key resolution, and sprout-first routing rules,
shared by the edge asset server and the CLI.

```sh
bun add @sproutboat/assets
```

```ts
import { resolveAssetKey, walkAssets } from "@sproutboat/assets";

const files = walkAssets("web/dist");
const key = resolveAssetKey("/docs", (k) => k in files);
```

## API

- `walkAssets(directory)` inventories an asset directory into the file
  table (paths, hashes, sizes).
- `resolveAssetKey(path, has)` maps a request path to an asset key,
  honoring directory defaults and index files.
- `isSproutFirst(spec, pathname)` reports whether the handler sees a
  request before the asset server does, given the assets
  `runSproutFirst` spec.
- `contentType(name)` maps extensions to content types.
- Types: `AssetManifest`, `AssetFiles`, `AssetEntry`.
