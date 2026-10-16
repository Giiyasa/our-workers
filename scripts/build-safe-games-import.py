import csv
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / 'outputs/ryuu_compare_2026-10-16_2/enriched_2026-10-16/with_ryuu_tag_fallback'
out = base / 'postgres_import_clean'
out.mkdir(exist_ok=True)
with (base / 'games_missing_with_ryuu_tags.csv').open(encoding='utf-8-sig', newline='') as file:
    reader = csv.DictReader(file)
    columns = reader.fieldnames
    rows = list(reader)
records = []
csv_rows = []
cleaned = 0
for row in rows:
    record = dict(row)
    record['app_id'] = int(record['app_id'])
    record['release_date'] = record['release_date'] or None
    for key in ['genre', 'categories', 'publishers']:
        values = json.loads(row[key]) if row[key].strip() else []
        assert isinstance(values, list) and all(isinstance(value, str) for value in values)
        clean = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        cleaned += clean != values
        record[key] = clean
    records.append(record)
    csv_row = dict(row)
    for key in ['genre', 'categories', 'publishers']:
        csv_row[key] = '{' + ','.join('"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"' for value in record[key]) + '}'
    csv_rows.append(csv_row)
with (out / 'games_missing_postgres_clean.csv').open('w', encoding='utf-8-sig', newline='') as file:
    writer = csv.DictWriter(file, fieldnames=columns)
    writer.writeheader()
    writer.writerows(csv_rows)
patch = (root / 'supabase/GAME_LISTS_IDENTITY_SEQUENCE_PATCH.sql').read_text(encoding='utf-8')
# Keep the sequence repair and inserts in one transaction with the table write lock.
patch = patch[:patch.index('commit;')]
sql = [
    '-- Import missing AppIDs only; existing rows are preserved.',
    '-- Empty arrays are explicit text[] values, never NULL. No CSV importer is involved.',
    patch, 'set local standard_conforming_strings = on;',
]
for offset in range(0, len(records), 200):
    payload = json.dumps(records[offset:offset + 200], ensure_ascii=False, separators=(',', ':')).replace("'", "''")
    sql.append(f'''insert into public.game_lists(app_id,name,image,description,genre,release_date,categories,publishers)
select r.app_id,r.name,nullif(r.image,''),nullif(r.description,''),
       coalesce(r.genre,'{{}}'::text[]),r.release_date,
       coalesce(r.categories,'{{}}'::text[]),coalesce(r.publishers,'{{}}'::text[])
from jsonb_to_recordset('{payload}'::jsonb)
as r(app_id bigint,name text,image text,description text,genre text[],release_date date,categories text[],publishers text[])
on conflict(app_id) do nothing;''')
sql.append('commit;')
(out / 'IMPORT_MISSING_GAMES.sql').write_text('\n\n'.join(sql), encoding='utf-8')
(out / 'records_for_validation.json').write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'rows': len(records), 'array_cells_cleaned': cleaned,
                  'target_publisher': next(row['publishers'] for row in records if row['app_id'] == 263500), 'directory': str(out)}))
