"""Compare supplied catalog snapshots by numeric Steam AppID. Never modifies sources."""
import collections
import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path

csv.field_size_limit(2**31 - 1)
SOURCE = Path(r'C:\Users\samue\Downloads')
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'outputs' / 'ryuu_compare_2026-10-16'
suffix = 1
while OUTPUT.exists():
    OUTPUT = ROOT / 'outputs' / f'ryuu_compare_2026-10-16_{suffix}'
    suffix += 1
OUTPUT.mkdir(parents=True)


def appid(value):
    value = str(value or '').strip()
    return str(int(value)) if re.fullmatch(r'[0-9]+', value) and int(value) > 0 else None


def namekey(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


sources = {name: SOURCE / name for name in ['game_lists_rows.csv', 'RYU GAME LIST.json', 'games-template (1).csv']}
hashes = {name: digest(path) for name, path in sources.items()}
with sources['games-template (1).csv'].open(encoding='utf-8-sig', newline='') as file:
    template = next(csv.reader(file))
assert template == ['app_id', 'name', 'image', 'description', 'genre', 'release_date', 'categories', 'publishers']

catalog = {}
catalog_names = collections.defaultdict(set)
db_rows = db_invalid = db_duplicates = 0
with sources['game_lists_rows.csv'].open(encoding='utf-8-sig', newline='') as file:
    for row in csv.DictReader(file):
        db_rows += 1
        key = appid(row.get('app_id'))
        if key is None:
            db_invalid += 1
            continue
        db_duplicates += key in catalog
        catalog.setdefault(key, row.get('name', ''))
        catalog_names[namekey(row.get('name'))].add(key)

ryuu_raw = json.loads(sources['RYU GAME LIST.json'].read_text(encoding='utf-8-sig'))
assert isinstance(ryuu_raw, list)
ryuu = {}
ryuu_invalid = ryuu_duplicates = 0
for row in ryuu_raw:
    key = appid(row.get('appid')) if isinstance(row, dict) else None
    if key is None:
        ryuu_invalid += 1
        continue
    if key in ryuu:
        ryuu_duplicates += 1
        # Deterministic source choice; latest ISO update wins, no metadata invention.
        if str(row.get('updated_date', '')) <= str(ryuu[key].get('updated_date', '')):
            continue
    ryuu[key] = row

missing_ids = set(ryuu) - set(catalog)
matched_ids = set(ryuu) & set(catalog)
missing = [(key, ryuu[key]) for key in sorted(missing_ids, key=int)]
games = [(key, row) for key, row in missing if str(row.get('type', '')).strip().casefold() == 'game']
candidate_games_count = len(games)
missing_types = collections.Counter(str(row.get('type') or 'unknown').strip().casefold() for _, row in missing)
review_count = sum(bool(catalog_names.get(namekey(row.get('name')))) for _, row in missing)
empty_names = [key for key, row in missing if not str(row.get('name') or '').strip()]
importable = [(key, row) for key, row in missing if key not in empty_names]
games = [(key, row) for key, row in games if key not in empty_names]


def write_template(filename, entries):
    with (OUTPUT / filename).open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=template)
        writer.writeheader()
        for key, row in entries:
            writer.writerow({'app_id': key, 'name': row['name'], 'image': row.get('header_image') or '',
                             'description': '', 'genre': '', 'release_date': '', 'categories': '', 'publishers': ''})


write_template('games_missing_template.csv', games)
write_template('all_missing_template.csv', importable)

audit_columns = ['app_id', 'name', 'ryuu_type', 'status', 'same_name_other_appids', 'ryuu_tags', 'ryuu_added_date', 'ryuu_updated_date', 'image']
with (OUTPUT / 'missing_audit.csv').open('w', encoding='utf-8-sig', newline='') as file:
    writer = csv.DictWriter(file, fieldnames=audit_columns)
    writer.writeheader()
    for key, row in missing:
        writer.writerow({'app_id': key, 'name': row.get('name') or '', 'ryuu_type': row.get('type') or 'unknown',
                         'status': 'NOT_IN_GAME_LISTS',
                         'same_name_other_appids': ';'.join(sorted(catalog_names.get(namekey(row.get('name')), []) if namekey(row.get('name')) else [], key=int)),
                         'ryuu_tags': json.dumps(row.get('tags', []), ensure_ascii=False),
                         'ryuu_added_date': row.get('added_date', ''), 'ryuu_updated_date': row.get('updated_date', ''),
                         'image': row.get('header_image') or ''})

# Independently read final CSVs back; compare AppID sets, headers, row counts and cells.
for filename, entries in [('games_missing_template.csv', games), ('all_missing_template.csv', importable)]:
    with (OUTPUT / filename).open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file)
        assert reader.fieldnames == template
        rows = list(reader)
    expected = {key for key, _ in entries}
    assert len(rows) == len(expected)
    assert {row['app_id'] for row in rows} == expected
    assert not expected & set(catalog)
    for row in rows:
        original = ryuu[row['app_id']]
        assert row['name'] == original['name'] and row['image'] == (original.get('header_image') or '')
        assert all(row[column] == '' for column in template if column not in ['app_id', 'name', 'image'])
with (OUTPUT / 'missing_audit.csv').open(encoding='utf-8-sig', newline='') as file:
    assert sum(1 for _ in csv.DictReader(file)) == len(missing)
assert hashes == {name: digest(path) for name, path in sources.items()}, 'Source files changed during comparison'
assert len(ryuu) == len(missing_ids) + len(matched_ids)
assert len(catalog) == len(matched_ids) + len(set(catalog) - set(ryuu))

