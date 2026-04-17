/**
 * Source ingestion pipeline.
 *
 * Ingest URLs, files, or text into the brain knowledge base.
 * Uses callLLM (ZAI → local fallback) instead of pi-ai.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadState, RAW_DIR, saveState, WIKI_DIR } from "./state.js";
import {
	appendToLog,
	listWikiArticles,
	readIndex,
	readSchema,
	writeWikiPage,
} from "./utils.js";
import { callLLM } from "./zai.js";

export interface IngestResult {
	name: string;
	pagesCreated: string[];
	pagesUpdated: string[];
}

export async function ingestSource(
	source: { type: "url" | "file" | "text"; content: string; name?: string },
	_ctx?: any,
	signal?: AbortSignal,
): Promise<IngestResult> {
	const result: IngestResult = {
		name: source.name || deriveName(source),
		pagesCreated: [],
		pagesUpdated: [],
	};

	// 1. Fetch/read raw content
	let rawContent: string;
	let rawCategory: string;

	if (source.type === "url") {
		rawContent = await fetchUrl(source.content, signal);
		rawCategory = "articles";
	} else if (source.type === "file") {
		rawContent = readFileSync(source.content, "utf-8");
		rawCategory = "repos";
	} else {
		rawContent = source.content;
		rawCategory = "articles";
	}

	// 2. Save raw source (immutable)
	const rawFileName = `${result.name}.md`;
	const rawPath = join(RAW_DIR, rawCategory, rawFileName);
	mkdirSync(join(RAW_DIR, rawCategory), { recursive: true });
	writeFileSync(rawPath, rawContent, "utf-8");

	// 3. Build context
	const schema = readSchema() || "";
	const existingArticles = listWikiArticles();

	const existingSummary = existingArticles
		.slice(0, 20)
		.map((p) => {
			try {
				const content = readFileSync(p, "utf-8");
				const title = content.match(/^# (.+)$/m)?.[1] || basename(p);
				return `- [[${title}]]`;
			} catch {
				return "";
			}
		})
		.filter(Boolean)
		.join("\n");

	const date = new Date().toISOString().slice(0, 10);

	// 4. Two-phase: extract concepts, then generate pages
	// Phase 1: Extract concepts
	const extractPrompt = `You are a concept extraction engine. Analyze the source and identify distinct concepts worth documenting as wiki pages.

Return JSON only (no markdown):
{"concepts":[{"title":"Concept Name","summary":"one line","tags":["tag1"],"slug":"concept-name"}]}

Rules:
- Extract 3-8 distinct concepts
- Focus on key ideas, patterns, entities, techniques
- Tags: 2-4 categorical labels

## Existing Pages (avoid duplicates)
${existingSummary || "(None)"}

## Source: ${result.name}

${rawContent.slice(0, 12000)}`;

	const extractText = await callLLM(extractPrompt, 8192, signal);
	const jsonMatch = extractText.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Failed to parse extraction response");

	let concepts: any[];
	try {
		const parsed = JSON.parse(jsonMatch[0]);
		concepts = parsed.concepts || [];
	} catch {
		throw new Error("Invalid JSON in extraction response");
	}

	// Phase 2: Generate pages for each concept
	for (const concept of concepts) {
		if (!concept.title || !concept.summary) continue;

		const slug =
			concept.slug ||
			concept.title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 80);

		const pagePrompt = `Write a wiki page about "${concept.title}".
Summary: ${concept.summary}

Draw from this source material. Include [[wikilinks]] to related concepts.
Keep it concise. Encyclopedia style.

Source: ${rawContent.slice(0, 10000)}`;

		const pageBody = await callLLM(pagePrompt, 4096, signal);
		if (!pageBody.trim()) continue;

		const pagePath = `concepts/${slug}.md`;
		const fullPage = `---
title: ${concept.title}
summary: ${concept.summary}
sources:
  - ${result.name}
tags: [${(concept.tags || []).map((t: string) => `"${t}"`).join(", ")}]
createdAt: "${date}"
updatedAt: "${date}"
---

${pageBody}
`;

		const isCreate = !existsSync(join(WIKI_DIR, pagePath));
		writeWikiPage(pagePath, fullPage);

		if (isCreate) {
			result.pagesCreated.push(pagePath);
		} else {
			result.pagesUpdated.push(pagePath);
		}
	}

	// Log the operation
	appendToLog(
		`ingest | ${result.name} | created: ${result.pagesCreated.join(", ")} | updated: ${result.pagesUpdated.join(", ")}`,
	);

	// Update state
	const state = loadState();
	state.ingested = state.ingested || {};
	state.ingested[result.name] = {
		hash: "",
		compiled_at: new Date().toISOString(),
		cost_usd: 0,
	};
	saveState(state);

	return result;
}

function deriveName(source: {
	type: string;
	content: string;
	name?: string;
}): string {
	if (source.name) return source.name;

	if (source.type === "url") {
		try {
			const url = new URL(source.content);
			const segments = url.pathname.split("/").filter(Boolean);
			const last = segments[segments.length - 1] || url.hostname;
			return last
				.replace(/\.[^.]+$/, "")
				.replace(/[^a-z0-9-]/gi, "-")
				.toLowerCase();
		} catch {
			return "untitled";
		}
	}

	if (source.type === "file") {
		return basename(source.content, ".md")
			.replace(/[^a-z016-]/gi, "-")
			.toLowerCase();
	}

	return source.content
		.slice(0, 30)
		.replace(/[^a-z0-9-]/gi, "-")
		.toLowerCase();
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
	const text = await response.text();

	return text
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 12000);
}
