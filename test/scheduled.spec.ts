import { describe, it, expect, vi, afterEach } from 'vitest';
import { runScheduledTask, SESSION_REFRESH_CRON, SESSION_PERIODIC_REFRESH_CRON, HOME_FEED_CRON } from '../src/lib/scheduled';
import { refreshDueProviderSessions } from '../src/lib/fixes-provider';
import { syncHomeFeed } from '../src/lib/home-feed';
import worker from '../src/index';
import { createDb } from '../src/lib/db';
import type { Sql } from '../src/lib/db';

vi.mock('../src/lib/fixes-provider', async original => ({ ...await original<typeof import('../src/lib/fixes-provider')>(), refreshDueProviderSessions:vi.fn() }));
vi.mock('../src/lib/home-feed', async original => ({ ...await original<typeof import('../src/lib/home-feed')>(), syncHomeFeed:vi.fn() }));
vi.mock('../src/lib/db', () => ({ createDb:vi.fn() }));
afterEach(()=>vi.clearAllMocks());
const sql={} as Sql,env={} as Env;

describe('scheduled session maintenance',()=>{
    it('refreshes eligible sessions every six hours even before the expiry window',async()=>{
        await runScheduledTask(SESSION_PERIODIC_REFRESH_CRON,sql,env);
        expect(refreshDueProviderSessions).toHaveBeenCalledWith(sql,env,true);
        expect(syncHomeFeed).not.toHaveBeenCalled();
    });
    it('runs token refresh every five minutes without fetching the home feed',async()=>{
        await runScheduledTask(SESSION_REFRESH_CRON,sql,env);
        expect(refreshDueProviderSessions).toHaveBeenCalledWith(sql,env);
        expect(syncHomeFeed).not.toHaveBeenCalled();
    });
    it('preserves the existing twelve-hour home feed schedule',async()=>{
        await runScheduledTask(HOME_FEED_CRON,sql,env);
        expect(syncHomeFeed).toHaveBeenCalledWith(sql,expect.any(Date),undefined);
        expect(refreshDueProviderSessions).not.toHaveBeenCalled();
    });
    it('closes the database connection even if the keepalive fails',async()=>{
        const end=vi.fn();vi.mocked(createDb).mockReturnValue({end} as unknown as ReturnType<typeof createDb>);
        vi.mocked(refreshDueProviderSessions).mockRejectedValueOnce(new Error('fixture failure'));
        await expect(worker.scheduled({cron:SESSION_REFRESH_CRON} as ScheduledController,env)).rejects.toThrow('fixture failure');
        expect(end).toHaveBeenCalledWith({timeout:5});
    });
});
