import { createDb, type Sql } from './db';
import { FixesFailure, fetchFixPackage, fetchRyuuFallbackPackage, canFallbackToRyuu, type Slot } from './fixes-provider';
import { packageObjectKey, storePackage } from './fixes-storage';
export interface FixesMessage {
	kind: 'fixes';
	fixId: string;
	revision: string;
	slot: Slot;
	requestToken: string;
}
export async function startFixesJob(
	sql: Sql,
	env: Env,
	fixId: string,
	revision: string,
	slot: Slot,
	appId: number,
	filename: string,
): Promise<void> {
	if (!env.FIXES_QUEUE) throw new FixesFailure('QUEUE_CONFIG');
	const token = crypto.randomUUID();
	const rows =
		await sql`insert into fixes_package_jobs(fix_id,revision,slot,app_id,filename,status,request_token,lease_token,lease_expires_at)
 values(${fixId},${revision},${slot},${appId}::bigint,${filename},'processing',${token}::uuid,${token}::uuid,now()+interval '5 minutes')
 on conflict(fix_id,revision,slot) do update set status='processing',request_token=excluded.request_token,
 lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,work_started_at=null,error_code=null,next_retry_at=null,
 attempts=fixes_package_jobs.attempts+1,updated_at=now()
 where (fixes_package_jobs.status='processing' and fixes_package_jobs.lease_expires_at<=now())
 or (fixes_package_jobs.status<>'processing' and (fixes_package_jobs.next_retry_at is null or fixes_package_jobs.next_retry_at<=now())) returning fix_id`;
	if (!rows.length) return;
	try {
		await env.FIXES_QUEUE.send({ kind: 'fixes', fixId, revision, slot, requestToken: token });
	} catch {
		await sql`update fixes_package_jobs set status='failed',error_code='QUEUE_UNAVAILABLE',next_retry_at=now()+interval '60 seconds',
 lease_token=null,lease_expires_at=null where fix_id=${fixId} and revision=${revision} and slot=${slot} and request_token=${token}::uuid and work_started_at is null`;
		throw new FixesFailure('QUEUE_UNAVAILABLE');
	}
}
export async function consumeFixesJob(message: FixesMessage, env: Env): Promise<'done' | 'busy'> {
	const sql = createDb(env);
	const token = crypto.randomUUID();
	try {
		const rows =
			await sql`update fixes_package_jobs set lease_token=${token}::uuid,work_started_at=now(),lease_expires_at=now()+interval '5 minutes'
   where fix_id=${message.fixId} and revision=${message.revision} and slot=${message.slot} and request_token=${message.requestToken}::uuid
   and status='processing' and (work_started_at is null or lease_expires_at<=now()) returning app_id,filename`;
		if (!rows.length) {
			const current =
				await sql`select status from fixes_package_jobs where fix_id=${message.fixId} and revision=${message.revision} and slot=${message.slot} and request_token=${message.requestToken}::uuid`;
			return current[0]?.status === 'processing' ? 'busy' : 'done';
		}
		let stage = 'revision_check';
		try {
			const heartbeat = async () => {
				const owned = await sql`update fixes_package_jobs set lease_expires_at=now()+interval '5 minutes',updated_at=now()
    where fix_id=${message.fixId} and revision=${message.revision} and slot=${message.slot} and lease_token=${token}::uuid and status='processing' and lease_expires_at>now() returning fix_id`;
				if (!owned.length) throw new FixesFailure('LEASE_LOST');
			};
			const current = await sql`select revision,active from fixes_entries where fix_id=${message.fixId}`;
			if (!current[0]?.active || current[0].revision !== message.revision) throw new FixesFailure('REVISION_CHANGED');
			const key = packageObjectKey(message.fixId, message.revision, message.slot, token);
			let filename: string = rows[0].filename;
			let result: { size: number; sha256: string };
			try {
				stage = 'provider_download';
				const source = await fetchFixPackage(sql, env, message.fixId, message.slot);
				stage = 'storage';
				result = await storePackage(env, key, source, filename, heartbeat);
			} catch (error) {
				if (message.slot !== 'fix' || message.fixId.startsWith('ryuu:') || !canFallbackToRyuu(error)) throw error;
				console.warn('fixes_ryuu_fallback', { app_id: String(rows[0].app_id), ...jobDiagnostic(error, stage) });
				await heartbeat();
				stage = 'ryuu_fallback_download';
				const fallback = await fetchRyuuFallbackPackage(sql, env, Number(rows[0].app_id));
				filename = fallback.filename;
				stage = 'ryuu_fallback_storage';
				result = await storePackage(env, key, fallback.source, filename, heartbeat);
			}
			stage = 'revision_recheck';
			const latest = await sql`select revision,active from fixes_entries where fix_id=${message.fixId}`;
			if (!latest[0]?.active || latest[0].revision !== message.revision) throw new FixesFailure('REVISION_CHANGED');
			stage = 'publish_ready';
			await sql`update fixes_package_jobs set status='ready',filename=${filename},r2_object_key=${key},sha256=${result.sha256},size_bytes=${result.size}::bigint,
    lease_token=null,lease_expires_at=null,error_code=null,next_retry_at=null,updated_at=now()
    where fix_id=${message.fixId} and revision=${message.revision} and slot=${message.slot} and lease_token=${token}::uuid and status='processing' and lease_expires_at>now()`;
		} catch (error) {
			const diagnostic = jobDiagnostic(error, stage);
			const code = diagnostic.code;
			console.error('fixes_job_failed', { ...diagnostic, app_id: String(rows[0].app_id), slot: message.slot });
			await sql`update fixes_package_jobs set status='failed',error_code=${code},next_retry_at=now()+interval '60 seconds',lease_token=null,lease_expires_at=null,updated_at=now()
    where fix_id=${message.fixId} and revision=${message.revision} and slot=${message.slot} and lease_token=${token}::uuid and status='processing' and lease_expires_at>now()`;
		}
		return 'done';
	} finally {
		await sql.end({ timeout: 5 });
	}
}

// Never log raw messages/stacks: database errors and URLs can contain credentials.
export function jobDiagnostic(error: unknown, stage: string) {
	const nativeCode = error && typeof error === 'object' && 'code' in error &&
		typeof error.code === 'string' && /^(?:[0-9A-Z]{5}|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECT_TIMEOUT|CONNECTION_DESTROYED)$/.test(error.code)
		? error.code : undefined;
	return {
		code: error instanceof FixesFailure ? error.code : nativeCode ? `PACKAGE_DB_${nativeCode}` : `PACKAGE_${stage.toUpperCase()}_FAILED`,
		stage,
		error_name: error instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(error.name) ? error.name : 'UnknownError',
		...(error instanceof FixesFailure && error.upstreamStatus ? { upstream_status: error.upstreamStatus } : {}),
	};
}
