import fastify from 'fastify';
import { apiAddress, isObject, parseJson, readConfig } from './config.js';
import sharp from 'sharp';
import { matchesComfySampler, readComfyPrompt, readWorkflowNodeTypes, type SamplerFilters } from './comfyPrompt.js';
import { hasComfyUiMetadata, readPngTextMetadata } from './comfyui.js';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const imageMime: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif',
};

type Item = {
  name: string;
  path: string;
  kind: 'directory' | 'image' | 'file';
  size: number;
  modifiedAt: string;
  hasComfyUiMetadata: boolean;
};

async function imageDimensions(file: string) {
  const metadata = await sharp(file).metadata().catch(() => null);
  return { width: metadata?.autoOrient.width ?? null, height: metadata?.autoOrient.height ?? null };
}

type SortKey = 'name' | 'modified' | 'size';
type BrowseQuery = { path?: string; page?: string; sort?: string; order?: string; includeFileNames?: string };
const sortKeys: readonly SortKey[] = ['name', 'modified', 'size'];
type PathQuery = { path?: string };
type SearchQuery = SamplerFilters & { page?: string; options?: string; presence?: string; node?: string | string[] };
const pageSize = 96;
// The gallery stacks this many folders in the space of one image; keep in step with App.tsx.
const foldersPerSlot = 4;

function pageNumber(raw: string | undefined): number {
  const page = Number(raw ?? '0');
  return Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0;
}

// Pages are measured in gallery slots. Folders are listed first and share slots.
function browsePage(page: number, folders: number, total: number) {
  const folderSlots = Math.ceil(folders / foldersPerSlot);
  const slots = folderSlots + total - folders;
  const entryAt = (slot: number) => slot < folderSlots ? slot * foldersPerSlot : folders + slot - folderSlots;
  return {
    start: entryAt(page * pageSize),
    end: entryAt((page + 1) * pageSize),
    totalPages: Math.ceil(slots / pageSize),
  };
}

function searchNumber(value: string, key: 'steps' | 'cfg'): number | undefined {
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return;
  const number = Number(value);
  if (Number.isFinite(number) && (key === 'cfg' || Number.isSafeInteger(number))) return number;
}

function searchFilters(query: SearchQuery): SamplerFilters | null {
  const filters: SamplerFilters = {};
  for (const key of ['prompt', 'sampler', 'scheduler', 'steps', 'cfg'] as const) {
    const raw = query[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\0')) return null;
    const value = raw.trim();
    if (!value) continue;
    if ((key === 'steps' || key === 'cfg') && searchNumber(value, key) === undefined) return null;
    filters[key] = value;
  }
  return filters;
}


class ForbiddenPath extends Error {}

// Avoid issuing dozens of concurrent random reads against a network share.
async function mapLimited<T, U>(
  entries: T[], limit: number, fn: (entry: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      output[i] = await fn(entries[i]);
    }
  }));
  return output;
}


function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

type LibraryRoot = { name: string; directory: string; stat: Stats };

function publicPath(root: LibraryRoot, file: string): string {
  const path = relative(root.directory, file).split(sep).join('/');
  return [root.name, path].filter(Boolean).join('/');
}

async function loadRoots(config: Record<string, unknown>): Promise<LibraryRoot[]> {
  const configuredRoots = process.env.IMGBAE_ROOTS;
  let namedRoots: unknown = config.roots;
  let source = namedRoots === undefined ? undefined : 'The roots property in ' + process.env.IMGBAE_CONFIG;

  if (configuredRoots !== undefined) {
    source = 'IMGBAE_ROOTS';
    namedRoots = parseJson(configuredRoots, source);
  }

  let entries: [string, unknown][] = [['', process.env.IMGBAE_ROOT]];
  if (source) {
    if (!isObject(namedRoots) || !Object.keys(namedRoots).length) {
      throw new Error(source + ' must be a nonempty JSON object mapping folder names to absolute paths.');
    }
    entries = Object.entries(namedRoots);
  }

  return Promise.all(entries.map(async ([name, path]) => {
    if (source && (!name.trim() || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name))) {
      throw new Error(source + ' must use valid single path segments as folder names.');
    }
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new Error('Library folders must be configured with absolute paths.');
    }
    const directory = await realpath(path);
    const stat = await lstat(directory);
    if (!stat.isDirectory()) throw new Error('Each library folder must refer to a directory.');
    return { name, directory, stat };
  }));
}

