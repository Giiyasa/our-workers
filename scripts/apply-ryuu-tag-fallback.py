"""Apply explicitly authorized Ryuu tags only to empty genres; preserve prior outputs."""
import csv
import hashlib
import json
from pathlib import Path

csv.field_size_limit(2**31 - 1)
root = Path(__file__).resolve().parents[1]
base = root / 'outputs/ryuu_compare_2026-10-16_2/enriched_2026-10-16'
target = base / 'with_ryuu_tag_fallback'
index = 1
while target.exists():
    target = base / f'with_ryuu_tag_fallback_{index}'
    index += 1
target.mkdir()
inputs = [base / 'games_missing_completed.csv', base / 'enrichment_audit.csv', Path(r'C:\Users\samue\Downloads\RYU GAME LIST.json')]
hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}


def read_csv(path):
    with path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file)
        return reader.fieldnames, list(reader)


def blank(value):
    return not value.strip() or value.strip() in ('[]', 'null')


def write_csv(path, columns, rows):
    with path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


columns, original = read_csv(inputs[0])
audit_columns, previous_audit = read_csv(inputs[1])
audit_by_id = {row['app_id']: row for row in previous_audit}
ryuu = {str(int(row['appid'])): row for row in json.loads(inputs[2].read_text(encoding='utf-8-sig'))}
result = []
audits = []
updated = []
remaining = []
preserved = []
for original_row in original:
    row = dict(original_row)
    app_id = row['app_id']
    audit = dict(audit_by_id[app_id])
    sources = json.loads(audit['field_sources'])
    is_fallback = False
    if blank(row['genre']):
        raw_tags = ryuu.get(app_id, {}).get('tags')
        tags = list(dict.fromkeys(tag.strip() for tag in raw_tags if isinstance(tag, str) and tag.strip())) if isinstance(raw_tags, list) else []
        if tags:
            row['genre'] = json.dumps(tags, ensure_ascii=False, separators=(',', ':'))
            sources['genre'] = 'ryuu_tags_fallback'
            audit['fields_filled'] = ';'.join(dict.fromkeys(filter(None, audit['fields_filled'].split(';') + ['genre'])))
            audit['notes'] = ';'.join(filter(None, [audit['notes'], 'GENRE_FROM_RYUU_TAGS_NOT_OFFICIAL']))
            updated.append(app_id)
            is_fallback = True
        else:
            remaining.append(app_id)
    else:
        preserved.append(app_id)
    audit['field_sources'] = json.dumps(sources, ensure_ascii=False, separators=(',', ':'))
    audit['missing_fields'] = ';'.join(key for key in columns if key != 'app_id' and blank(row[key]))
    audit['genre_source'] = sources.get('genre', 'unavailable') if not blank(row['genre']) else 'unavailable'
    audit['genre_kind'] = 'ryuu_tags_fallback' if is_fallback else 'existing_metadata' if not blank(row['genre']) else 'empty'
    audits.append(audit)
    result.append(row)

output = target / 'games_missing_with_ryuu_tags.csv'
write_csv(output, columns, result)
write_csv(target / 'enrichment_audit.csv', audit_columns + ['genre_source', 'genre_kind'], audits)
actual_header, actual = read_csv(output)
assert actual_header == columns
assert len(actual) == len(original) == 3592
assert len({row['app_id'] for row in actual}) == len(actual)
for before, after in zip(original, actual):
    for column in columns:
        if column != 'genre' or not blank(before['genre']):
            assert before[column] == after[column]
    if after['app_id'] in updated:
        assert isinstance(json.loads(after['genre']), list) and json.loads(after['genre'])
assert hashes == {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
missing_by_field = {key: sum(blank(row[key]) for row in actual) for key in columns if key != 'app_id'}
summary = {'rows': len(actual), 'genre_existing_preserved': len(preserved), 'genre_filled_from_ryuu_tags': len(updated),
           'genre_still_empty': len(remaining), 'genre_still_empty_appids': remaining,
           'all_fields_nonempty': sum(not any(blank(row[key]) for key in columns if key != 'app_id') for row in actual),
           'missing_by_field': missing_by_field, 'input_sha256': hashes, 'output_directory': str(target)}
(target / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
lines = ['# Report fallback genre menggunakan tags Ryuu', '',
         'Tags Ryuu digunakan sebagai fallback atas persetujuan pengguna. Ini bukan klaim genre resmi Steam.', '',
         f'- Total: {len(actual):,} baris.', f'- Genre dari metadata sebelumnya dipertahankan: {len(preserved):,}.',
         f'- Genre kosong diisi dari tags Ryuu: {len(updated):,}.', f'- Genre tetap kosong karena tags tidak tersedia/kosong: {len(remaining):,}.',
         f'- Semua kolom terisi setelah fallback: {summary["all_fields_nonempty"]:,}.', '',
         '## Pemetaan dan audit', '',
         '- Pencocokan memakai AppID numerik yang sama. Tags dipertahankan sebagai array JSON berisi label sumber; label kosong dan duplikat dibuang.',
         '- Genre yang sudah berisi metadata tidak diganti. Tidak ada perubahan pada AppID, nama, gambar, deskripsi, tanggal rilis, kategori, atau publisher.',
         '- Audit menandai genre_source=ryuu_tags_fallback dan genre_kind=ryuu_tags_fallback, serta notes=GENRE_FROM_RYUU_TAGS_NOT_OFFICIAL.',
         '- Tags dapat berisi tema, fitur, atau kategori komunitas di luar genre. Jangan memperlakukan fallback ini sebagai taksonomi genre resmi Steam.',
         '- Kolom selain genre yang masih kosong tetap kosong; pembatasan App Details HTTP 429 dari tahap sebelumnya belum diatasi dengan fallback tags.', '',
         '## Kolom masih kosong atau array kosong', '', '| Kolom | Baris |', '|---|---:|',
         *[f'| {key} | {count:,} |' for key, count in missing_by_field.items()], '',
         '## Verifikasi', '',
         '- CSV dibaca ulang: header, jumlah baris, keunikan AppID, array JSON, semua genre awal, dan semua kolom selain genre cocok dengan input.',
         '- SHA-256 input diperiksa ulang. File awal, output enrichment sebelumnya, serta database tidak diubah.', '',
         '## Sumber', '', *[f'- `{path}` (SHA-256 `{digest}`)' for path, digest in hashes.items()], '']
(target / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
print(json.dumps({key: value for key, value in summary.items() if key not in ['input_sha256', 'genre_still_empty_appids']}, indent=2))
