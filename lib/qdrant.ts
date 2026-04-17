/**
 * Qdrant vector store client for brain v2.
 *
 * Provides embed, upsert, and search operations against
 * the Qdrant instance on nexus (10.1.1.120:6333) and
 * the KB MCP embed endpoint (10.1.1.120:8643/embed).
 *
 * No wiki page generation. Raw chunks are ground truth.
 */

import { randomUUID } from "node:crypto";

const QDRANT_URL = "http://10.1.1.120:6333";
// Embed server runs in K8s (ai-inference namespace on nexus)
// Fallback to localhost for dev/testing outside cluster
const EMBED_URL = process.env.EMBED_URL || "http://10.1.1.120:30880/embed";
const VECTOR_DIM = 384;

export interface Chunk {
	id: string;
	content: string;
	score: number;
	source: string;
	category?: string;
	sessionDate?: string;
	metadata: Record<string, any>;
}

/** Embed one or more texts via KB MCP /embed endpoint */
export async function embed(
	texts: string[],
	signal?: AbortSignal,
): Promise<number[][]> {
	const resp = await fetch(EMBED_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ texts }),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`Embed failed: ${resp.status} ${await resp.text()}`);
	}
	const data = (await resp.json()) as { vectors: number[][]; dim: number };
	return data.vectors;
}

/** Upsert chunks into a Qdrant collection */
export async function upsert(
	collection: string,
	chunks: Array<{
		content: string;
		source: string;
		category?: string;
		sessionDate?: string;
		metadata?: Record<string, any>;
	}>,
	signal?: AbortSignal,
): Promise<number> {
	if (chunks.length === 0) return 0;

	const vectors = await embed(
		chunks.map((c) => c.content),
		signal,
	);

	const points = chunks.map((chunk, i) => ({
		id: randomUUID(),
		vector: vectors[i],
		payload: {
			content: chunk.content,
			source: chunk.source,
			category: chunk.category || "fact",
			session_date: chunk.sessionDate || new Date().toISOString().slice(0, 10),
			...chunk.metadata,
		},
	}));

	const resp = await fetch(`${QDRANT_URL}/collections/${collection}/points`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ points }),
		signal,
	});
	if (!resp.ok) {
		throw new Error(
			`Qdrant upsert failed: ${resp.status} ${await resp.text()}`,
		);
	}

	return chunks.length;
}

/** Search a Qdrant collection by semantic similarity */
export async function search(
	collection: string,
	query: string,
	topK = 5,
	signal?: AbortSignal,
): Promise<Chunk[]> {
	const [vector] = await embed([query], signal);

	const resp = await fetch(
		`${QDRANT_URL}/collections/${collection}/points/search`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				vector,
				limit: topK,
				with_payload: true,
				score_threshold: 0.0,
			}),
			signal,
		},
	);
	if (!resp.ok) {
		throw new Error(
			`Qdrant search failed: ${resp.status} ${await resp.text()}`,
		);
	}

	const data = (await resp.json()) as { result: Array<any> };

	return (data.result ?? []).map((p) => ({
		id: p.id,
		content: p.payload?.content || "",
		score: p.score,
		source: p.payload?.source || "",
		category: p.payload?.category,
		sessionDate: p.payload?.session_date,
		metadata: {
			...Object.fromEntries(
				Object.entries(p.payload || {}).filter(
					([k]) =>
						!["content", "source", "category", "session_date"].includes(k),
				),
			),
		},
	}));
}

/** Search across multiple collections and merge by score */
export async function searchMulti(
	collections: string[],
	query: string,
	topK = 5,
	signal?: AbortSignal,
): Promise<Chunk[]> {
	const results = await Promise.allSettled(
		collections.map((c) => search(c, query, topK, signal)),
	);

	const allChunks: Chunk[] = [];
	for (const r of results) {
		if (r.status === "fulfilled") {
			allChunks.push(...r.value);
		}
	}

	// Sort by score descending, take top K
	allChunks.sort((a, b) => b.score - a.score);
	return allChunks.slice(0, topK);
}

/** Check if Qdrant is reachable */
export async function isHealthy(): Promise<boolean> {
	try {
		const resp = await fetch(`${QDRANT_URL}/`, {
			signal: AbortSignal.timeout(3000),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

/** Get collection point count */
export async function collectionSize(collection: string): Promise<number> {
	try {
		const resp = await fetch(`${QDRANT_URL}/collections/${collection}`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!resp.ok) return 0;
		const data = (await resp.json()) as { result: { points_count: number } };
		return data.result?.points_count ?? 0;
	} catch {
		return 0;
	}
}
