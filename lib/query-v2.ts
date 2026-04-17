/**
 * Query the brain knowledge base via Qdrant vector search + SearXNG web search.
 *
 * Phase 2: Multi-source retrieval with RRF fusion.
 *
 * 1. Parallel: Qdrant vector search + SearXNG web search
 * 2. RRF fusion merges results by rank
 * 3. Single LLM synthesis call produces the answer
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey, getCached, setCache } from "./cache.js";
import { type Chunk, searchMulti } from "./qdrant.js";
import { loadState, QUERIES_DIR, saveState } from "./state.js";
import { appendToLog } from "./utils.js";
import { callLLM } from "./zai.js";

export interface QueryResult {
	question: string;
	answer: string;
	chunksUsed: number;
	webResultsUsed: number;
	collectionsSearched: string[];
	filed: boolean;
}

const COLLECTIONS = ["brain-sessions", "brain-wiki", "knowledge_base"];
const SEARXNG_URL = "http://10.1.1.120:30888";

// ─── SearXNG web search ─────────────────────────────────────────

interface SearXNGResult {
	title: string;
	url: string;
	content: string;
	engine: string;
	score: number;
}

async function searxngSearch(
	query: string,
	topK = 5,
	signal?: AbortSignal,
): Promise<Chunk[]> {
	try {
		const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
		const resp = await fetch(url, { signal });
		if (!resp.ok) return [];

		const data = (await resp.json()) as { results?: SearXNGResult[] };
		return (data.results || [])
			.slice(0, topK)
			.filter((r) => r.content && r.content.length > 20)
			.map((r) => ({
				id: r.url,
				content: `${r.title}\n${r.content}`,
				score: 0.5, // SearXNG scores aren't comparable to vector scores
				source: "web",
				metadata: { url: r.url, engine: r.engine },
			}));
	} catch (err: any) {
		console.error(`[brain] SearXNG search failed: ${err.message}`);
		return [];
	}
}

// ─── RRF Fusion ─────────────────────────────────────────────────

function rrfFuse(localChunks: Chunk[], webChunks: Chunk[], k = 60): Chunk[] {
	const scores = new Map<string, { score: number; chunk: Chunk }>();

	// Rank local chunks (higher weight — trusted source)
	for (let rank = 0; rank < localChunks.length; rank++) {
		const chunk = localChunks[rank];
		const key = chunk.content.slice(0, 100);
		const existing = scores.get(key);
		const contribution = (k / (k + rank + 1)) * 1.5; // 1.5x weight for local
		if (existing) {
			existing.score += contribution;
		} else {
			scores.set(key, { score: contribution, chunk });
		}
	}

	// Rank web chunks (standard weight)
	for (let rank = 0; rank < webChunks.length; rank++) {
		const chunk = webChunks[rank];
		const key = chunk.content.slice(0, 100);
		const existing = scores.get(key);
		const contribution = k / (k + rank + 1);
		if (existing) {
			existing.score += contribution;
			// Mark as multi-source
			existing.chunk.source = `${existing.chunk.source}+web`;
		} else {
			scores.set(key, { score: contribution, chunk });
		}
	}

	return [...scores.values()]
		.sort((a, b) => b.score - a.score)
		.map((entry) => ({
			...entry.chunk,
			score: entry.score,
		}));
}

// ─── Main query ─────────────────────────────────────────────────

export async function queryBrain(
	question: string,
	fileBack: boolean,
	_ctx?: any,
	signal?: AbortSignal,
): Promise<QueryResult> {
	// Step 0: Check cache for a previous answer
	const key = cacheKey(question);
	try {
		const cached = await getCached(key);
		if (cached) {
			appendToLog(`query | ${question.slice(0, 60)} | cache hit`);
			const state = loadState();
			state.queryCount = (state.queryCount || 0) + 1;
			saveState(state);
			return {
				question,
				answer: cached,
				chunksUsed: 0,
				webResultsUsed: 0,
				collectionsSearched: COLLECTIONS,
				filed: false,
			};
		}
	} catch {
		// Cache unavailable — proceed with full query
	}

	// Step 1: Parallel retrieval — Qdrant + SearXNG
	const [localChunks, webChunks] = await Promise.allSettled([
		searchMulti(COLLECTIONS, question, 8, signal),
		searxngSearch(question, 5, signal),
	]);

	const local = localChunks.status === "fulfilled" ? localChunks.value : [];
	const web = webChunks.status === "fulfilled" ? webChunks.value : [];

	// Step 2: RRF fusion
	const fused = rrfFuse(local, web);

	// Step 3: Build context from fused results
	let contextBlock = "(No relevant knowledge found)";
	if (fused.length > 0) {
		contextBlock = fused
			.slice(0, 10)
			.map((c, i) => {
				const src = c.source || "unknown";
				const url = c.metadata?.url ? ` (${c.metadata.url})` : "";
				return `[${i + 1}] (${src}${url}): ${c.content}`;
			})
			.join("\n\n");
	}

	// Step 4: Synthesize answer using quality tier (E4B preferred)
	const answerPrompt = `Answer using the knowledge below. Cite sources as [1], [2], etc. If insufficient info, say so.

Question: ${question}

Knowledge:
${contextBlock}`;

	const answer = await callLLM(
		answerPrompt,
		8192,
		signal,
		undefined,
		"quality",
	);

	// Step 5: Optionally file the answer back as a Q&A page
	let filed = false;
	if (fileBack && answer.length > 100) {
		try {
			const today = new Date().toISOString().slice(0, 10);
			const qaSlug = question
				.slice(0, 40)
				.replace(/[^a-z0-9-]/gi, "-")
				.toLowerCase();
			const qaPath = join(QUERIES_DIR, `${qaSlug}.md`);
			mkdirSync(QUERIES_DIR, { recursive: true });
			const qaContent = `---
type: query
created: ${today}
updated: ${today}
tags: [query]
sources: [${COLLECTIONS.map((c) => `"${c}"`).join(", ")}, "web"]
---

# Q: ${question}

## Answer

${answer}

## Sources

${fused
	.slice(0, 10)
	.map((c, i) => {
		const url = c.metadata?.url ? ` (${c.metadata.url})` : "";
		return `- [${i + 1}] ${c.source}${url}: ${c.content.slice(0, 80)}...`;
	})
	.join("\n")}
`;
			writeFileSync(qaPath, qaContent, "utf-8");
			filed = true;
			appendToLog(`query | ${question.slice(0, 60)} | filed: ${qaSlug}`);
		} catch (err: any) {
			console.error(`[brain] failed to file query: ${err.message}`);
		}
	}

	// Update state
	const state = loadState();
	state.queryCount = (state.queryCount || 0) + 1;
	saveState(state);

	// Step 6: Cache the answer for future queries (fire-and-forget)
	if (answer.length > 50) {
		setCache(key, answer, 3600).catch(() => {}); // 1hr TTL, ignore failures
	}

	return {
		question,
		answer,
		chunksUsed: local.length,
		webResultsUsed: web.length,
		collectionsSearched: COLLECTIONS,
		filed,
	};
}
