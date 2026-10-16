import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gamesListRoute } from '../src/routes/games-list';
import { saveSteamSearchGames } from '../src/lib/steam-search';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';

vi.mock('../src/lib/fuzzy', () => ({ hasLevenshtein: async () => false }));

type Fragment = { parts: readonly string[]; values: unknown[] };
const fragment = (parts: readonly string[], values: unknown[]): Fragment => ({ parts, values });

function databaseSql(db: PGlite): Sql {
  function compile(value: unknown, params: unknown[]): string {
    if (value && typeof value === 'object' && 'parts' in value && 'values' in value) {
      const node = value as Fragment;
      return node.parts.reduce((query, part, index) =>
        query + (index === 0 ? '' : compile(node.values[index - 1], params)) + part, '');
    }
    if (value && typeof value === 'object' && 'identifier' in value) {
      return `"${String((value as { identifier: string }).identifier).replaceAll('"', '""')}"`;
    }
    if (value && typeof value === 'object' && 'list' in value) {
      return `(${(value as { list: unknown[] }).list.map((item) => compile(item, params)).join(', ')})`;
    }
    params.push(value);
    return `$${params.length}`;
  }

  const sql = ((first: TemplateStringsArray | string | unknown[], ...values: unknown[]) => {
    if (typeof first === 'string') return { identifier: first };
    if (Array.isArray(first) && !('raw' in first)) return { list: first };
    const node = fragment(first as TemplateStringsArray, values);
    return {
      ...node,
      then: (resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) => {
        const params: unknown[] = [];
        return db.query(compile(node, params), params).then((result) => resolve(result.rows), reject);
      },
    };
  }) as Sql;
  Object.assign(sql, { begin: (callback: (tx: Sql) => unknown) => db.transaction(tx => callback(databaseSql(tx as unknown as PGlite))) });
  return sql;
}

let db: PGlite | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe('Steam search catalog imports', () => {
  it('inserts concurrently without duplicates and preserves existing catalog metadata and flags', async () => {
    db = new PGlite();
    await db.exec(`create table game_lists (
      id bigint generated always as identity primary key, app_id bigint not null, name text not null,
      image text, description text, genre text[], categories text[], publishers text[],
      is_unavailable_game boolean default false,
      search_key text generated always as (lower(name)) stored
    );
    insert into game_lists(app_id,name,is_unavailable_game) values(620,'Existing title',true);`);
    const games = [{ app_id: 620, name: 'Replacement', image: 'https://image.test/a.jpg', description: null, genre: ['Action'], categories: [] },
      { app_id: 730, name: 'New Steam Game', image: 'https://image.test/b.jpg', description: 'Steam description', genre: ['Action'], categories: ['Multi-player'] }];
    const sql = databaseSql(db);
    const results = await Promise.all([saveSteamSearchGames(sql, games), saveSteamSearchGames(sql, games)]);
    expect(results[0].map(row => Number(row.app_id))).toEqual([620, 730]);
    expect((await db.query('select count(*)::int as n from game_lists')).rows).toEqual([{ n: 2 }]);
    const rows = (await db.query('select * from game_lists order by app_id')).rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ name: 'Existing title', is_unavailable_game: true });
    expect(rows[1]).toMatchObject({ name: 'New Steam Game', genre: ['Action'], categories: ['Multi-player'], search_key: 'new steam game' });
    expect(results[0].map(row => row.id)).toEqual(results[1].map(row => row.id));
  });
});

async function request(sql: Sql, page: number, pageSize: number, category = '', countOnly = false) {
  const url = new URL(`https://fixture.test/api/games?page=${page}&page_size=${pageSize}&count_only=${countOnly}`);
  if (category) url.searchParams.set('category', category);
  const context = { url, request: new Request(url) } as RouteContext;
  const prepared = await gamesListRoute.prepare!(context);
  if (prepared instanceof Response) throw new Error('Unexpected validation failure');
  return (await gamesListRoute.handle(context, prepared.input, sql)).json() as Promise<any>;
}

describe('catalog duplicate AppIDs', () => {
  it('groups verified Steam redirects before count and pagination, preserving usable AppIDs', async () => {
    db = new PGlite();
    await db.exec(`
      create table game_lists (
        id bigint primary key, app_id bigint unique not null, name text, image text,
        description text, genre text[], categories text[], publishers text[],
        release_date date, created_at timestamptz, updated_at timestamptz,
        is_unavailable_game boolean, search_key text
      );
      create table game_assets (game_id bigint, lua_data text, meta_data text);
      insert into game_lists (id, app_id, name, categories, release_date) values
        (1, 1962660, 'Modern Warfare II', array['PvP'], '2022-01-01'),
        (2, 3595230, 'Modern Warfare II', array['PvP'], '2022-01-01'),
        (3, 2519060, 'Modern Warfare III', array['PvP'], '2023-01-01'),
        (4, 3595270, 'Modern Warfare III', array['PvP'], '2023-01-01'),
        (5, 7000, 'Another Game', array['PvP'], '2021-01-01'),
        (6, 7001, 'Another Game', array['PvP'], '2021-01-01');
      insert into game_assets (game_id, lua_data) values (1962660, 'lua');
    `);
    const sql = databaseSql(db);

    expect(await request(sql, 1, 2, '', true)).toMatchObject({ total: 4, total_pages: 2 });
    const first = await request(sql, 1, 2);
    const second = await request(sql, 2, 2);
    expect(first).toMatchObject({ count: 2, total: 4, total_pages: 2, has_more: true });
    expect(second).toMatchObject({ count: 2, total: 4, total_pages: 2, has_more: false });
    const ids = [...first.data, ...second.data].map((game: { app_id: number }) => Number(game.app_id));
    expect(ids).toEqual([3595270, 1962660, 7000, 7001]);
  });

  it('keeps a matching legacy AppID when the current AppID fails a filter', async () => {
    db = new PGlite();
    await db.exec(`
      create table game_lists (
        id bigint primary key, app_id bigint unique, name text, image text,
        description text, genre text[], categories text[], publishers text[],
        release_date date, created_at timestamptz, updated_at timestamptz,
        is_unavailable_game boolean, search_key text
      );
      create table game_assets (game_id bigint, lua_data text, meta_data text);
      insert into game_lists (id, app_id, name, categories) values
        (1, 1962660, 'Modern Warfare II', array['Legacy']),
        (2, 3595230, 'Modern Warfare II', array['PvP']);
    `);
    const sql = databaseSql(db);
    expect(await request(sql, 1, 24, 'Legacy', true)).toMatchObject({ total: 1 });
    const page = await request(sql, 1, 24, 'Legacy');
    expect(page.data.map((game: { app_id: number }) => Number(game.app_id))).toEqual([1962660]);
  });
});
