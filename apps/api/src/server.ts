import fastify from 'fastify';
import { isIP } from 'node:net';
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
type BrowseQuery = { path?: string; page?: string; sort?: string; order?: string };
const sortKeys: readonly SortKey[] = ['name', 'modified', 'size'];
type PathQuery = { path?: string };
type SearchQuery = SamplerFilters & { page?: string; options?: string; presence?: string; node?: string | string[] };
const pageSize = 96;

function pageNumber(raw: string | undefined): number {
  const page = Number(raw ?? '0');
  return Number.isSafeInteger(page) ? Math.max(0, Math.min(page, 100000)) : 0;
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


function permittedBindHost(host: string): boolean {
  if (host === '::1') return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
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

function publicPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

async function main(): Promise<void> {
  const configuredRoot = process.env.IMGBAE_ROOT;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error('IMGBAE_ROOT must be an absolute path to your images or mounted share.');
  }
  const root = await realpath(configuredRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('IMGBAE_ROOT must refer to a directory.');

  async function resolveSafe(input: string | undefined): Promise<string> {
    if ((input ?? '').length > 4096 || (input ?? '').includes('\0')) {
      throw new ForbiddenPath('Invalid path');
    }
    const target = await realpath(resolve(root, input || '.'));
    if (!isWithinRoot(root, target)) throw new ForbiddenPath('Path is outside library root');
    return target;
  }

  async function imageFile(path: string | undefined): Promise<{ file: string; mime: string }> {
    if (!path) throw new ForbiddenPath('Missing image path');
    const file = await resolveSafe(path);
    const mime = imageMime[extname(file).toLowerCase()];
    if (!mime || !(await lstat(file)).isFile()) throw new ForbiddenPath('Not a supported image');
    return { file, mime };
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

  app.get<{ Querystring: BrowseQuery }>('/api/browse', async (request) => {
    const dir = await resolveSafe(request.query.path);
    if (!(await lstat(dir)).isDirectory()) throw new ForbiddenPath('Not a directory');

    const page = pageNumber(request.query.page);
    const sort = sortKeys.find((key) => key === request.query.sort) ?? 'name';
    const direction = request.query.order === 'desc' ? -1 : 1;
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
          || a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: 'base' }))
      );

    const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
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
      page, pageSize, total: entries.length, sort, order: direction === -1 ? 'desc' : 'asc',
      hasMore: (page + 1) * pageSize < entries.length,
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
    const items: Item[] = [];
    const directories = [root];
    let total = 0;
    let incomplete = false;

    while (directories.length && !reply.raw.destroyed) {
      const directory = directories.pop()!;
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
              items.push({
                name: entry.name, path: publicPath(root, file), kind: 'image',
                size: stat.size, modifiedAt: stat.mtime.toISOString(), hasComfyUiMetadata: true,
              });
            }
            total++;
          } catch {
            incomplete = true;
          }
        }
        for (const child of childDirectories.reverse()) directories.push(child);
      } catch (error) {
        if (directory === root) throw error;
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
    const results = await mapLimited(items, 8, async (item) => ({
      ...item,
      ...await imageDimensions(join(root, item.path)),
    }));
    return { path: '', page, pageSize, total, hasMore: (page + 1) * pageSize < total, items: results, incomplete };
  });

  app.get<{ Querystring: PathQuery }>('/api/details', async (request) => {
    const { file } = await imageFile(request.query.path);
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

  const port = Number(process.env.IMGBAE_PORT || '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('IMGBAE_PORT must be an integer between 1 and 65535.');
  }
  const host = process.env.IMGBAE_HOST?.trim() || '127.0.0.1';
  if (!permittedBindHost(host)) {
    throw new Error('IMGBAE_HOST must be loopback or a specific private IPv4 address (not 0.0.0.0 or a public address).');
  }
  await app.listen({ port, host });
  app.log.info({ root }, 'Serving read-only image library');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
