import type { Sql } from "./db";
import type postgres from "postgres";

/** Semua slot dihitung oleh jam DB, termasuk upsert pada pergantian sesi. */
export async function downloadAllowance(sql: Sql, userId: string): Promise<boolean> {
	const rows = await sql`
		select download_count, daily_limit from user_download_daily_usage
		where user_id = ${userId}::bigint
		and usage_day = (now() at time zone 'Asia/Jakarta')::date
		and session_slot = (extract(hour from now() at time zone 'Asia/Jakarta')::int / 12)
	`;
	return !rows[0] || Number(rows[0].download_count) < Number(rows[0].daily_limit);
}

/** Dipanggil DALAM transaksi bersama kepemilikan/kupon; rollback bila ditolak. */
export async function reserveDownload(sql: postgres.TransactionSql, userId: string): Promise<boolean> {
	const rows = await sql`
		insert into user_download_daily_usage (user_id, usage_day, session_slot, download_count)
		values (${userId}::bigint, (now() at time zone 'Asia/Jakarta')::date,
			(extract(hour from now() at time zone 'Asia/Jakarta')::int / 12), 1)
		on conflict (user_id, usage_day, session_slot) do update
		set download_count = user_download_daily_usage.download_count + 1, updated_at = now()
		where user_download_daily_usage.download_count < user_download_daily_usage.daily_limit
		returning download_count
	`;
	return rows.length > 0;
}
