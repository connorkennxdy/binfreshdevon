// Scheduled: 02:00 UTC daily (02:00 GMT / 03:00 BST). Runs only on the published production deploy.
import { generateAll } from './lib/jobs.mjs';

export default async () => {
  const started = Date.now();
  try {
    const result = await generateAll();
    console.log('cron-generate-visits', JSON.stringify(result), `${Date.now() - started}ms`);
  } catch (e) {
    console.error('cron-generate-visits failed', e?.message);
    throw e;
  }
};

export const config = { schedule: '0 2 * * *' };
