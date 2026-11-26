// @ts-check
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

/** @param {string} text @param {string} source */
export function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(source + ' must contain valid JSON.');
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readConfig() {
  const path = process.env.IMGBAE_CONFIG;
  if (path === undefined) return {};
  if (!isAbsolute(path)) throw new Error('IMGBAE_CONFIG must be an absolute path to a JSON config file.');
  const config = parseJson(readFileSync(path, 'utf8'), path);
  if (!isObject(config)) throw new Error(path + ' must contain a JSON object.');
  return config;
}

/** @param {string} host */
export function permittedBindHost(host) {
  if (host === '::1') return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

/** @param {Record<string, unknown>} config */
export function apiAddress(config) {
  const envHost = process.env.IMGBAE_HOST?.trim();
  const envPort = process.env.IMGBAE_PORT;
  const host = envHost || (config.host === undefined ? '127.0.0.1' : config.host);
  const port = envPort ? Number(envPort) : config.port === undefined ? 3001 : config.port;
  if (typeof host !== 'string' || !permittedBindHost(host)) {
    throw new Error((envHost ? 'IMGBAE_HOST' : 'Config host') + ' must be loopback or a specific private IPv4 address.');
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error((envPort ? 'IMGBAE_PORT' : 'Config port') + ' must be an integer between 1 and 65535.');
  }
  return { host, port };
}
