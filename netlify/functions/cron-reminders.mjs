// Scheduled: hourly; acts from 17:00 UK. Runs only on the published production deploy.
import { sendReminders } from './lib/jobs.mjs';

export default async () => {
  const started = Date.now();
  try {
    const result = await sendReminders();
    console.log('cron-reminders', JSON.stringify(result), `${Date.now() - started}ms`);
  } catch (e) {
    console.error('cron-reminders failed', e?.message);
    throw e;
  }
};

export const config = { schedule: '0 * * * *' };
