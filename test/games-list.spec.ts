import { afterEach, describe, expect, it, vi } from 'vitest';
import { gamesListRoute } from '../src/routes/games-list';
import { COUNT_BUDGET_MS } from '../src/config';
import type { Sql } from '../src/lib/db';
import type { RouteContext } from '../src/lib/types';

vi.mock('../src/lib/fuzzy', () => ({ hasLevenshtein: async () => false }));
afterEach(() => vi.useRealTimers());

function fakeSql(count: number | 'failed' | 'pending', rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: index + 1, app_id: 1000 + index, name: `Game ${index}`, genre: [], categories: [], publishers: [],
  }));
  return ((parts: TemplateStringsArray | string) => {
    if (typeof parts === 'string') return parts;
    const text = parts.join(' ');
    if (text.includes('as total')) {
      if (count === 'failed') return Promise.reject(new Error('Count unavailable'));
      if (count === 'pending') return new Promise(() => {});
      return Promise.resolve([{ total: count }]);
    }
    if (text.includes('g.app_id')) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as unknown as Sql;
}

async function list(count: number | 'failed' | 'pending', rowCount: number, page = 2, search = '') {
  const url = new URL(`https://fixture.test/api/games?page=${page}&page_size=24&search=${search}`);
  const context = { url, request: new Request(url) } as RouteContext;
  const prepared = await gamesListRoute.prepare!(context);
  if (prepared instanceof Response) throw new Error('Unexpected validation failure');
  return (await gamesListRoute.handle(context, prepared.input, fakeSql(count, rowCount))).json() as Promise<any>;
}

describe('catalog pagination metadata', () => {
  it('marks capped search counts approximate and preserves the next page', async () => {
    const body = await list(48, 25, 2, 'witcher');
    expect(body).toMatchObject({ page: 2, count: 24, total: 49, total_pages: 3, total_approximate: true, has_more: true });
    expect(body.data).toHaveLength(24);
  });

  it('returns exact totals when the count covers the entire catalog', async () => {
    expect(await list(77, 25)).toMatchObject({ total: 77, total_pages: 4, total_approximate: false, has_more: true });
  });

  it('uses the visible rows for a lower bound when counting fails', async () => {
    expect(await list('failed', 5, 4)).toMatchObject({ total: 77, total_pages: 4, total_approximate: true, has_more: false });
  });

  it('keeps a final search page exact and disables next', async () => {
    expect(await list(53, 5, 3, 'witcher')).toMatchObject({ total: 53, total_pages: 3, total_approximate: false, has_more: false });
  });

  it('does not suppress lookahead when the count and rows disagree', async () => {
    expect(await list(48, 25)).toMatchObject({ total: 49, total_approximate: true, has_more: true });
  });

  it('keeps responding within the existing count timeout budget', async () => {
    vi.useFakeTimers();
    const result = list('pending', 25);
    await vi.advanceTimersByTimeAsync(COUNT_BUDGET_MS + 1);
    expect(await result).toMatchObject({ total: 49, total_approximate: true, has_more: true });
  });

  it('does not invent occupied rows for an empty out-of-range page', async () => {
    expect(await list('failed', 0, 4)).toMatchObject({ total: 0, count: 0, total_approximate: true, has_more: false });
  });
});
