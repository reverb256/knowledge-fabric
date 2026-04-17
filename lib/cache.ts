/**
 * Valkey/Redis cache client using raw RESP protocol over TCP.
 *
 * No external dependencies — uses node:net to speak Redis RESP directly.
 * Valkey is fully Redis-compatible, so this works as-is.
 *
 * Graceful degradation: all methods return null/false on connection failure
 * so the rest of the system works fine without the cache.
 */
import { createConnection, type Socket, type NetConnectOpts } from "node:net";
import { createHash } from "node:crypto";

// ─── Configuration ──────────────────────────────────────────────

const VALKEY_HOST = process.env.VALKEY_HOST || "valkey.search.svc.cluster.local";
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || "6379", 10);
const CACHE_PREFIX = "brain:q:";
const DEFAULT_TTL = 3600; // 1 hour

// ─── RESP protocol helpers ──────────────────────────────────────
// Minimal Redis Serialization Protocol implementation.
// Only handles the commands we need: GET, SET, PING, DEL.

function respCommand(...args: string[]): string {
	return (
		"*" + args.length + "\r\n" +
		args.map((a) => "$" + Buffer.byteLength(a, "utf-8") + "\r\n" + a + "\r\n").join("")
	);
}

interface RespReply {
	type: "string" | "error" | "integer" | "bulk" | "null" | "array";
	value: string | number | null | RespReply[];
}

function parseReply(buf: Buffer): { reply: RespReply; consumed: number } {
	const pos = { i: 0 };

	function readLine(): string {
		const start = pos.i;
		while (pos.i < buf.length && !(buf[pos.i] === 0x0d && buf[pos.i + 1] === 0x0a)) {
			pos.i++;
		}
		const line = buf.slice(start, pos.i).toString("utf-8");
		pos.i += 2; // skip CRLF
		return line;
	}

	const type = String.fromCharCode(buf[pos.i]);
	pos.i++; // skip type byte
	const line = readLine();

	switch (type) {
		case "+":
			return { reply: { type: "string", value: line }, consumed: pos.i };
		case "-":
			return { reply: { type: "error", value: line }, consumed: pos.i };
		case ":": {
			const n = parseInt(line, 10);
			return { reply: { type: "integer", value: n }, consumed: pos.i };
		}
		case "$": {
			const len = parseInt(line, 10);
			if (len === -1) return { reply: { type: "null", value: null }, consumed: pos.i };
			const data = buf.slice(pos.i, pos.i + len).toString("utf-8");
			pos.i += len + 2; // data + CRLF
			return { reply: { type: "bulk", value: data }, consumed: pos.i };
		}
		case "*": {
			const count = parseInt(line, 10);
			if (count === -1) return { reply: { type: "null", value: null }, consumed: pos.i };
			const items: RespReply[] = [];
			for (let j = 0; j < count; j++) {
				const { reply } = parseReply(buf.slice(pos.i));
				items.push(reply);
			}
			// Recalculate consumed properly
			return { reply: { type: "array", value: items }, consumed: pos.i };
		}
		default:
			throw new Error(`Unknown RESP type: ${type}`);
	}
}

// ─── Connection pool (single reusable socket) ───────────────────

let socket: Socket | null = null;
let connected = false;
let pendingResolve: ((buf: Buffer) => void) | null = null;
let dataBuffer = Buffer.alloc(0);

function connect(): Promise<Socket> {
	if (socket && connected) return Promise.resolve(socket);

	return new Promise((resolve, reject) => {
		const opts: NetConnectOpts = {
			host: VALKEY_HOST,
			port: VALKEY_PORT,
			timeout: 2000,
		};

		socket = createConnection(opts, () => {
			connected = true;
			resolve(socket!);
		});

		socket.on("data", (chunk: Buffer) => {
			dataBuffer = Buffer.concat([dataBuffer, chunk]);
			if (pendingResolve && dataBuffer.length > 0) {
				const resolveFn = pendingResolve;
				pendingResolve = null;
				resolveFn(dataBuffer);
			}
		});

		socket.on("error", () => {
			connected = false;
			socket = null;
		});

		socket.on("close", () => {
			connected = false;
			socket = null;
			dataBuffer = Buffer.alloc(0);
		});

		socket.on("timeout", () => {
			connected = false;
			socket?.destroy();
			socket = null;
		});

		// Reject the connect promise on immediate error
		socket.once("error", (_err: Error) => {
			if (!connected) reject(err);
		});
	});
}

async function sendCommand(cmd: string): Promise<RespReply> {
	try {
		const sock = await connect();
		dataBuffer = Buffer.alloc(0);

		return new Promise<RespReply>((resolve) => {
			const timeout = setTimeout(() => {
				pendingResolve = null;
				resolve({ type: "null", value: null }); // treat timeout as miss
			}, 2000);

			pendingResolve = (buf: Buffer) => {
				clearTimeout(timeout);
				try {
					const { reply } = parseReply(buf);
					dataBuffer = Buffer.alloc(0);
					resolve(reply);
				} catch (err: any) {
					resolve({ type: "null", value: null }); // parse error -> miss
				}
			};

			sock.write(cmd, (err) => {
				if (err) {
					clearTimeout(timeout);
					pendingResolve = null;
					resolve({ type: "null", value: null });
				}
			});
		});
	} catch {
		return { type: "null", value: null };
	}
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check if the Valkey cache is reachable.
 */
export async function cacheAvailable(): Promise<boolean> {
	const reply = await sendCommand(respCommand("PING"));
	return reply.type === "string" && reply.value === "PONG";
}

/**
 * Generate a cache key from a question string.
 * Uses SHA-256 hash to keep keys short and filesystem-safe.
 */
export function cacheKey(question: string): string {
	const hash = createHash("sha256").update(question.trim().toLowerCase()).digest("hex").slice(0, 16);
	return `${CACHE_PREFIX}${hash}`;
}

/**
 * Get a cached value by key. Returns null on miss or connection failure.
 */
export async function getCached(key: string): Promise<string | null> {
	const reply = await sendCommand(respCommand("GET", key));
	if (reply.type === "bulk" && reply.value !== null) return reply.value as string;
	return null;
}

/**
 * Store a value in cache with a TTL (default 1 hour).
 * Returns true on success, false on failure (graceful degradation).
 */
export async function setCache(key: string, value: string, ttlSeconds = DEFAULT_TTL): Promise<boolean> {
	const reply = await sendCommand(respCommand("SET", key, value, "EX", String(ttlSeconds)));
	return reply.type === "string";
}

/**
 * Delete a cache key. Useful for cache invalidation.
 */
export async function deleteCache(key: string): Promise<boolean> {
	const reply = await sendCommand(respCommand("DEL", key));
	return reply.type === "integer" && (reply.value as number) > 0;
}
