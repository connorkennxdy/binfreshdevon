// Scheduled: 03:00 UTC daily. Runs only on the published production deploy.
import { backup } from './lib/jobs.mjs';

export default async () => {
  const started = Date.now();
  try {
    const result = await backup();
    console.log('cron-backup', JSON.stringify(result), `${Date.now() - started}ms`);
  } catch (e) {
    console.error('cron-backup failed', e?.message);
    throw e;
  }
};

export const config = { schedule: '0 3 * * *' };
