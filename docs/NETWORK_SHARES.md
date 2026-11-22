# Network shares — deferred handoff notes

**Deferred:** 2026-11-21, by the development director. Current work targets the local filesystem. Network-mounted libraries (NFS, SMB/CIFS, sshfs) still work the same way, by pointing `IMGBAE_ROOT` at the mount, but nobody has tested them or tuned imgbae for them. Don't add network-share checks to test plans or treat share performance as a blocker until this work resumes.

This document is the starting point for whoever picks that work back up.

## What already exists

- **Mount, don't proxy.** imgbae reads a mounted directory and runs nothing on the NAS. `IMGBAE_ROOT` is resolved with `realpath`, and every request path is checked to stay inside it.
- **Symlinks are skipped** in folder listings. The root itself may be a symlink.
- **Concurrency is capped** so a share isn't flooded with random reads. Each browse page stats and inspects at most 8 items at once (`mapLimited` in [server.ts](../apps/api/src/server.ts)).
- **ComfyUI metadata detection reads a bounded prefix** (at most 1 KiB per candidate chunk and 256 chunks, never pixel data). Results go in a process-local cache of 2048 entries keyed by path, size and mtime. See [COMFYUI_METADATA.md](COMFYUI_METADATA.md).

## Known cost points to measure first

1. **Browse** calls `readdir` on the whole folder, then `lstat` plus a metadata probe for each item on the requested page. A page is 96 gallery slots and four folders share a slot, so it holds at most 96 files or 384 folders (which need only the `lstat`).
2. **Date and size sorting** (PR #13) stats *every* entry in the folder, 16 at a time, before paging. Name sorting doesn't. This is the most likely slowdown on large shared folders.
3. **Thumbnails and previews** are re-encoded with Sharp on every request. There is no disk cache, only `Cache-Control: private, max-age=300`, so each cold gallery load reads every visible image in full over the network.
4. **The metadata cache** lives in memory, so it's empty again after every API restart.

## Open questions to verify on a real share

- How long the first page takes to load, and how long each later page takes, for folders with about 1k, 10k and 50k entries, in each sort mode.
- Whether mtime granularity and attribute caching (for example NFS `actimeo`, SMB `cache=`) make mtime-keyed caches or the "Date modified" sort stale or unstable.
- What happens when the mount drops mid-request. `EIO`, `ESTALE` and `EHOSTDOWN` currently fall through to a generic 500 ("Unable to read the requested file"), and the UI can't tell that apart from a bad file.
- Case-insensitive or case-preserving SMB names, and non-UTF-8 filenames.
- Permission-denied subfolders (`EACCES` is currently a 500, not a 403).

## Likely remedies (not decided)

- A persistent thumbnail cache on local disk, keyed by path, size and mtime.
- The planned SQLite catalog ([ROADMAP.md](ROADMAP.md), milestone 2), which would hold stat and metadata results so sorting and browsing don't re-stat the share.
- Streaming large directories with `opendir` instead of reading them whole with `readdir`.
- Clearer errors for unavailable mounts and permission problems.

Measure before choosing. Remedies from this list should come with numbers from a real share.
