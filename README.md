# imgbae

**imgbae** is an image-first, self-hosted browser for local folders and mounted network shares.

## Milestone 1: browse and view

The first PR is deliberately **read-only**:

- Browse folders across one or more explicitly configured filesystem roots
- View a responsive image thumbnail grid and open a larger image preview
- See file sizes, modified times and image dimensions
- Move through image previews with the keyboard
- Page through large directories
- Show a ComfyUI metadata indicator for PNGs containing recognizable embedded prompt or workflow fields (read-only, bounded metadata reads)
- Inspect embedded PNG text metadata (readable or raw) and search the collection by ComfyUI prompt, sampler, scheduler, steps, CFG and node types (on-demand scan)

There is no delete, rename, write, upload or conversion API in milestone 1.

### Requirements

Node.js 22+ and a local or mounted directory containing images.

### Development

```sh
npm install
IMGBAE_ROOT=/absolute/path/to/images npm run dev
```

To keep your library folders in a config file, save an `imgbae.json` file with a `roots` object. Each key is the name shown in the library, and each value is an absolute folder path.

```json
{
  "host": "127.0.0.1",
  "port": 3001,
  "roots": {
    "ComfyUI outputs": "/absolute/path/to/output",
    "Archive": "/mnt/photos/archive"
  }
}
```

```sh
IMGBAE_CONFIG=/absolute/path/to/imgbae.json npm run dev
```

Restart Imgbae after editing the file. You can also set `IMGBAE_ROOTS` directly to the JSON object inside `roots`. For the folder list, `IMGBAE_ROOTS` takes precedence over `roots` in the file, followed by `IMGBAE_ROOT`.

Each named folder appears on the library home. ComfyUI metadata search covers all configured folders. Names are used in folder and image paths, so bookmarks follow the name even if the underlying folder moves. Keep using `IMGBAE_ROOT` to preserve existing single-folder bookmarks.

Open http://localhost:5173. The config file’s optional `host` and `port` set the API listen address and default to `127.0.0.1` and `3001`. `IMGBAE_HOST` and `IMGBAE_PORT` override those fields. The Vite frontend listens on `127.0.0.1:5173` by default and proxies `/api` to the effective API address.

To use the browser from another machine on your trusted home LAN, bind **only the frontend** to the server's specific private LAN IPv4 address:

```sh
IMGBAE_ROOT=/absolute/path/to/images IMGBAE_WEB_HOST=192.168.1.50 npm run dev
```

Replace `192.168.1.50` with the actual address on the machine running imgbae. From another LAN device, open `http://192.168.1.50:5173`. The API should remain bound to `127.0.0.1`; only port 5173 needs to be reachable across the trusted LAN. Configure any host firewall to allow it **only from the trusted local subnet**.

The server refuses wildcard (`0.0.0.0`) and public-IP bindings for both API and development frontend. These checks reduce accidental exposure, but **cannot defeat router port-forwarding, a publicly reachable reverse proxy, a tunnel, or an insecure host firewall**. Do not enable those routes. The initial read-only app has no authentication, so every permitted LAN user can view the library. Require authentication and authorization **before** enabling rename, move, delete or metadata writes. See [network-access guidance](docs/NETWORK_ACCESS.md).

If your images live on another LAN machine, **mount the remote share** on the machine running the API (NFS, SMB/CIFS, sshfs, etc.), then configure the mount in your config file, `IMGBAE_ROOTS`, or `IMGBAE_ROOT`. The app does not require an agent on your NAS. Current development targets local disks, so share performance hasn't been tested yet; see [docs/NETWORK_SHARES.md](docs/NETWORK_SHARES.md).

When upgrading an existing deployment, update its exported configuration variables to the `IMGBAE_` names; the previous names are no longer recognized.

### Local image descriptions

Run Ollama on the same machine as the imgbae API and install the default vision model with `ollama pull qwen3-vl:4b`. To use a different installed vision model, set `IMGBAE_VISION_MODEL` in the API environment and restart imgbae.

Open an image and click **Generate description** in the inspector. The API sends an oriented JPEG preview (up to 1280 px on each side) to Ollama at `127.0.0.1:11434`. Animated and multipage images use the first frame or page. The caption stays in the open viewer and the original file is untouched.

Optional API environment variables: `IMGBAE_PORT=3001`, `IMGBAE_HOST=127.0.0.1`. Prefer keeping the API on loopback and using the web proxy for trusted-LAN access. Do **not** expose the unauthenticated API or development server to the internet or an untrusted LAN. Authentication and production deployment are separate milestones. Prefer an SSH tunnel for remote access outside your home LAN.

### Build

```sh
npm ci
npm run typecheck
npm run test
npm run build
```

Build output is not yet a bundled production deployment; this first milestone is aimed at local development and review.

## Roadmap

See [docs/COMFYUI_METADATA.md](docs/COMFYUI_METADATA.md) for how the embedded ComfyUI metadata indicator works and its detection limits. See [docs/AI_DEVELOPMENT.md](docs/AI_DEVELOPMENT.md) for decision and review evidence.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the explicitly staged features, including ComfyUI metadata indicators, metadata management, ImageMagick conversion, resizing, and GPU-accelerated AI upscaling.

## Safety

Every API request must resolve inside the selected configured library root, including after resolving symlinks. Unsupported files cannot be served through the image endpoint. All milestone-1 routes are read-only. Subsequent destructive operations will require separate review and explicit confirmations.
