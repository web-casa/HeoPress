# Third-Party Notices

This file lists third-party components bundled with HeoPress whose licenses
require a notice beyond the dependency list.

The upstream website, docs site and demo app that self-hosted OFL-1.1 fonts
(Archivo, Literata, DM Mono, Inter, Geist) were removed in P02; HeoPress ships
no bundled fonts at the moment.

## Dynamically linked LGPL libraries

HeoPress uses the following native libraries under the GNU Lesser General Public
License. They are shipped as separate shared libraries that `sharp` loads at run
time; HeoPress does not modify them, and you may replace them with a compatible
build of your own. Their license texts are included in the packages listed.

| Package | License | Source |
|---------|---------|--------|
| `@img/sharp-libvips-*` (libvips and its dependencies) | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |

## MPL-2.0 components

The Astro static engine's build toolchain (Vite 8) uses the following package
under the Mozilla Public License 2.0, a file-level copyleft licence. HeoPress
uses it unmodified; its source is available at the location below and its
license text is included in the package.

| Package | License | Source |
|---------|---------|--------|
| `lightningcss` and its platform binaries `lightningcss-*` | MPL-2.0 | <https://github.com/parcel-bundler/lightningcss> |
