# imgbae roadmap

The user-facing product should become useful **before** any advanced processing is added. Each milestone is independently reviewable.

## 1. Browse and view (first PR)
- [x] Filesystem root configuration, for local folders or mounted remote shares
- [x] Read-only folder browsing with paginated results
- [x] Image thumbnails and larger viewer, with keyboard navigation
- [x] Sort folder listings by name, modified date or file size (ascending or descending)
- [x] Basic image properties: dimensions, format, file size, modified date
- [ ] Authenticated LAN access / production packaging (separate follow-up)
- [x] Explicit private-interface LAN development binding; wildcard/public IP binding refused

## 2. Metadata and provenance
- [x] PNG ComfyUI metadata presence indicator in grid and viewer (recognized prompt or workflow field)
- [x] On-demand ComfyUI prompt/settings and node-type search (not yet SQLite-indexed)
- [x] Readable and raw embedded PNG text metadata inspection
- [ ] Reliable edit/derivation lineage (separate feature, not inferred from the metadata indicator)
- [ ] Inspect ComfyUI prompt and workflow metadata; export workflow JSON
- [ ] EXIF/IPTC/XMP and PNG metadata inspection
- [ ] SQLite catalog, search and metadata-based filters
- [ ] Provenance catalog distinct from mutable embedded metadata

## 3. Image management
- [ ] Rename, move, copy, and permanent delete (no trash), with explicit confirmation
- [ ] Metadata edit and selective/batch stripping via ExifTool
- [ ] Batch-job queue, cancellation, progress, and overwrite policies

## 4. Image conversion and resizing
- [ ] ImageMagick conversion between supported formats
- [ ] Conventional resize, resample and quality controls
- [ ] Metadata preservation and sidecar options, especially for ComfyUI PNGs

## 5. Automatic classification and categorization
- [ ] Analyze image content to suggest searchable categories and tags (e.g., subjects, visual style, medium, and user-defined categories)
- [ ] Support local, configurable classification models; make remote inference explicitly opt-in if added later
- [ ] Batch classify existing images and incrementally process new or changed images, with progress, cancellation, and reclassification
- [ ] Store predicted labels, confidence scores, and model/version provenance in the SQLite catalog, separate from embedded image metadata and user-curated labels
- [ ] Review, edit, accept, or reject suggested categories; manual overrides must survive rescans and model updates
- [ ] Browse, search, and filter by categories/tags without automatically renaming or moving source files

## 6. AI upscaling
- [ ] Selectable model registry (e.g., Real-ESRGAN-compatible models, 4× UltraSharp, NMKD Siax)
- [ ] GPU autodetection, compatible inference backend selection and CPU fallback
- [ ] VRAM-aware tiling, progress and cancellation
- [ ] Keep processing device independent of storage location

## Deferred: network shares
Local filesystem comes first. Network-mounted libraries still work through `IMGBAE_ROOT` but are untested and untuned. Handoff notes: [NETWORK_SHARES.md](NETWORK_SHARES.md).
- [ ] Visual QA on an actual network-mounted image collection
- [ ] Measure browse, sort and thumbnail latency on large shared folders
- [ ] Handle unavailable mounts and permission errors distinctly from unreadable files

### Decisions

- Frontend: React, TypeScript and Vite.
- API: Node.js and Fastify.
- Thumbnails: Sharp/libvips.
- Future metadata operations: ExifTool plus ComfyUI-specific parsing.
- Future conversion: ImageMagick.
- Future catalog: SQLite + FTS5.
- The first milestone does **not** need a database or GPU dependency.