summary = {'database_rows': db_rows, 'database_unique_appids': len(catalog), 'database_invalid_rows': db_invalid,
           'database_duplicate_rows': db_duplicates, 'ryuu_rows': len(ryuu_raw), 'ryuu_unique_appids': len(ryuu),
           'ryuu_invalid_rows': ryuu_invalid, 'ryuu_duplicate_rows': ryuu_duplicates,
           'present_in_both': len(matched_ids), 'ryuu_missing_all_types': len(missing), 'ryuu_missing_games_only': candidate_games_count,
           'games_template_rows': len(games),
           'catalog_only': len(set(catalog) - set(ryuu)), 'missing_type_counts': dict(missing_types),
           'missing_same_name_other_appid': review_count,
           'all_types_template_rows': len(importable), 'excluded_missing_names': empty_names,
           'missing_image_all_types': sum(not row.get('header_image') for _, row in missing),
           'missing_image_games': sum(not row.get('header_image') for _, row in games),
           'matched_different_names': sum(ryuu[key].get('name') != catalog[key] for key in matched_ids)}
lines = ['# Report perbandingan Ryuu dan game_lists', '',
         'Perbandingan offline atas file yang diberikan, bukan pemeriksaan database/provider live. AppID numerik adalah kunci pencocokan; nama tidak digunakan untuk menggabungkan game.', '',
         '| Ukuran | Jumlah |', '|---|---:|',
         *[f'| {label} | {value:,} |' for label, value in [
             ('Baris game_lists', db_rows), ('AppID unik game_lists', len(catalog)), ('Baris Ryuu', len(ryuu_raw)),
             ('AppID unik Ryuu', len(ryuu)), ('Ada di kedua sumber', len(matched_ids)),
             ('Ryuu belum ada di game_lists, semua tipe', len(missing)), ('Ryuu belum ada, khusus Game/game', candidate_games_count),
             ('Khusus game, nama lengkap, siap template', len(games)),
             ('Hanya ada di game_lists', summary['catalog_only'])]], '',
         '## File hasil', '',
         f'- `games_missing_template.csv`: {len(games):,} game dengan tipe Game/game; ini file utama untuk menambah katalog game.',
         f'- `all_missing_template.csv`: {len(importable):,} entri bernama yang belum ada, termasuk game, demo, DLC, musik, tool, dan tipe lain. Jangan dianggap semuanya game utama.',
         f'- `missing_audit.csv`: {len(missing):,} entri beserta tipe, tags, tanggal sumber, dan kandidat nama sama dengan AppID lain.', '',
         '## Tipe entri yang belum ada', '', '| Tipe Ryuu (huruf kecil) | Jumlah |', '|---|---:|',
         *[f'| {kind} | {count:,} |' for kind, count in sorted(missing_types.items(), key=lambda item: (-item[1], item[0]))], '',
         '## Pemetaan template', '',
         '- `appid` Ryuu -> `app_id`; `name` -> `name`; `header_image` -> `image`.',
         '- `description`, `genre`, `release_date`, `categories`, dan `publishers` kosong karena tidak tersedia sebagai metadata tersebut pada JSON sumber.',
         '- `tags` tidak diklaim sebagai genre resmi. Nilainya tetap tersedia pada kolom `ryuu_tags` di file audit.',
         '- `added_date` dan `updated_date` adalah waktu entri Ryuu, bukan tanggal rilis; keduanya hanya disertakan dalam audit.',
         '- Header dan urutan delapan kolom mengikuti games-template (1).csv. CSV UTF-8 BOM, dengan escaping standar untuk koma, kutip, dan baris baru.', '',
         '## Pemeriksaan dan keterbatasan', '',
         f'- Duplikat/ID invalid game_lists: {db_duplicates}/{db_invalid}; Ryuu: {ryuu_duplicates}/{ryuu_invalid}.',
         f'- {len(empty_names)} entri belum ada tetapi namanya kosong: AppID {", ".join(empty_names) or "tidak ada"}. Entri ini ada di audit, tetapi dikeluarkan dari template import agar tidak menambahkan game tanpa nama.',
         f'- Ada {review_count:,} entri belum ada yang namanya sama setelah normalisasi huruf/spasi dengan AppID lain di katalog. Tetap dipertahankan karena AppID berbeda; lihat same_name_other_appids di audit.',
         f'- Ada {summary["matched_different_names"]:,} AppID cocok yang nama mentahnya berbeda. Ini tidak dianggap game baru.',
         f'- Gambar kosong: {summary["missing_image_games"]:,} khusus game; {summary["missing_image_all_types"]:,} semua tipe.',
         '- Semua CSV dibaca ulang dan jumlah, header, set AppID, nama, gambar, serta kolom kosong diverifikasi. Tidak ada AppID output yang sudah tercantum pada snapshot game_lists.',
         '- Tidak mengambil metadata/API tambahan, menguji URL gambar, mengunduh Lua, atau menjalankan import/SQL. Belum ada data database yang diubah.',
         '- Keberadaan pada daftar Ryuu tidak menjamin file Lua tersedia saat nanti diunduh.', '',
         '## Sumber dan SHA-256', '',
         *[f'- `{name}`: `{hashes[name]}`' for name in sources], '']
(OUTPUT / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
(OUTPUT / 'validation.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'output_directory': str(OUTPUT), **summary}, ensure_ascii=True, indent=2))
