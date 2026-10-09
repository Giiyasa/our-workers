/**
 * GET /api/curated — koleksi mingguan game pilihan.
 *
 * Setiap minggu seed-nya berganti (berdasarkan ISO week number),
 * jadi game yang muncul tetap selama seminggu lalu berubah.
 *
 * Tambahan section lain di masa depan cukup menambah properti baru
 * di respons — misal: { our_picks: [...], popular: [...], ... }.
 *
 * Respons saat ini:
 *   {
 *     ok: true,
 *     week: "2026-W41",
 *     our_picks: [...],        // 15 game random, ganti mingguan
 *     hero: {...} | null        // 1 game dari publisher terkenal, ganti harian
 *   }
 */

import { syncHomeFeed } from '../lib/home-feed';
import { TABLE_GAME } from '../config';
import { json } from '../lib/http';
import { shapeGame } from '../shape';
import type { DbRoute } from '../lib/types';

/** Jumlah game yang diambil untuk Our Picks. */
const OUR_PICKS_COUNT = 15;

/**
 * Publisher yang dianggap "terkenal" — game dari publisher ini dipilih
 * untuk hero harian (berganti tiap hari). Daftar diisi sesuai data yang
 * ada di tabel game_lists. Case-sensitive karena dibanding langsung dengan
 * nilai kolom `publishers` (array).
 */
const FAMOUS_PUBLISHERS = [
	'Valve',
	'Bethesda Softworks',
	'Electronic Arts',
	'Ubisoft',
	'Square Enix',
	'CAPCOM',
	'Rockstar Games',
	'2K',
	'Blizzard Entertainment',
	'CD PROJEKT RED',
	'WB Games',
	'Sega',
	'Bandai Namco Entertainment',
	'Klei Entertainment',
	'Epic Games',
	'Paradox Interactive',
	'Devolver Digital',
	'Coffee Stain Studios',
	'Team17',
	'THQ Nordic',
	'Raw Fury',
	'Firaxis Games',
	'Obsidian Entertainment',
	'Larian Studios',
	'Hello Games',
	'Red Hook Studios',
	'Supergiant Games',
	'Motion Twin',
	'Behaviour Interactive',
	'Gaijin Entertainment',
	'Riot Games',
	'Activision',
	'Mojang',
	'Microsoft Studios',
	'Sony Interactive Entertainment',
	'Nintendo',
	'SEGA',
	'Deep Silver',
	'Focus Entertainment',
];

function isoWeekKey(): string {
	const now = new Date();
	const jan1 = new Date(Date.UTC(now.getFullYear(), 0, 1));
	const daysSinceJan1 = Math.floor(
		(now.getTime() - jan1.getTime()) / 86_400_000,
	);
	const week = Math.ceil((daysSinceJan1 + jan1.getUTCDay() + 1) / 7);
	return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Key harian YYYY-MM-DD untuk seed hero. */
function dayKey(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Hash sederhana dari string jadi angka 32-bit. */
function stringHash(s: string): number {
	let hash = 0;
	for (let i = 0; i < s.length; i++) {
		const char = s.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash |= 0;
	}
	return hash;
}

/** Konversi hash ke seed [0,1) dengan XOR shift. */
function seedFromKey(key: string): number {
	const h = stringHash(key);
	let x = h ^ 0x9e3779b9;
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	return (x & 0x7fffffff) / 0x7fffffff;
}

/**
 * Bangun kondisi SQL `g.publishers @> ARRAY[publisher]` untuk setiap
 * publisher terkenal, dirangkai dengan OR. Memakai operator `@>` karena
 * kolom `publishers` bertipe array.
 */
function famousPublisherCondition(): string {
	return FAMOUS_PUBLISHERS.map(
		(p) => `g.publishers @> ARRAY['${p.replace(/'/g, "''")}']`,
	).join(' or ');
}

export const curatedRoute: DbRoute = {
	method: 'GET',
	path: '/api/curated',
	token: 'none',
	requiresDb: true,
	prepare: () => ({ input: undefined }),
	handle: async ({}, _input, sql) => {
		const feed = await sql`select f.section, f.updated_at as feed_updated_at, f.source_period, g.* from home_feed f
 cross join lateral jsonb_to_recordset(f.entries) as e(appid bigint, rank integer)
 join game_lists g on g.app_id=e.appid order by f.section,e.rank`;
        const mostPlayed = feed.filter(row => row.section === 'most_played');
        const newReleases = feed.filter(row => row.section === 'popular_new_releases');
        const weekKey = isoWeekKey();
		const wkSeed = seedFromKey(weekKey);
		const dKey = dayKey();
		const daySeed = seedFromKey(dKey);

		// Our Picks — 15 game random mingguan (stabil seminggu)
		await sql`select setseed(${wkSeed})`;
		const picks = await sql`
			select
				g.id,
				g.app_id,
				g.is_unavailable_game,
				g.name,
				g.image,
				g.description,
				g.genre,
				g.categories,
				g.publishers,
				g.release_date,
				g.created_at,
				g.updated_at
			from ${sql(TABLE_GAME)} g
			where g.image is not null and g.image != ''
			order by random()
			limit ${OUR_PICKS_COUNT}
		`;

		// Hero — 1 game dari publisher terkenal, random harian (stabil sehari)
		await sql`select setseed(${daySeed})`;
		const publisherConditions = FAMOUS_PUBLISHERS.map(
			(p) => sql`${p} = any(g.publishers)`,
		);
		const heroWhere = publisherConditions.reduce((a, b) => sql`${a} or ${b}`);
		const heroRows = await sql`
			select
				g.id,
				g.app_id,
				g.is_unavailable_game,
				g.name,
				g.image,
				g.description,
				g.genre,
				g.categories,
				g.publishers,
				g.release_date,
				g.created_at,
				g.updated_at
			from ${sql(TABLE_GAME)} g
			where g.image is not null and g.image != ''
			  and (${heroWhere})
			order by random()
			limit 1
		`;

		return json({
			ok: true,
			week: weekKey,
            most_played: mostPlayed.map(shapeGame),
            popular_new_releases: newReleases.map(shapeGame),
            feed_updated_at: mostPlayed[0]?.feed_updated_at ?? null,
            releases_period: newReleases[0]?.source_period ?? null,
			our_picks: picks.length ? picks.map(shapeGame) : [],
			hero: heroRows.length ? shapeGame(heroRows[0]) : null,
		});
	},
};

export const homeSyncRoute: DbRoute = {
 method:'POST',path:'/api/admin/home/sync',token:'write',requiresDb:true,
 handle:async (_ctx,_input,sql) => json({ok:true,sections:await syncHomeFeed(sql,new Date(),(_ctx.env as Env & {STEAM_API_KEY?:string}).STEAM_API_KEY)}),
};
