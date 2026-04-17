/**
 * Query the brain knowledge base.
 *
 * Index-guided retrieval: reads the index, identifies relevant pages,
 * reads them, synthesizes an answer with citations.
 * Uses callLLM (local Gemma → ZAI fallback).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState, QUERIES_DIR, saveState } from "./state.js";
import { appendToLog, readIndex, readWikiPage } from "./utils.js";
import { callLLM } from "./zai.js";

export interface QueryResult {
	question: string;
	answer: string;
	pagesConsulted: string[];
	filed: boolean;
}

export async function queryBrain(
	question: string,
	fileBack: boolean,
	_ctx?: any,
	signal?: AbortSignal,
): Promise<QueryResult> {
	const indexContent = readIndex();
	if (!indexContent) {
		return {
			question,
			answer: "Brain is empty — no wiki pages yet. Ingest some sources first.",
			pagesConsulted: [],
			filed: false,
		};
	}

	// Step 1: Identify relevant pages from the index
	const relevancePrompt = `Pick 3-8 relevant pages from index. Output JSON only.
{"pages":["concepts/slug1","entities/slug2"]}

Index:
${indexContent}

Question: ${question}`;

	const relevanceText = await callLLM(relevancePrompt, 512, signal);
	let relevantPages: string[] = [];
	try {
		const jsonMatch = relevanceText.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			relevantPages = parsed.pages || [];
		}
	} catch {
		// Fallback: no pages identified
	}

	// Step 2: Read relevant pages
	const pageContents: string[] = [];
	for (const pageRel of relevantPages) {
		const content = readWikiPage(pageRel);
		if (content) {
			pageContents.push(`### [[${pageRel}]]\n${content}`);
		}
	}

	// Step 3: Synthesize answer
	const answerPrompt = `Answer using pages below. Cite with [[wiki-links]]. If insufficient info, say so.

Question: ${question}

${pageContents.length > 0 ? pageContents.join("\n\n") : "(No relevant pages found)"}`;

	const answer = await callLLM(answerPrompt, 8192, signal);

	// Step 4: Optionally file the answer back as a Q&A page
	let filed = false;
	if (fileBack && answer.length > 100) {
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
consulted: [${relevantPages.map((p) => `"${p}"`).join(", ")}]
---

# Q: ${question}

## Answer

${answer}

## Pages Consulted

${relevantPages.map((p) => `- [[${p}]]`).join("\n")}
`;
		writeFileSync(qaPath, qaContent, "utf-8");
		filed = true;
		appendToLog(`query | ${question.slice(0, 60)} | filed: ${qaSlug}`);
	}

	// Update state
	const state = loadState();
	state.queryCount = (state.queryCount || 0) + 1;
	saveState(state);

	return { question, answer, pagesConsulted: relevantPages, filed };
}
