import {FIXES_CONFIG} from '../src/fixes-config.mjs';
import {readFile} from 'node:fs/promises';
// Admin-only CLI. Secrets are read from environment/stdin and never printed or written to disk.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
const worker = new URL(process.env.FIXES_WORKER_URL || FIXES_CONFIG.worker);
if (worker.protocol !== 'https:' || worker.username || worker.password) throw new Error('Worker URL must use HTTPS.');
let writeToken = process.env.FIXES_ADMIN_WRITE_TOKEN;
// Reuse the existing local admin credential; never print it or execute the file.
if (!writeToken) {try {const vars=await readFile(new URL('../.dev.vars',import.meta.url),'utf8');
 const match=vars.match(/^\s*WRITE_TOKEN\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*))/m);
 writeToken=(match?.[1]??match?.[2]??match?.[3])?.trim();}catch{}}

async function admin(path, body, method = 'POST') {
	if (!writeToken) throw new Error('Set FIXES_ADMIN_WRITE_TOKEN in this admin shell.');
	const res = await fetch(new URL(`/api/admin/fixes/${path}`, worker), {
		method,
		redirect: 'error',
		headers: { 'X-Write-Token': writeToken, 'Content-Type': 'application/json' },
		body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(120_000),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(`Admin request failed: HTTP ${res.status} (${data.code ?? 'ADMIN_FAILED'}).`);
	return data;
}
async function login() {
	if (!writeToken) throw new Error('Existing WRITE_TOKEN is required in .dev.vars or FIXES_ADMIN_WRITE_TOKEN.');
	const verifier = randomBytes(48).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const authorize = new URL(`${FIXES_CONFIG.auth}/authorize`);
	authorize.search = new URLSearchParams({
		provider: 'discord',
		redirect_to: FIXES_CONFIG.callback,
		code_challenge: challenge,
		code_challenge_method: 's256',
	}).toString();
	let timer, server;
	const codePromise = new Promise((resolve, reject) => {
		server = createServer((req, res) => {
			const url = new URL(req.url, 'http://localhost:53789');
			if (req.method !== 'GET' || url.pathname !== '/callback') {
				res.writeHead(404);
				res.end();
				return;
			}
			if (url.searchParams.has('error')) {
				res.writeHead(400);
				res.end('Provider login failed. Return to the admin terminal.');
				reject(new Error('Provider rejected login.'));
				return;
			}
			const code = url.searchParams.get('code');
			if (!code) {
				res.writeHead(400);
				res.end('No authorization code.');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
			res.end('Provider login received. Return to the admin terminal.');
			resolve(code);
		});
		server.once('error', () => reject(new Error('Cannot bind localhost:53789; close any other provider login first.')));
		server.listen(53789, '127.0.0.1', () => {
			console.log('Open this provider login URL in your browser:');
			console.log(authorize.toString());
			if (process.argv.includes('--open') && process.platform === 'win32')
				execFile('rundll32.exe', ['url.dll,FileProtocolHandler', authorize.toString()], { windowsHide: true }, () => {});
		});
		timer = setTimeout(() => reject(new Error('Provider login timed out.')), 5 * 60_000);
	});
	try {
		const code = await codePromise;
		const response = await fetch(`${FIXES_CONFIG.auth}/token?grant_type=pkce`, {
			method: 'POST',
			redirect: 'error',
			headers: { apikey: FIXES_CONFIG.anonKey, 'Content-Type': 'application/json' },
			body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Provider exchange failed: HTTP ${response.status}.`);
		const session = await response.json();
		if (!session.access_token || !session.refresh_token || !Number.isFinite(Number(session.expires_in)) || Number(session.expires_in) <= 0)
			throw new Error('Invalid provider session response.');
		const stored = await admin('session', {
 label: process.argv.slice(3).find(a=>!a.startsWith('--')) ?? '',
			access_token: session.access_token,
			refresh_token: session.refresh_token,
			expires_at: new Date(Date.now() + Number(session.expires_in) * 1000).toISOString(),
		});
		console.log('Provider session stored encrypted in DB. Account ID:', stored.account_id);
	} finally {
		clearTimeout(timer);
		server?.close();
	}
}
try {
	const [command, arg, slot] = process.argv.slice(2);
	switch (command) {
		case 'login':
			await login();
			break;
		case 'refresh':
			if (!arg) throw new Error('Usage: refresh <account-id>');
 await admin('refresh',{account_id:arg});
			console.log('Provider session refreshed by admin.');
			break;
        case 'hosts':
            if (!arg) throw new Error('Usage: hosts <hostname,hostname>');
            console.log(JSON.stringify(await admin('config',{download_hosts:arg.split(',').map(h=>h.trim())}),null,2));
            break;
        case 'enable':
        case 'disable':
            if (!arg) throw new Error('Usage: enable|disable <account-id>');
            console.log(JSON.stringify(await admin('account',{account_id:arg,enabled:command==='enable'}),null,2));
            break;
		case 'status':
			console.log(JSON.stringify(await admin('status', undefined, 'GET'), null, 2));
			break;
		case 'sync':
			if (arg && !/^\d+$/.test(arg)) throw new Error('AppID must be numeric.');
			console.log(JSON.stringify(await admin('sync', arg ? { app_id: Number(arg) } : {}), null, 2));
			break;
        case 'invalidate':
            if (!arg || !['manifest','fix'].includes(slot)) throw new Error('Usage: invalidate <fix-id> manifest|fix');
            console.log(JSON.stringify(await admin('invalidate', {fix_id:arg,slot}), null, 2));
            break;
		case 'host':
			if (!arg || !['manifest', 'fix'].includes(slot)) throw new Error('Usage: host <fix-id> manifest|fix');
			console.log(JSON.stringify(await admin('host', { fix_id: arg, slot }), null, 2));
			break;
		case 'session': {
			let input = '';
			for await (const chunk of process.stdin) {
				input += chunk;
				if (input.length > 64 * 1024) throw new Error('Session input too large.');
			}
			let s; try { s = JSON.parse(input); } catch { throw new Error('Session input must be valid JSON.'); }
			await admin('session', { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, label:s.label });
			console.log('Provider session stored encrypted in DB.');
			break;
		}
		default:
			console.log(
				'Usage: node scripts/fixes-admin.mjs login [label] [--open] | refresh <account-id> | enable|disable <account-id> | hosts <hostname,hostname> | status | sync [appid] | host <fix-id> manifest|fix | invalidate <fix-id> manifest|fix | session (JSON stdin)',
			);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
