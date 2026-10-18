import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeFixesJob, jobDiagnostic, type FixesMessage } from '../src/lib/fixes-jobs';
import { createDb } from '../src/lib/db';
import { FixesFailure, fetchFixPackage, fetchRyuuFallbackPackage } from '../src/lib/fixes-provider';
import { storePackage } from '../src/lib/fixes-storage';

vi.mock('../src/lib/db', () => ({ createDb: vi.fn() }));
vi.mock('../src/lib/fixes-provider', async original => ({
    ...await original<typeof import('../src/lib/fixes-provider')>(),
    fetchFixPackage: vi.fn(), fetchRyuuFallbackPackage: vi.fn(),
}));
vi.mock('../src/lib/fixes-storage', async original => ({
    ...await original<typeof import('../src/lib/fixes-storage')>(), storePackage: vi.fn(),
}));
const message: FixesMessage = { kind: 'fixes', fixId: 'fixture', revision: 'a'.repeat(64), slot: 'fix', requestToken: crypto.randomUUID() };
let writes: { query: string; values: unknown[] }[];
let stale: boolean;
beforeEach(() => {
    vi.resetAllMocks(); writes = []; stale = false;
    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join(' ').replace(/\s+/g, ' ');
        writes.push({ query, values });
        if (query.includes('returning app_id,filename')) return [{ app_id: '1547000', filename: 'primary.zip' }];
        if (query.includes('select revision,active')) return [{ revision: stale ? 'b'.repeat(64) : message.revision, active: true }];
        return [{ fix_id: message.fixId }];
    }), { end: vi.fn(async () => {}) });
    vi.mocked(createDb).mockReturnValue(sql as any);
    vi.mocked(fetchFixPackage).mockImplementation(async () => new Response('primary'));
    vi.mocked(fetchRyuuFallbackPackage).mockImplementation(async () => ({ source: new Response('fallback'), filename: 'fallback.rar' }));
    vi.mocked(storePackage).mockResolvedValue({ size: 7, sha256: 'c'.repeat(64) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const ready = () => writes.find(w => w.query.includes("set status='ready'"));
const failed = () => writes.find(w => w.query.includes("set status='failed'"));

describe('Fixes job recovery', () => {
    it('keeps the successful primary path and does not fetch Ryuu', async () => {
        await consumeFixesJob(message, {} as Env);
        expect(fetchRyuuFallbackPackage).not.toHaveBeenCalled();
        expect(ready()?.values[0]).toBe('primary.zip');
    });
    it.each(['PROVIDER_AUTH', 'PROVIDER_UNAVAILABLE', 'DOWNLOAD_HTTP'])('falls back by numeric AppID after %s', async code => {
        vi.mocked(fetchFixPackage).mockRejectedValueOnce(new FixesFailure(code));
        await consumeFixesJob(message, {} as Env);
        expect(fetchRyuuFallbackPackage).toHaveBeenCalledWith(expect.anything(), {}, 1547000);
        expect(storePackage).toHaveBeenCalledWith({}, expect.any(String), expect.any(Response), 'fallback.rar', expect.any(Function));
        expect(ready()?.values[0]).toBe('fallback.rar');
        expect(failed()).toBeUndefined();
    });
    it('recovers from a broken primary stream using the alternate archive filename', async () => {
        vi.mocked(storePackage).mockRejectedValueOnce(new FixesFailure('DOWNLOAD_BODY_ERROR'));
        await consumeFixesJob(message, {} as Env);
        expect(storePackage).toHaveBeenCalledTimes(2);
        expect(ready()?.values[0]).toBe('fallback.rar');
    });
    it.each(['STORAGE_UPLOAD', 'LEASE_LOST'])('does not change provider on %s', async code => {
        vi.mocked(storePackage).mockRejectedValueOnce(new FixesFailure(code));
        await consumeFixesJob(message, {} as Env);
        expect(fetchRyuuFallbackPackage).not.toHaveBeenCalled();
        expect(failed()?.values[0]).toBe(code);
        expect(ready()).toBeUndefined();
    });
    it('records sanitized database codes and does not invoke fallback for database failures', async () => {
        vi.mocked(fetchFixPackage).mockRejectedValueOnce(Object.assign(new Error('secret query'), { code: '22P02' }));
        await consumeFixesJob(message, {} as Env);
        expect(failed()?.values[0]).toBe('PACKAGE_DB_22P02');
        expect(fetchRyuuFallbackPackage).not.toHaveBeenCalled();
        expect(JSON.stringify(jobDiagnostic(Object.assign(new Error('secret query'), { code: '22P02' }), 'provider_download'))).not.toContain('secret query');
    });
    it('keeps manifest and direct Ryuu failures out of automatic fallback', async () => {
        vi.mocked(fetchFixPackage).mockRejectedValue(new FixesFailure('DOWNLOAD_HTTP'));
        await consumeFixesJob({ ...message, slot: 'manifest' }, {} as Env);
        await consumeFixesJob({ ...message, fixId: 'ryuu:1547000:fixture' }, {} as Env);
        expect(fetchRyuuFallbackPackage).not.toHaveBeenCalled();
    });
    it('does not publish a fallback if the original revision changes during upload', async () => {
        vi.mocked(fetchFixPackage).mockRejectedValueOnce(new FixesFailure('PROVIDER_AUTH'));
        vi.mocked(storePackage).mockImplementationOnce(async () => { stale = true; return { size: 7, sha256: 'c'.repeat(64) }; });
        await consumeFixesJob(message, {} as Env);
        expect(ready()).toBeUndefined();
        expect(failed()?.values[0]).toBe('REVISION_CHANGED');
    });
    it('records a fallback failure without publishing an incomplete package', async () => {
        vi.mocked(fetchFixPackage).mockRejectedValueOnce(new FixesFailure('PROVIDER_AUTH'));
        vi.mocked(fetchRyuuFallbackPackage).mockRejectedValueOnce(new FixesFailure('RYUU_FALLBACK_MISSING'));
        await consumeFixesJob(message, {} as Env);
        expect(ready()).toBeUndefined();
        expect(failed()?.values[0]).toBe('RYUU_FALLBACK_MISSING');
    });
    it('identifies unexpected error stages without logging raw secrets', () => {
        expect(jobDiagnostic(new TypeError('https://host/?auth_code=secret'), 'storage')).toEqual({
            code: 'PACKAGE_STORAGE_FAILED', stage: 'storage', error_name: 'TypeError',
        });
        expect(jobDiagnostic(new FixesFailure('DOWNLOAD_HTTP', 503), 'provider_download').upstream_status).toBe(503);
    });
});
