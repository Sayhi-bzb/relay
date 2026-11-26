# Relay site

Reading frontend adapted from Cell Blog: Astro provides routes and metadata; the visible page is a React Cell UI document surface with Fusion Pixel, Maple fallback, selection, theme switching, and a responsive table of contents.

For what each reading feature helps readers understand, see the [reading feature map](docs/reading-feature-map.md).

```sh
npm ci
npm run dev
```

The local site uses `http://localhost:4321`. `npm run build` generates `dist/`; `npm run preview` serves that build. Set `SITE_URL` when building for a different origin.

The [source catalog](scripts/source-catalog.json) pairs saved captures with Relay workspaces. [sync-source.py](scripts/sync-source.py) extracts each article and converts it to Markdown before development and builds. `src/content/sources/` is generated and ignored.

[Cell Blog's compiler](src/lib/cell-document.ts) turns Markdown into document nodes. [sync-relay.mjs](scripts/sync-relay.mjs) exports the checked [Relay workspaces](../processing/docs/content-format.md) before development, tests, and builds. Source URL and original text must match the capture before views are connected. `src/data/relay/` is generated and ignored.

[Article images](src/components/cell/ArticleImage.tsx) occupy rows in the Cell layout and load directly from their source. Each chapter shares its original images between brief and interpretation. Original views place images at their source position. Click a picture to enlarge it over the blurred article and print its caption below. The [demo capture](../processing/cases/relay-demo/README.md) shows the source capture format.

Each item starts with its brief. Click its text to switch brief/interpretation; its separate original button returns to the prior view. Original/return controls appear on item hover or keyboard focus and remain visible on touch devices; their reserved space prevents layout shifts. Selection and keyboard controls remain available. Reading text is painted by Cell UI; Torph provides a temporary, pointer-transparent morph layer during view changes: shared characters move to their new positions, new characters print in reading order at their destination, and removed characters disappear immediately. Animated glyphs use the same Cell canvas renderer, font profile, and metrics as the reading surface to keep the final handoff aligned. Reduced-motion preference skips that layer. This follows Cell Blog's client-only rendering contract: the visible reading surface requires JavaScript.

`npm test` checks extraction, filtering, provenance, original text preservation, and Cell compilation. `npm run check` checks types. Code attribution is retained in [LICENSE.txt](LICENSE.txt); the Fusion font licenses are in [public/assets/fonts/fusion-mono/](public/assets/fonts/fusion-mono/).
