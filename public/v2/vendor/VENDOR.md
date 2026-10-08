# Vendored runtime for /v2

Approved 2026-10-05 (PM, option B in migration-plan.md §3): Preact + htm as pinned ESM files, loaded with the
import map in `public/v2/index.html`. No build step, no npm install in production. Do not edit these files;
to upgrade, replace them from the npm tarball and update this table (versions, integrity, sha256).

| file | package | version | taken from (inside the tarball) | sha256 of the file |
| --- | --- | --- | --- | --- |
| `preact.mjs` | `preact` | 11.0.0 | `package/dist/preact.mjs` | `7f8e0de60ede059be0e5ac12c79734a90840fb8a17b8b3282724433b6c4d8c61` |
| `preact-hooks.mjs` | `preact` (hooks) | 11.0.0 | `package/hooks/dist/hooks.mjs` | `6cb79fe9959ad185b8b86134aff47c12fd20216b24837597b19be59a133d9947` |
| `htm.mjs` | `htm` | 3.1.1 | `package/dist/htm.mjs` | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |
| `preact.mjs.map`, `hooks.mjs.map` | `preact` | 11.0.0 | `package/dist/`, `package/hooks/dist/` | source maps, devtools only |

Tarballs (`npm pack <pkg>@<version>`):

| package | npm `dist.integrity` | sha256 of the .tgz |
| --- | --- | --- |
| preact@11.0.0 | `sha512-LRTLKuSe6VYPhvBDjwFaX+nuZnpsw6IN2GSboisAvhGsncylBmrbDCERhgKDn6yP2mAwbGvsB5OVyTe33M8gBg==` | `37774f9b023f4012d30b15d469b641c9e74510c35d2f3d8393501db887fa3abd` |
| htm@3.1.1 | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` | `2425b9bee11409177bcabc7f32e319926fc6690c1701c0b257c88bdff2d5ba90` |
| lucide-static@1.52.0 | `sha512-0zZYihAze4ZmUCcyNa9OkWYqn/Y5f9AdTh02AZIxMtP5ravcTTfoSIAnUPBH6ZvKxt+ZW28JB0ldzLRyD82fcw==` | `4d2aa079171e4eba4c704844b8b0c9edb6e4cfb2fb8bd86f7b14353994f04a87` |

Import map (in `index.html`):

```json
{ "preact": "/v2/vendor/preact.mjs", "preact/hooks": "/v2/vendor/preact-hooks.mjs", "htm": "/v2/vendor/htm.mjs" }
```
`preact-hooks.mjs` imports the bare specifier `preact`, which the map resolves to the same module instance.
App code imports them only through `public/v2/lib.js`.

## Icons
Lucide icons are not vendored as a library: `design/scripts/build-icons.mjs` turns the chosen SVGs from
`lucide-static@1.52.0` into the inline sprite `public/v2/icons.js` (52 symbols, `#i-<name>`). To add an icon, add it to
the map in that script and run `node design/scripts/build-icons.mjs <extracted tarball>/package/icons`.

## Licences
`licenses/preact.LICENSE` (MIT), `licenses/htm.LICENSE` (Apache-2.0), `licenses/lucide.LICENSE` (ISC).
