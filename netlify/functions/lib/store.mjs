// Netlify Blobs, with an in-memory fallback for tests and local scripts.
import { getStore } from '@netlify/blobs';
import { isTest } from './env.mjs';

const mem = new Map();
function memStore(name) {
  const k = (key) => name + '/' + key;
  return {
    async get(key, opts) { const v = mem.get(k(key)); if (v === undefined) return null; return opts?.type === 'json' ? JSON.parse(v) : v; },
    async set(key, value) { mem.set(k(key), typeof value === 'string' ? value : String(value)); },
    async setJSON(key, value) { mem.set(k(key), JSON.stringify(value)); },
    async delete(key) { mem.delete(k(key)); },
    async list({ prefix = '' } = {}) {
      const blobs = [...mem.keys()].filter((x) => x.startsWith(name + '/' + prefix)).map((x) => ({ key: x.slice(name.length + 1) }));
      return { blobs };
    },
  };
}

export function store(name) {
  if (isTest()) return memStore(name);
  try { return getStore({ name, consistency: 'strong' }); } catch { return memStore(name); }
}
export function _resetMemStore() { mem.clear(); }
