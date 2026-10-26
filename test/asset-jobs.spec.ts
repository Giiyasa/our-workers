import { describe, expect, it } from 'vitest';
import { assetJobDiagnostic } from '../src/lib/asset-jobs';
import { AssetFailure } from '../src/lib/asset-providers';

describe('asset job diagnostics', () => {
    it.each(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECT_TIMEOUT', 'CONNECTION_DESTROYED', '23505', '42703'])('preserves database code %s without logging sensitive error fields', code => {
        const error = Object.assign(new Error('postgres://secret and Lua payload'), { code, query: 'sensitive query', parameters: ['secret'] });
        expect(assetJobDiagnostic(error, 'database_asset_write')).toEqual({
            stage: 'database_asset_write', code, error_name: 'Error',
        });
    });
    it('preserves classified provider errors', () => {
        expect(assetJobDiagnostic(new AssetFailure('PROVIDER_UNAVAILABLE', 'secret'), 'provider_fetch').code).toBe('PROVIDER_UNAVAILABLE');
    });
    it('does not log arbitrary error codes or unsafe error names', () => {
        const error = Object.assign(new Error('secret'), { code: 'https://secret.example', name: 'secret with spaces' });
        expect(assetJobDiagnostic(error, 'database_publish')).toEqual({
            stage: 'database_publish', code: 'ASSET_FETCH_FAILED', error_name: 'UnknownError',
        });
    });
});
