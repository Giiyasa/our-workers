import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptAsset, decryptAsset } from "../src/lib/asset-crypto";
import { fetchProviderLua, readLua } from "../src/lib/asset-providers";
import type { Sql } from "../src/lib/db";

const key = "11".repeat(32); // synthetic test key, never production credentials
const lua = 'addappid(620, 0, "fixture")\n';
const env = { RYUU_AUTH_CODE: "test-code", HUBCAP_API_KEYS: "[]" } as Env;
afterEach(() => vi.unstubAllGlobals());

describe("encrypted provider assets", () => {
	it("SGA1 is compatible with the nonce/ciphertext/tag layout and rejects wrong keys", async () => {
		const bytes = new TextEncoder().encode(lua);
		const encrypted = await encryptAsset(bytes, key);
		expect(new TextDecoder().decode(encrypted.subarray(0, 4))).toBe("SGA1");
		expect(encrypted[4]).toBe(1);
		expect(encrypted.length).toBe(bytes.length + 33);
		const hex = Array.from(encrypted, (byte) => byte.toString(16).padStart(2, "0")).join("");
		expect(await decryptAsset(hex, key)).toEqual(bytes);
		await expect(decryptAsset(hex, "22".repeat(32))).rejects.toThrow();
		const other = await encryptAsset(bytes, key);
		expect(other.subarray(5, 17)).not.toEqual(encrypted.subarray(5, 17));
	});
	it("rejects HTML/JSON masquerading as a successful provider download", async () => {
		await expect(readLua(new Response('<html>not found</html>'))).rejects.toThrow();
		await expect(readLua(new Response('{"error":"missing"}'))).rejects.toThrow();
	});
});

describe("provider ordering", () => {
	it("uses provider 2 plaintext and URL encodes the auth code", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(lua));
		vi.stubGlobal("fetch", fetcher);
		const result = await fetchProviderLua({} as Sql, { ...env, RYUU_AUTH_CODE: "a&b" }, 620);
		expect(result.source).toBe("provider_2");
		expect(new TextDecoder().decode(result.bytes)).toBe(lua);
		const called = new URL(String(fetcher.mock.calls[0][0]));
		expect(called.searchParams.get("auth_code")).toBe("a&b");
	});
	it("does not treat provider 2 outages as not_found or rotate into provider 3", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
		vi.stubGlobal("fetch", fetcher);
		await expect(fetchProviderLua({} as Sql, env, 620)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("only a 404 reaches provider 3 and missing credentials remain configuration errors", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"Game not found"}', { status: 404 })));
		await expect(fetchProviderLua({} as Sql, env, 620)).rejects.toMatchObject({ code: "PROVIDER_CONFIG" });
	});
});
