import {isIP} from 'node:net';
import {demand} from './errors.js';

export const DEFAULT_API_BIND_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 3000;

const allowedBindHosts = new Set([DEFAULT_API_BIND_HOST, '::1', '0.0.0.0', '::']);

/**
 * Bind only to explicit loopback or wildcard IP literals. The wildcard forms
 * are needed by an ingress proxy; arbitrary hostnames and APP_ORIGIN are not
 * listen addresses.
 */
export function parseApiBindHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_API_BIND_HOST;
  demand(value.length > 0 && value === value.trim() && value.length <= 45 && isIP(value) !== 0 && allowedBindHosts.has(value), 'CONFIGURATION', 'API_BIND_HOST must be a supported loopback or ingress IP literal.');
  return value;
}

export function parseApiPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_API_PORT;
  demand(/^[0-9]{1,5}$/.test(value), 'CONFIGURATION', 'PORT must be an integer from 1 through 65535.');
  const port = Number(value);
  demand(Number.isSafeInteger(port) && port >= 1 && port <= 65535, 'CONFIGURATION', 'PORT must be an integer from 1 through 65535.');
  return port;
}

export function parseApiBind(env: {API_BIND_HOST?: string; PORT?: string}): {host: string; port: number} {
  return {host: parseApiBindHost(env.API_BIND_HOST), port: parseApiPort(env.PORT)};
}

export function apiReadinessUrl(bindHost: string, port: number): string {
  const loopback = bindHost === '::' || bindHost === '::1' ? '::1' : '127.0.0.1';
  const authority = isIP(loopback) === 6 ? `[${loopback}]` : loopback;
  return `http://${authority}:${port}/health/ready`;
}
