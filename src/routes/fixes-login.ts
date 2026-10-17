import { FIXES_CONFIG } from '../fixes-config.mjs';
import { readJsonBody } from '../lib/body';
import { fail } from '../lib/http';
import { FixesFailure, saveProviderSession } from '../lib/fixes-provider';
import type { DbRoute } from '../lib/types';

interface LoginCode { auth_code: string; code_verifier: string; label?: string }

// PKCE callback receives only a short-lived code. Token exchange and all token
// storage happen on the Worker; access/refresh tokens never return to the CLI.
export const fixesAdminLoginRoute: DbRoute<LoginCode> = {
    method: 'POST', path: '/api/admin/fixes/login', token: 'write', requiresDb: true,
    prepare: async ({ request }) => {
        const parsed = await readJsonBody(request);
        if (parsed instanceof Response) return parsed;
        const { auth_code, code_verifier, label } = parsed.value;
        if (typeof auth_code !== 'string' || !/^[A-Za-z0-9._~-]{1,2048}$/.test(auth_code) ||
            typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier) ||
            (label !== undefined && (typeof label !== 'string' || label.length > 120))) {
            return fail(400, 'Kode login atau PKCE verifier tidak valid.', 'LOGIN_INPUT');
        }
        return { input: { auth_code, code_verifier, label: label as string | undefined } };
    },
    handle: async ({ env }, input, sql) => {
        const headers = { 'cache-control': 'no-store' };
        try {
            if (!/^[a-f\d]{64}$/i.test(env.FIXES_SESSION_KEY_HEX ?? '')) throw new FixesFailure('SESSION_CONFIG');
            let response: Response;
            try {
                response = await fetch(`${FIXES_CONFIG.auth}/token?grant_type=pkce`, {
                    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
                    headers: { apikey: FIXES_CONFIG.anonKey, 'content-type': 'application/json' },
                    body: JSON.stringify({ auth_code: input.auth_code, code_verifier: input.code_verifier }),
                });
            } catch { throw new FixesFailure('PROVIDER_NETWORK'); }
            if (!response.ok) {
                await response.body?.cancel();
                throw new FixesFailure('LOGIN_EXCHANGE_FAILED', response.status);
            }
            const session = await response.json().catch(() => null) as {
                access_token?: unknown; refresh_token?: unknown; expires_in?: unknown;
            } | null;
            if (!session || typeof session.expires_in !== 'number' || !Number.isFinite(session.expires_in) ||
                session.expires_in <= 0 || session.expires_in > 31_536_000) throw new FixesFailure('SESSION_INPUT');
            const id = await saveProviderSession(sql, env, {
                access_token: session.access_token, refresh_token: session.refresh_token,
                expires_at: new Date(Date.now() + session.expires_in * 1000).toISOString(), label: input.label,
            });
            console.info('fixes_login_completed', { accountId: id });
            return Response.json({ ok: true, account_id: id }, { headers });
        } catch (error) {
            const code = error instanceof FixesFailure ? error.code : 'LOGIN_FAILED';
            console.warn('fixes_login_failed', { code, upstreamStatus: error instanceof FixesFailure ? error.upstreamStatus : undefined });
            return Response.json({ ok: false, code, error: 'Login provider gagal. Ulangi login admin.' }, { status: 503, headers });
        }
    },
};
