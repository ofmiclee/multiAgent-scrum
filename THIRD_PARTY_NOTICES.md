# Licenses and source attribution

Except where otherwise noted, project-owned source and documentation in this repository are licensed under [Apache-2.0](LICENSE), copyright 2026 ofmiclee and contributors. Third-party code and dependencies retain their own licenses; the project license does not replace them.

## shadcn/ui and Radix

`apps/account/ui/dropdown-menu.tsx` and `apps/account/ui/tooltip.tsx` adapt the corresponding files from [`shadcn-ui/ui`](https://github.com/shadcn-ui/ui/tree/c257f688cf4de7ec10cc1be84cad29cd4631182c/apps/v4/registry/new-york-v4/ui), commit `c257f688cf4de7ec10cc1be84cad29cd4631182c`. Copyright (c) 2023 shadcn, MIT. The wrappers retain only the components used here, import the individual Radix packages, and use this project's CSS instead of the upstream Tailwind classes. The original license is retained in [docs/licenses/shadcn-ui.txt](docs/licenses/shadcn-ui.txt).

The runtime uses `@radix-ui/react-dropdown-menu` 2.2.1 and `@radix-ui/react-tooltip` 1.4.1, MIT, copyright (c) 2022 WorkOS. Their transitive dependency notices are retained in [docs/licenses/dropdown-menu-dependencies.txt](docs/licenses/dropdown-menu-dependencies.txt). The frontend also serves these notices from `apps/account/public/shadcn-radix-notices.txt`.

## Icons

`apps/account/GitHubMark.tsx` uses the unchanged path geometry of GitHub Octicons [`mark-github-16.svg`](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg), wrapped in a React component with accessibility attributes. Copyright (c) 2026 GitHub Inc., MIT. The complete upstream license is retained in [docs/licenses/octicons.txt](docs/licenses/octicons.txt).

The UI also imports `lucide-react` 1.44.0. Copyright (c) 2026 Lucide Icons and Contributors, ISC; some icons derive from Feather, copyright (c) 2013-present Cole Bemis, MIT. Both notices are retained in [docs/licenses/lucide-react.txt](docs/licenses/lucide-react.txt).

The geometric primitives in `apps/account/Icons.tsx` and the artwork in `assets/multiagent-runner-icon.svg` are project-owned. No font files are bundled; the CSS uses locally available fonts and system fallbacks.

## Text, image and QR components

The editor uses Tiptap 3.31.3, MIT, copyright (c) 2025 Tiptap GmbH, and ProseMirror components, MIT, Marijn Haverbeke and contributors. Their notices are retained in [docs/licenses/tiptap-prosemirror.txt](docs/licenses/tiptap-prosemirror.txt).

Image processing uses sharp 0.35.4, Apache-2.0, copyright 2013 Lovell Fuller and others; see [docs/licenses/sharp.txt](docs/licenses/sharp.txt). Its native libvips dependencies have separate licenses, including LGPL-3.0-or-later. Native binaries are installed as dependencies and are not part of this source repository. Anyone distributing runtime packages must retain the applicable native dependency licenses and satisfy their redistribution terms.

QR rendering uses `qrcode.react` 4.2.0, ISC, copyright (c) 2015 Paul O'Shannessy, including QR Code Generator, MIT, copyright (c) Project Nayuki. See [docs/licenses/qrcode.react.txt](docs/licenses/qrcode.react.txt).

Other npm dependencies retain the license files distributed in their packages. Exact versions and integrity hashes are recorded in `package-lock.json`. In particular, the build toolchain includes MPL-2.0-licensed Lightning CSS; it is not relicensed by this repository.

## Implementation provenance

The board and card UI were independently implemented here with interaction references from dashi-taskboard commit `a421066cfed492d31aaa8f0a2e423107a15d474c`, whose Apache-2.0 text is retained in [docs/licenses/dashi-taskboard.txt](docs/licenses/dashi-taskboard.txt). No source snapshots, Linear/Codex glyphs, Figma assets or bundled fonts from that project are included.

Workflow design was informed by agent-scrum commit `e901b4cfc923d016c8841a658606ce955df02ea1` (MIT, copyright (c) 2026 Gad Benram) and the author's earlier MultiAgent-Scrum project. The executable TypeScript domain and workflow services were newly written for this repository; those reference repositories' source snapshots are not included.

`services/runner/redaction.mjs` originated in the author's FruitBuddy project, commit `8d2135532e05d2607ce23f77c2e08d99ada9ebde`, path `services/control-plane/src/redaction.mjs`. That file is published here under this repository's Apache-2.0 license. This grant covers the included file and does not grant a license to other FruitBuddy or legacy repository contents.

Codex, DSH and Claude Code are external execution providers. Their binaries, user profiles and account resources are not included in this source repository. Integration code does not change a provider's own license or service terms. Packaging an external provider requires retaining its applicable notices and following its redistribution terms.
