/** SGA1 | 01 | nonce(12) | AES-256-GCM ciphertext + tag(16). */
export async function encryptAsset(bytes: Uint8Array, masterKeyHex: string | undefined): Promise<Uint8Array> {
	if (!masterKeyHex || !/^[a-f\d]{64}$/i.test(masterKeyHex)) {
		throw new Error("ASSET_MASTER_KEY_HEX belum dikonfigurasi dengan benar.");
	}
	const keyBytes = Uint8Array.from(masterKeyHex.match(/../g)!, (part) => parseInt(part, 16));
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, bytes as Uint8Array<ArrayBuffer>);
	const blob = new Uint8Array(17 + encrypted.byteLength);
	blob.set(new TextEncoder().encode("SGA1"));
	blob[4] = 1;
	blob.set(nonce, 5);
	blob.set(new Uint8Array(encrypted), 17);
	return blob;
}

export async function decryptAsset(hex: string, masterKeyHex: string | undefined): Promise<Uint8Array> {
	if (!masterKeyHex || !/^[a-f\d]{64}$/i.test(masterKeyHex)) throw new Error("Master key asset belum valid.");
	if (!/^[a-f\d]+$/i.test(hex) || hex.length % 2) throw new Error("Asset lokal tidak valid.");
	const blob = Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
	if (blob.length < 33 || new TextDecoder().decode(blob.subarray(0, 4)) !== "SGA1" || blob[4] !== 1) throw new Error("Format asset tidak didukung.");
	const keyBytes = Uint8Array.from(masterKeyHex.match(/../g)!, (part) => parseInt(part, 16));
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
	return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(5, 17), tagLength: 128 }, key, blob.subarray(17)));
}
