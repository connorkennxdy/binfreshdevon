// Environment access that works on Netlify (Netlify.env) and in Node scripts/tests (process.env).
export function env(name, fallback = '') {
  let v;
  try { v = globalThis.Netlify?.env?.get(name); } catch { /* not on Netlify */ }
  if (v === undefined || v === null || v === '') v = process.env[name];
  return v === undefined || v === null || v === '' ? fallback : v;
}

export const isTest = () => env('BF_TEST_MODE') === '1';

export const siteUrl = () => env('SITE_URL', 'https://binfreshdevon.co.uk').replace(/\/$/, '');
export const appUrl = () => env('APP_URL', 'https://app.binfreshdevon.co.uk').replace(/\/$/, '');
