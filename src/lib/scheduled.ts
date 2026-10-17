import type { Sql } from './db';
import { syncHomeFeed } from './home-feed';
import { refreshDueProviderSessions } from './fixes-provider';

export const SESSION_REFRESH_CRON = '*/5 * * * *';
// Cloudflare cron uses UTC: these hours correspond to 00/06/12/18 WIB.
export const SESSION_PERIODIC_REFRESH_CRON = '0 5,11,17,23 * * *';
export const HOME_FEED_CRON = '0 */12 * * *';

export async function runScheduledTask(cron: string, sql: Sql, env: Env) {
    if (cron === SESSION_REFRESH_CRON) return refreshDueProviderSessions(sql, env);
    if (cron === SESSION_PERIODIC_REFRESH_CRON) return refreshDueProviderSessions(sql, env, true);
    if (cron === HOME_FEED_CRON) return syncHomeFeed(sql, new Date(), (env as Env & { STEAM_API_KEY?: string }).STEAM_API_KEY);
}