async function main(): Promise<void> {
  const config = readConfig();
  const address = apiAddress(config);
  const roots = await loadRoots(config);
  const rootsByName = new Map(roots.map((root) => [root.name, root]));
  const legacyRoot = rootsByName.get('');

  async function resolveSafe(input: string | undefined = '') {
    if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) {
      throw new ForbiddenPath('Invalid path');
    }
    const [name, ...parts] = input.split('/');
    const root = legacyRoot ?? rootsByName.get(name);
    if (!root) throw new ForbiddenPath('Unknown library folder');
    const path = legacyRoot ? input : parts.join('/');
    const candidate = resolve(root.directory, path || '.');
    if (!isWithinRoot(root.directory, candidate)) throw new ForbiddenPath('Path is outside library root');
    const file = await realpath(candidate);
    if (!isWithinRoot(root.directory, file)) throw new ForbiddenPath('Path is outside library root');
    return { root, file };
  }

  async function imageFile(path: string | undefined) {
    if (!path) throw new ForbiddenPath('Missing image path');
    const { root, file } = await resolveSafe(path);
    const mime = imageMime[extname(file).toLowerCase()];
    if (!mime || !(await lstat(file)).isFile()) throw new ForbiddenPath('Not a supported image');
    return { root, file, mime };
  }

  const app = fastify({ logger: true });
  const metadataCache = new Map<string, boolean>();

  async function metadataFor(file: string, size: number, modified: number): Promise<boolean> {
    if (extname(file).toLowerCase() !== '.png') return false;
    const key = file + '\0' + size + '\0' + modified;
    if (metadataCache.has(key)) return metadataCache.get(key) ?? false;
    const detected = await hasComfyUiMetadata(file);
    metadataCache.set(key, detected);
    // Small process-local cache; no disk index and no image bytes retained.
    if (metadataCache.size > 2048) metadataCache.delete(metadataCache.keys().next().value!);
    return detected;
  }

  app.setErrorHandler((error, request, reply) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof ForbiddenPath) {
      void reply.code(403).send({ error: error.message });
    } else if (code === 'ENOENT' || code === 'ENOTDIR') {
      void reply.code(404).send({ error: 'Not found' });
    } else {
      request.log.error(error);
      void reply.code(500).send({ error: 'Unable to read the requested file' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/roots', async () => ({
    roots: roots.filter(({ name }) => name)
      .map(({ name }) => ({ name, path: name }))
      .sort((a, b) => compareNames(a.name, b.name)),
  }));

  app.get<{ Querystring: BrowseQuery }>('/api/browse', async (request) => {
    const page = pageNumber(request.query.page);
    const sort = sortKeys.find((key) => key === request.query.sort) ?? 'name';
    const direction = request.query.order === 'desc' ? -1 : 1;
    const order = direction === -1 ? 'desc' : 'asc';

    if (!legacyRoot && (request.query.path === undefined || request.query.path === '')) {
      const items = [...roots].sort((a, b) => direction * (
        (sort === 'modified' ? a.stat.mtimeMs - b.stat.mtimeMs : 0) || compareNames(a.name, b.name)
      ));
      const { start, end, totalPages } = browsePage(page, items.length, items.length);
      return {
        path: '', page, pageSize, totalPages, total: items.length, sort, order,
        hasMore: page + 1 < totalPages,
        ...(request.query.includeFileNames === '1' ? { fileNames: [] } : {}),
        items: items.slice(start, end).map((root): Item => ({
          name: root.name, path: root.name, kind: 'directory', size: root.stat.size,
          modifiedAt: root.stat.mtime.toISOString(), hasComfyUiMetadata: false,
        })),
      };
    }

    const { root, file: dir } = await resolveSafe(request.query.path);
    if (!(await lstat(dir)).isDirectory()) throw new ForbiddenPath('Not a directory');

    const listed = (await readdir(dir, { withFileTypes: true }))
      // Deliberately exclude symlinks in v1; the root itself may be a symlink.
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        entry,
        kind: entry.isDirectory()
          ? 'directory' as const
          : imageMime[extname(entry.name).toLowerCase()]
            ? 'image' as const : 'file' as const,
      }));
    // Date and size ordering must stat every entry before paging; name ordering avoids that.
    const stats = sort === 'name' ? null
      : await mapLimited(listed, 16, ({ entry }) => lstat(join(dir, entry.name)).catch(() => null));
    const byKey = (a: Stats | null, b: Stats | null): number =>
      !a || !b ? 0
        : sort === 'modified' ? a.mtimeMs - b.mtimeMs
          : sort === 'size' && a.isFile() && b.isFile() ? a.size - b.size : 0;
    const entries = listed
      .map((value, i) => ({ ...value, stat: stats?.[i] ?? null }))
      // The directory may change while it is being listed.
      .filter((value) => !stats || value.stat)
      .sort((a, b) =>
        (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1)
        || direction * (byKey(a.stat, b.stat)
          || compareNames(a.entry.name, b.entry.name))
      );

    const folderCount = entries.filter(({ kind }) => kind === 'directory').length;
    const { start, end, totalPages } = browsePage(page, folderCount, entries.length);
    const slice = entries.slice(start, end);
    const values = await mapLimited(slice, 8, async ({ entry, kind, stat: listedStat }): Promise<Item | null> => {
      const file = join(dir, entry.name);
      try {
        const stat = listedStat ?? await lstat(file);
        if (!stat.isDirectory() && !stat.isFile()) return null;
        let hasComfyUiMetadata = false;
        if (kind === 'image') {
          try {
            hasComfyUiMetadata = await metadataFor(file, stat.size, stat.mtimeMs);
          } catch (cause) {
            request.log.warn({ err: cause }, 'Could not inspect image metadata');
          }
        }
        return {
          name: entry.name, path: publicPath(root, file), kind,
          size: stat.size, modifiedAt: stat.mtime.toISOString(), hasComfyUiMetadata,
          ...(kind === 'image' ? await imageDimensions(file) : {}),
        };
      } catch {
        // The directory may change while it is being listed.
        return null;
      }
    });

    return {
      path: publicPath(root, dir),
      page, pageSize, totalPages, total: entries.length, sort, order,
      hasMore: page + 1 < totalPages,
      ...(request.query.includeFileNames === '1' ? {
        fileNames: listed.filter(({ kind }) => kind !== 'directory').map(({ entry }) => entry.name),
      } : {}),
      items: values.filter((value): value is Item => value !== null),
    };
  });

  const searchCache = new Map<string, {
    version: string;
    incomplete: boolean;
    samplers: ReturnType<typeof readComfyPrompt>['samplers'];
    nodeTypes: Set<string>;
  }>();

  async function searchSummary(file: string, size: number, modified: number, changed: number) {
    const version = size + ':' + modified + ':' + changed;
    const cached = searchCache.get(file);
    if (cached?.version === version) return cached;
    const { entries, incomplete } = await readPngTextMetadata(file, ['prompt', 'workflow']);
    const samplers: ReturnType<typeof readComfyPrompt>['samplers'] = [];
    const nodeTypes = new Set<string>();
    for (const { key, value } of entries) {
      if (key !== 'prompt') continue;
      const prompt = readComfyPrompt(value, false);
      for (const sampler of prompt.samplers) samplers.push(sampler);
      for (const type of prompt.nodeTypes) nodeTypes.add(type);
    }
    if (!nodeTypes.size) {
      for (const { key, value } of entries) {
        if (key !== 'workflow') continue;
        for (const type of readWorkflowNodeTypes(value)) nodeTypes.add(type);
      }
    }
    const summary = { version, incomplete, samplers, nodeTypes };
    searchCache.delete(file);
    if (JSON.stringify([samplers, [...nodeTypes]]).length <= 16_384) {
      searchCache.set(file, summary);
      if (searchCache.size > 2048) searchCache.delete(searchCache.keys().next().value!);
    }
    return summary;
  }

  app.get<{ Querystring: SearchQuery }>('/api/search', async (request, reply) => {
    const filters = searchFilters(request.query);
    const optionsOnly = request.query.options === '1';
    const presenceOnly = request.query.presence === '1';
    const requestedNodes = Array.isArray(request.query.node) ? request.query.node :
      request.query.node === undefined ? [] : [request.query.node];
    const hasSamplerFilters = filters !== null && Object.keys(filters).length > 0;
    if (!presenceOnly && !optionsOnly && (
      !filters || (!hasSamplerFilters && !requestedNodes.length) ||
      requestedNodes.some((name) => !name.trim() || name.length > 2048 || name.includes('\0'))
    )) {
      return reply.code(400).send({ error: 'Enter prompt text or select valid metadata filters.' });
    }

    const nodeOptions = new Set<string>();
    const samplers = new Map<string, string>();
    const schedulers = new Map<string, string>();
    const steps = new Set<number>();
    const cfg = new Set<number>();
    const page = pageNumber(request.query.page);
    const items: { item: Item; file: string }[] = [];
    const directories = roots.map((root) => ({ root, directory: root.directory })).reverse();
    let total = 0;
    let incomplete = false;

    while (directories.length && !reply.raw.destroyed) {
      const { root, directory } = directories.pop()!;
      try {
        if (await realpath(directory) !== directory) continue;
        const entries = await readdir(directory, { withFileTypes: true });
        if (!presenceOnly) {
          entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) ||
            (a.name < b.name ? -1 : Number(a.name > b.name)));
        }
        const childDirectories: string[] = [];
        for (const entry of entries) {
          if (reply.raw.destroyed) break;
          const file = join(directory, entry.name);
          if (entry.isDirectory()) {
            childDirectories.push(file);
            continue;
          }
          if (!entry.isFile() || extname(file).toLowerCase() !== '.png') continue;
          try {
            const stat = await lstat(file);
            if (!stat.isFile() || await realpath(file) !== file) continue;
            if (presenceOnly) {
              if (await metadataFor(file, stat.size, stat.mtimeMs)) return { hasComfyUiMetadata: true };
              continue;
            }
            const summary = await searchSummary(file, stat.size, stat.mtimeMs, stat.ctimeMs);
            incomplete ||= summary.incomplete;
            if (optionsOnly) {
              for (const type of summary.nodeTypes) nodeOptions.add(type);
              for (const { settings } of summary.samplers) {
                for (const { key, value } of settings) {
                  const names = key === 'sampler_name' ? samplers : key === 'scheduler' ? schedulers : undefined;
                  const name = value.trim();
                  if (names && name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
                  if (key === 'steps' || key === 'cfg') {
                    const number = searchNumber(name, key);
                    if (number !== undefined) (key === 'steps' ? steps : cfg).add(number);
                  }
                }
              }
              continue;
            }
            if (!requestedNodes.every((type) => summary.nodeTypes.has(type))) continue;
            if (hasSamplerFilters && !summary.samplers.some((sampler) => matchesComfySampler(sampler, filters))) continue;
            if (total >= page * pageSize && items.length < pageSize) {
              items.push({ file, item: {
                name: entry.name, path: publicPath(root, file), kind: 'image',
                size: stat.size, modifiedAt: stat.mtime.toISOString(), hasComfyUiMetadata: true,
              } });
            }
            total++;
          } catch {
            incomplete = true;
          }
        }
        for (const child of childDirectories.reverse()) directories.push({ root, directory: child });
      } catch (error) {
        if (legacyRoot && directory === root.directory) throw error;
        incomplete = true;
      }
    }

    if (presenceOnly) return { hasComfyUiMetadata: false };
    if (optionsOnly) {
      const sortNames = (names: Map<string, string>) => [...names.values()].sort((a, b) => a.localeCompare(b));
      const sortNumbers = (numbers: Set<number>) => [...numbers].sort((a, b) => a - b);
      return {
        samplers: sortNames(samplers), schedulers: sortNames(schedulers),
        steps: sortNumbers(steps), cfg: sortNumbers(cfg),
        nodes: [...nodeOptions].sort((a, b) => a.localeCompare(b)), incomplete,
      };
    }
    const results = await mapLimited(items, 8, async ({ item, file }) => ({
      ...item,
      ...await imageDimensions(file),
    }));
    return { path: '', page, pageSize, totalPages: Math.ceil(total / pageSize), total, hasMore: (page + 1) * pageSize < total, items: results, incomplete };
  });

  app.get<{ Querystring: PathQuery }>('/api/details', async (request) => {
    const { root, file } = await imageFile(request.query.path);
    const [stat, metadata] = await Promise.all([lstat(file), sharp(file).metadata()]);
    let hasComfyUiMetadata = false;
    try {
      hasComfyUiMetadata = await metadataFor(file, stat.size, stat.mtimeMs);
    } catch (cause) {
      request.log.warn({ err: cause }, 'Could not inspect image metadata');
    }
    return {
      path: publicPath(root, file),
      name: file.split(sep).pop(),
      size: stat.size, modifiedAt: stat.mtime.toISOString(),
      width: metadata.autoOrient.width ?? null, height: metadata.autoOrient.height ?? null,
      format: metadata.format ?? null, orientation: metadata.orientation ?? null,
      pages: metadata.pages ?? null,
      hasComfyUiMetadata,
    };
  });

  const visionModel = process.env.IMGBAE_VISION_MODEL?.trim() || 'qwen3-vl:4b';
  let describing = false;
  app.post<{ Querystring: PathQuery }>('/api/description', async (request, reply) => {
    const { file } = await imageFile(request.query.path);
    if (describing) return reply.code(429).send({ error: 'Another description is running. Try again shortly.' });
    describing = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    reply.raw.once('close', cancel);
    try {
      const preview = await sharp(file, { animated: false })
        .rotate()
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: visionModel, stream: false,
            messages: [{
              role: 'user',
              content: 'Describe this image in two or three sentences. Focus on the visible subject, composition, colors and style.',
              images: [preview.toString('base64')],
            }],
            options: { num_predict: 256 },
          }),
        });
        if (response.status === 404) return reply.code(503).send({ error: 'Install the Ollama model on the API host: ' + visionModel });
        if (!response.ok) return reply.code(502).send({ error: 'Ollama could not describe this image. Check that the configured model supports vision.' });
        const result = await response.json();
        const message = isObject(result) ? result.message : null;
        const description = isObject(message) && typeof message.content === 'string' && message.content.trim();
        if (!description) return reply.code(502).send({ error: 'Ollama returned an empty description.' });
        return { description, model: visionModel };
      } catch {
        if (controller.signal.aborted) return;
        if (signal.aborted) return reply.code(504).send({ error: 'Ollama took too long to generate a description.' });
        return reply.code(502).send({ error: 'Could not read a response from Ollama. Check that it is running on the API host.' });
      }
    } finally {
      reply.raw.off('close', cancel);
      describing = false;
    }
  });

  app.get<{ Querystring: PathQuery }>('/api/metadata', async (request) => {
    const { file } = await imageFile(request.query.path);
    if (extname(file).toLowerCase() !== '.png') throw new ForbiddenPath('Metadata inspection requires a PNG');
    return readPngTextMetadata(file);
  });

  app.get<{ Querystring: PathQuery }>('/api/thumbnail', async (request, reply) => {
    const { file } = await imageFile(request.query.path);
    const buffer = await sharp(file, { animated: false })
      .rotate()
      .resize({ width: 360, height: 260, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
    return reply.type('image/webp').header('Cache-Control', 'private, max-age=300').send(buffer);
  });

  // Preview unsupported browser formats without changing the original.
  app.get<{ Querystring: PathQuery }>('/api/preview', async (request, reply) => {
    const { file } = await imageFile(request.query.path);
    const buffer = await sharp(file, { animated: false })
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer();
    return reply.type('image/webp').header('Cache-Control', 'private, max-age=300').send(buffer);
  });

  app.get<{ Querystring: PathQuery }>('/api/image', async (request, reply) => {
    const { file, mime } = await imageFile(request.query.path);
    return reply.type(mime).header('Cache-Control', 'private, max-age=300').send(createReadStream(file));
  });

  await app.listen(address);
  app.log.info({ roots: roots.map(({ directory }) => directory) }, 'Serving read-only image library');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
