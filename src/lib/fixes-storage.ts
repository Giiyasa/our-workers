import { createHash } from 'node:crypto';
import { readR2Config, presignR2Get, signR2Request } from './r2';
import { FixesFailure, type Slot } from './fixes-provider';
const PART = 8 * 1024 * 1024;
const MAX = 4 * 1024 * 1024 * 1024;
export function packageObjectKey(fixId: string, revision: string, slot: Slot, token: string): string {
	const id = createHash('sha256').update(fixId).digest('hex');
	if (!/^[a-f0-9]{64}$/.test(revision) || !/^[a-f0-9-]{36}$/.test(token) || !['manifest', 'fix'].includes(slot))
		throw new FixesFailure('PACKAGE_KEY');
	return `fixes/${id}/${revision}/${slot}/${token}.bin`;
}
function checkedConfig(env: Env, key: string) {
	const config = readR2Config(env);
	if (!config || !/^fixes\/[a-f0-9]{64}\/[a-f0-9]{64}\/(manifest|fix)\/[a-f0-9-]{36}\.bin$/.test(key))
		throw new FixesFailure('STORAGE_CONFIG');
	return config;
}
export async function readPackage(env: Env, key: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
	const config = checkedConfig(env, key);
	try {
		return await fetch(await presignR2Get(config, key, 900, method), {
			method,
			redirect: 'manual',
			signal: AbortSignal.timeout(15 * 60_000),
		});
	} catch {
		throw new FixesFailure('STORAGE_NETWORK');
	}
}
function xmlValue(xml: string, tag: string): string {
	const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
	if (!found) throw new FixesFailure('STORAGE_FORMAT');
	return found
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function validatePackagePrefix(bytes: Uint8Array, filename: string): void {
	const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
	if (/\.zip$/i.test(filename)) {
		if (!zip) throw new FixesFailure('PACKAGE_FORMAT');
		return;
	}
	if (/\.lua$/i.test(filename)) {
		const text = new TextDecoder().decode(bytes);
		if (/^\s*[<{]/.test(text) || !/\baddappid\s*\(\s*\d+/.test(text)) throw new FixesFailure('PACKAGE_FORMAT');
		return;
	}
	// Steam's binary manifest payload magic, little endian.
	if (
		/\.manifest$/i.test(filename) &&
		bytes.length >= 4 &&
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x71f617d0
	)
		return;
	throw new FixesFailure('PACKAGE_FORMAT');
}
// Multipart bounds memory independently of the package size; incomplete uploads are aborted.
export async function storePackage(
	env: Env,
	key: string,
	source: Response,
	filename: string,
	heartbeat: () => Promise<void>,
): Promise<{ size: number; sha256: string }> {
	const config = checkedConfig(env, key);
	const reader = source.body?.getReader();
	if (!reader) throw new FixesFailure('PACKAGE_EMPTY');
	let uploadId: string | undefined;
	const request = async (method: 'POST' | 'PUT' | 'DELETE', query: Record<string, string>, body?: Uint8Array | string) => {
		const signed = await signR2Request(config, key, method, query, body);
		let res: Response;
		try {
			res = await fetch(signed.url, {
				headers: { ...signed.headers, 'content-type': method === 'PUT' ? 'application/octet-stream' : 'application/xml' },
				method,
				body: body as BodyInit | undefined,
				redirect: 'manual',
				signal: AbortSignal.timeout(120_000),
			});
		} catch {
			throw new FixesFailure('STORAGE_NETWORK');
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new FixesFailure('STORAGE_UPLOAD');
		}
		return res;
	};
	try {
		const declared = Number(source.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > MAX) throw new FixesFailure('PACKAGE_TOO_LARGE');
		const started = await request('POST', { uploads: '' });
		uploadId = xmlValue(await started.text(), 'UploadId');
		const hasher = createHash('sha256');
		let size = 0,
			filled = 0,
			partNumber = 0,
			validated = false;
		let buffer = new Uint8Array(PART);
		const parts: { etag: string; part: number }[] = [];
        let lastHeartbeat = Date.now();
		const send = async (bytes: Uint8Array) => {
			if (!validated) {
				validatePackagePrefix(bytes.subarray(0, 8192), filename);
				validated = true;
			}
			await heartbeat();
			const result = await request('PUT', { uploadId: uploadId!, partNumber: String(++partNumber) }, bytes);
			const etag = result.headers.get('etag');
			await result.body?.cancel();
			if (!etag) throw new FixesFailure('STORAGE_ETAG');
			parts.push({ etag, part: partNumber });
			await heartbeat();
		};
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
            if (Date.now() - lastHeartbeat > 30_000) { await heartbeat(); lastHeartbeat = Date.now(); }
			size += value.length;
			if (size > MAX) throw new FixesFailure('PACKAGE_TOO_LARGE');
			hasher.update(value);
			let offset = 0;
			while (offset < value.length) {
				const take = Math.min(PART - filled, value.length - offset);
				buffer.set(value.subarray(offset, offset + take), filled);
				offset += take;
				filled += take;
				if (filled === PART) {
					await send(buffer);
					buffer = new Uint8Array(PART);
					filled = 0;
				}
			}
		}
		if (!size) throw new FixesFailure('PACKAGE_EMPTY');
		if (Number.isFinite(declared) && declared > 0 && declared !== size) throw new FixesFailure('PACKAGE_TRUNCATED');
		if (filled) await send(buffer.subarray(0, filled));
		await heartbeat();
		const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.part}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
		const completed = await request('POST', { uploadId }, xml);
		const result = await completed.text();
		if (!/<CompleteMultipartUploadResult[ >]/.test(result) || /<Error[ >]/.test(result)) throw new FixesFailure('STORAGE_COMPLETE');
		uploadId = undefined;
		return { size, sha256: hasher.digest('hex') };
	} finally {
		await reader.cancel().catch(() => {});
		if (uploadId) {
			try {
				const aborted = await request('DELETE', { uploadId });
				await aborted.body?.cancel();
			} catch {
				/* lifecycle rule handles failed aborts */
			}
		}
	}
}
