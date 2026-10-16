import csv
import datetime
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / 'outputs/ryuu_compare_2026-10-16_2/enriched_2026-10-16/with_ryuu_tag_fallback'
source = base / 'games_missing_with_ryuu_tags.csv'
output = base / 'postgres_import'
counter = 1
while output.exists():
    output = base / f'postgres_import_{counter}'
    counter += 1
output.mkdir()
original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
with source.open(encoding='utf-8-sig', newline='') as file:
    reader = csv.DictReader(file)
    headers = reader.fieldnames
    rows = list(reader)
array_fields = ['genre', 'categories', 'publishers']
empty_arrays = dict.fromkeys(array_fields, 0)
for row in rows:
    assert row['app_id'].isdigit() and 0 < int(row['app_id']) < 2**63
    assert row['name'].strip()
    if row['release_date']:
        datetime.date.fromisoformat(row['release_date'])
    for field in array_fields:
        value = json.loads(row[field]) if row[field].strip() else []
        assert isinstance(value, list) and all(isinstance(item, str) for item in value)
        empty_arrays[field] += not value
        row[field] = '{' + ','.join('"' + item.replace('\\', '\\\\').replace('"', '\\"') + '"' for item in value) + '}'
target = output / 'games_missing_postgres.csv'
with target.open('w', encoding='utf-8-sig', newline='') as file:
    writer = csv.DictWriter(file, fieldnames=headers)
    writer.writeheader()
    writer.writerows(rows)
with target.open(encoding='utf-8-sig', newline='') as file:
    reader = csv.DictReader(file)
    assert reader.fieldnames == headers
    actual = list(reader)
assert actual == rows and len(rows) == 3592
assert len({row['app_id'] for row in rows}) == len(rows)
assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
report = {'rows': len(rows), 'unique_appids': len(rows), 'array_fields': array_fields, 'empty_arrays_as_braces': empty_arrays,
          'original_sha256': original_hash, 'output': str(target)}
(output / 'validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
(output / 'README.md').write_text('''# CSV untuk import langsung ke public.game_lists

- 3.592 AppID unik; delapan kolom tetap sama dengan template.
- genre/categories/publishers sekarang berupa literal PostgreSQL text[], misalnya {"Action","Indie"}.
- Array kosong ditulis {} secara eksplisit, bukan kosong/NULL atau JSON [].
- id, search_key, created_at dan updated_at tidak disertakan; database mengisinya.
- Kolom opsional teks/tanggal yang kosong diimpor sebagai NULL.
- Tidak mengubah schema, menghapus data, atau menjalankan import database.

Jika masih terjadi error, periksa nama constraint:
- steam_games_app_id_key: AppID sudah ada di database tujuan. Snapshot sebelumnya bukan bukti keadaan database sekarang.
- steam_games_pkey: id bentrok; identity sequence mungkin tertinggal setelah import id manual. File ini tidak mengirim id.
- NOT NULL genre/categories/publishers: periksa mapping importer; file ini memakai {} untuk array kosong.
- malformed array literal: pastikan memakai CSV baru ini, bukan versi array JSON sebelumnya.
- Error audit_change/set_updated_at: perlu pesan error fungsi/trigger sebenarnya; CSV tidak dapat memperbaiki fungsi server.
''', encoding='utf-8')
print(json.dumps(report, indent=2))
