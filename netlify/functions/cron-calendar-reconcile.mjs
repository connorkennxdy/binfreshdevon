// Scheduled: hourly. Runs only on the published production deploy.
import { reconcileCalendar } from './lib/jobs.mjs';

export default async () => {
  const started = Date.now();
  try {
    const result = await reconcileCalendar();
    console.log('cron-calendar-reconcile', JSON.stringify(result), `${Date.now() - started}ms`);
  } catch (e) {
    console.error('cron-calendar-reconcile failed', e?.message);
    throw e;
  }
};

export const config = { schedule: '15 * * * *' };
