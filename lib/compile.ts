/**
 * Three-phase compilation pipeline with quality guards.
 *
 * Phase 1: Plan — analyze source and plan which concepts to extract.
 * Phase 2: Extract — extract structured concepts using the plan as context.
 * Phase 3: Generate — create/update wiki pages for each concept.
 *
 * Quality guards:
 * - Fix 1: Wikilink restriction — PAGE_PROMPT only allows links to existing pages.
 * - Fix 2: Post-compile link cleanup — strips broken wikilinks from generated pages.
 * - Fix 3: Page count guard — maxPages cap prevents unbounded growth.
 * - Fix 4: Semantic dedup — tag overlap check prevents near-duplicate page creation.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { INDEX_PATH, type loadState, saveState, WIKI_DIR } from "./state.js";
import {
	appendToLog,
	fileHash,
	listWikiArticles,
	readIndex,
	readSchema,
	readWikiPage,
	writeWikiPage,
} from "./utils.js";
import { callLLM } from "./zai.js";

export interface CompileResult {
	created: string[];
	updated: string[];
	cost: number;
}

/** A concept extracted during Phase 2 */
interface ExtractedConcept {
	title: string;
	summary: string;
	tags: string[];
	isNew: boolean;
	slug: string;
}

/** Phase 2 result for a single source */
interface ExtractionResult {
	sourceFile: string;
	concepts: ExtractedConcept[];
}

/** Merged concept with all contributing sources */
interface MergedConcept {
	slug: string;
	concept: ExtractedConcept;
	sourceFiles: string[];
}

// ─── Configuration ────────────────────────────────────────────────

/** Maximum total wiki pages before refusing to create new ones. */
const MAX_PAGES = 150;

/** Minimum tag overlap ratio (0-1) to consider two concepts as near-duplicates. */
const DEDUP_TAG_OVERLAP_THRESHOLD = 0.5;

// ─── Helpers ──────────────────────────────────────────────────────

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
}

/**
 * Robust JSON parser that handles common LLM output issues:
 * - Markdown code fences
 * - Missing closing brace (Gemma ends with }])
 * - Truncated responses
 */
function parseLLMJson<T>(text: string): T | null {
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/im, "")
		.replace(/\n?```\s*$/m, "")
		.trim();

	let jsonText = cleaned;
	if (jsonText.endsWith("]") || jsonText.endsWith("]\n")) {
		jsonText += "}";
	}

	const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;

	try {
		return JSON.parse(jsonText[0]) as T;
	} catch {
		let lastBrace = jsonText.lastIndexOf("}");
		while (lastBrace > 0) {
			try {
				return JSON.parse(jsonText.substring(0, lastBrace + 1)) as T;
			} catch {
				lastBrace = jsonText.lastIndexOf("}", lastBrace - 1);
			}
		}
		return null;
	}
}

// ─── Fix 2: Post-compile link cleanup ─────────────────────────────

/**
 * Get the set of all valid wiki page names (leaf names without .md extension).
 * Used for wikilink validation during page generation and post-compile cleanup.
 */
function getValidWikiPageNames(): Set<string> {
	const articles = listWikiArticles();
	const names = new Set<string>();
	for (const a of articles) {
		// Full relative path: "concepts/some-topic"
		names.add(relative(WIKI_DIR, a).replace(".md", ""));
		// Also add just the leaf name: "some-topic"
		const leaf = basename(a, ".md");
		names.add(leaf);
	}
	return names;
}

/**
 * Resolve a wikilink target against valid wiki pages.
 * Matches full path first, then falls back to leaf name.
 */
function resolveWikilink(target: string, validPages: Set<string>): boolean {
	if (validPages.has(target)) return true;
	// Try leaf name match
	const leaf = target.split("/").pop() || target;
	if (validPages.has(leaf)) return true;
	return false;
}

/**
 * Strip broken wikilinks from a page body, keeping the display text.
 * Converts [[Nonexistent Page]] → Nonexistent Page
 * Converts [[Nonexistent Page|Display Text]] → Display Text
 * Leaves valid wikilinks intact.
 *
 * Skips content inside code blocks (``` fenced) and frontmatter (--- delimited).
 */
function cleanBrokenWikilinks(
	content: string,
	validPages: Set<string>,
): string {
	// Split into segments: frontmatter, code blocks, and normal text
	// We only process normal text segments
	const segments: Array<{ text: string; protect: boolean }> = [];
	let remaining = content;

	// Protect frontmatter
	if (remaining.startsWith("---")) {
		const endFm = remaining.indexOf("---", 3);
		if (endFm !== -1) {
			segments.push({ text: remaining.slice(0, endFm + 3), protect: true });
			remaining = remaining.slice(endFm + 3);
		}
	}

	// Protect code blocks
	const codeBlockPattern = /```[\s\S]*?```/g;
	let lastEnd = 0;
	let match: RegExpExecArray | null;
	while ((match = codeBlockPattern.exec(remaining)) !== null) {
		if (match.index > lastEnd) {
			segments.push({
				text: remaining.slice(lastEnd, match.index),
				protect: false,
			});
		}
		segments.push({ text: match[0], protect: true });
		lastEnd = match.index + match[0].length;
	}
	if (lastEnd < remaining.length) {
		segments.push({ text: remaining.slice(lastEnd), protect: false });
	}

	// Process non-protected segments
	const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
	for (const seg of segments) {
		if (seg.protect) continue;
		seg.text = seg.text.replace(wikilinkPattern, (full, inner: string) => {
			let target: string;
			let display: string;
			if (inner.includes("|")) {
				const parts = inner.split("|", 2);
				target = parts[0].trim();
				display = parts[1].trim();
			} else {
				target = inner.trim();
				display = inner.trim();
			}
			// External links or valid pages stay as wikilinks
			if (target.startsWith("http") || target.startsWith("/")) return full;
			if (resolveWikilink(target, validPages)) return full;
			// Broken link — strip brackets, keep display text
			return display;
		});
	}

	return segments.map((s) => s.text).join("");
}

// ─── Fix 4: Semantic dedup via tag overlap ────────────────────────

/**
 * Load tags from frontmatter of an existing wiki page.
 * Returns the set of lowercase tags.
 */
function loadPageTags(relPath: string): Set<string> {
	const content = readWikiPage(relPath);
	if (!content) return new Set();
	const tagMatch = content.match(/^tags:\s*\[(.*?)\]/m);
	if (!tagMatch) return new Set();
	return new Set(
		tagMatch[1]
			.split(",")
			.map((t) => t.trim().replace(/["']/g, "").toLowerCase())
			.filter((t) => t.length > 0),
	);
}

/**
 * Build a map of existing page slug → tags for dedup checking.
 */
function buildExistingTagMap(): Map<string, Set<string>> {
	const articles = listWikiArticles();
	const tagMap = new Map<string, Set<string>>();
	for (const a of articles) {
		const rel = relative(WIKI_DIR, a).replace(".md", "");
		const tags = loadPageTags(rel);
		if (tags.size > 0) {
			tagMap.set(rel, tags);
		}
	}
	return tagMap;
}

/**
 * Compute Jaccard similarity between two tag sets.
 * Returns 0-1 where 1 = identical, 0 = no overlap.
 */
function tagSimilarity(tagsA: Set<string>, tagsB: Set<string>): number {
	if (tagsA.size === 0 || tagsB.size === 0) return 0;
	let intersection = 0;
	for (const t of tagsA) {
		if (tagsB.has(t)) intersection++;
	}
	const union = new Set([...tagsA, ...tagsB]).size;
	return union > 0 ? intersection / union : 0;
}

/**
 * Find an existing page that is semantically similar to a new concept.
 * Returns the relative path of the best match, or null if none found.
 *
 * Checks: tag overlap ≥ threshold AND title similarity (shared significant words).
 */
function findSimilarExistingPage(
	newSlug: string,
	newTags: string[],
	existingTagMap: Map<string, Set<string>>,
): string | null {
	const newTagSet = new Set(newTags.map((t) => t.toLowerCase()));
	const titleWords = new Set(
		newSlug
			.split("-")
			.filter((w) => w.length > 3) // Skip short words
			.map((w) => w.toLowerCase()),
	);

	let bestMatch: string | null = null;
	let bestScore = 0;

	for (const [rel, existingTags] of existingTagMap) {
		// Check tag overlap
		const similarity = tagSimilarity(newTagSet, existingTags);
		if (similarity < DEDUP_TAG_OVERLAP_THRESHOLD) continue;

		// Also check title word overlap for extra confidence
		const existingTitleWords = new Set(
			rel
				.split("/")
				.pop()!
				.split("-")
				.filter((w) => w.length > 3)
				.map((w) => w.toLowerCase()),
		);
		let titleOverlap = 0;
		for (const w of titleWords) {
			if (existingTitleWords.has(w)) titleOverlap++;
		}
		// Need at least some title overlap OR very high tag overlap
		if (titleOverlap === 0 && similarity < 0.8) continue;

		// Combined score: tag similarity + title bonus
		const score = similarity + titleOverlap * 0.1;
		if (score > bestScore) {
			bestScore = score;
			bestMatch = rel;
		}
	}

	return bestMatch;
}

// ─── Phase 1: Plan ────────────────────────────────────────────────

const PLAN_PROMPT = `Plan concept extraction. Output JSON only.
{"plan":{"summary":"<overview>","concepts_to_find":["<c1>","<c2>"],"strategy":"<approach>"}}
2-5 concepts. Prefer merging into existing pages.
Existing pages: {existing_pages}

---
{source_content}`;

async function planExtraction(
	sourceContent: string,
	sourceName: string,
	existingPages: string,
	signal?: AbortSignal,
): Promise<{
	plan: {
		summary: string;
		concepts_to_find: string[];
		strategy: string;
	};
}> {
	const prompt = PLAN_PROMPT.replace(
		"{existing_pages}",
		existingPages || "(none)",
	)
		.replace("{source_name}", sourceName)
		.replace("{source_content}", sourceContent.slice(0, 12000));

	const text = await callLLM(prompt, 16384, signal);
	const result = parseLLMJson<{
		plan: {
			summary: string;
			concepts_to_find: string[];
			strategy: string;
		};
	}>(text);

	if (!result || !result.plan) {
		throw new Error(
			`[brain] Phase 1 (Plan) failed: could not parse LLM response`,
		);
	}
	return result;
}

// ─── Phase 2: Extract ─────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract concepts from source. Output JSON only.
{"concepts":[{"title":"<Name>","summary":"<one line>","tags":["<t1>","<t2>"],"is_new":<true|false>}]}
2-5 concepts. is_new=true only if no existing page covers it. No generic topics.
Plan: {plan_context}
Existing pages: {existing_pages}

---
{source_content}`;

async function extractConcepts(
	sourceContent: string,
	sourceName: string,
	existingPages: string,
	planContext: string,
	signal?: AbortSignal,
): Promise<ExtractedConcept[]> {
	const prompt = EXTRACTION_PROMPT.replace("{plan_context}", planContext)
		.replace("{existing_pages}", existingPages)
		.replace("{source_name}", sourceName)
		.replace("{source_content}", sourceContent.slice(0, 12000));

	const text = await callLLM(prompt, 16384, signal);
	const parsed = parseLLMJson<{ concepts: any[] }>(text);

	if (!parsed || !parsed.concepts) {
		console.error("[brain] Phase 2 (Extract): no valid JSON from LLM");
		return [];
	}

	return (parsed.concepts || [])
		.filter(
			(c: any) => typeof c.title === "string" && typeof c.summary === "string",
		)
		.map((c: any) => ({
			title: c.title,
			summary: c.summary,
			tags: Array.isArray(c.tags) ? c.tags : [],
			isNew: !!c.is_new,
			slug: slugify(c.title),
		}));
}

// ─── Phase 3: Page Generation ────────────────────────────────────

/**
 * Fix 1: PAGE_PROMPT now includes the valid wikilink allowlist.
 * The LLM is explicitly told to ONLY link to pages in this list.
 */
const PAGE_PROMPT = `Write markdown page about "{concept_title}". Facts from source only. Cite paragraphs: ^[source-file.md]

STRICT WIKILINK RULES:
- Only link to pages in this EXACT list: {valid_links}
- If a term is NOT in the list, write it as plain text (no brackets)
- Example: if list is "foo, bar" then [[foo]] and [[bar]] are valid, but [[baz]] is INVALID
- When in doubt, use plain text

{existing_section}
{related_section}

---
{source_material}`;

async function generatePage(
	entry: MergedConcept,
	sourceContent: string,
	existingPage: string,
	relatedPages: string,
	validLinks: string,
	signal?: AbortSignal,
): Promise<string> {
	const existingSection = existingPage
		? `\nExisting page to update:\n${existingPage}`
		: "";

	const relatedSection = relatedPages
		? `\nRelated wiki pages:\n${relatedPages}`
		: "";

	const prompt = PAGE_PROMPT.replace("{concept_title}", entry.concept.title)
		.replace("{valid_links}", validLinks)
		.replace("{source_material}", sourceContent.slice(0, 10000))
		.replace("{existing_section}", existingSection)
		.replace("{related_section}", relatedSection);

	return callLLM(prompt, 16384, signal);
}

// ─── Merging ──────────────────────────────────────────────────────

function mergeExtractions(extractions: ExtractionResult[]): MergedConcept[] {
	const bySlug = new Map<string, MergedConcept>();

	for (const result of extractions) {
		for (const concept of result.concepts) {
			const existing = bySlug.get(concept.slug);
			if (existing) {
				existing.sourceFiles.push(result.sourceFile);
			} else {
				bySlug.set(concept.slug, {
					slug: concept.slug,
					concept,
					sourceFiles: [result.sourceFile],
				});
			}
		}
	}

	return Array.from(bySlug.values());
}

// ─── Main Pipeline ────────────────────────────────────────────────

export async function compileDailyLog(
	logPath: string,
	state: ReturnType<typeof loadState>,
	_ctx?: ExtensionContext,
	signal?: AbortSignal,
): Promise<CompileResult> {
	const result: CompileResult = { created: [], updated: [], cost: 0 };

	const logContent = readFileSync(logPath, "utf-8");
	const logFile = basename(logPath);
	const date = new Date().toISOString().slice(0, 10);

	// Build context
	const articles = listWikiArticles();
	const existingPageNames = articles
		.map((a) => relative(WIKI_DIR, a).replace(".md", ""))
		.join(", ");

	// Fix 3: Page count guard
	if (articles.length >= MAX_PAGES) {
		console.warn(
			`[brain] Page count guard: ${articles.length} pages >= ${MAX_PAGES} limit. ` +
				`Only updating existing pages, not creating new ones.`,
		);
	}

	// Fix 1: Build valid wikilink set for PAGE_PROMPT
	const validPages = getValidWikiPageNames();
	const validLinksStr = [...validPages]
		.filter((p) => !p.includes("/")) // Leaf names only for readability
		.sort()
		.join(", ");

	// Fix 4: Build existing tag map for dedup
	const existingTagMap = buildExistingTagMap();

	// Phase 1: Plan extraction
	let planContext = "";
	try {
		const planResult = await planExtraction(
			logContent,
			logFile,
			existingPageNames,
			signal,
		);
		planContext = `Summary: ${planResult.plan.summary}\nTarget concepts: ${planResult.plan.concepts_to_find.join(", ")}\nStrategy: ${planResult.plan.strategy}`;
		console.log(
			`[brain] Phase 1 (Plan): identified ${planResult.plan.concepts_to_find.length} target concepts`,
		);
	} catch (err) {
		console.warn(
			"[brain] Phase 1 (Plan) failed, proceeding without plan:",
			err,
		);
		// Continue without plan — Phase 2 still works
	}

	// Phase 2: Extract concepts
	const extraction = await extractConcepts(
		logContent,
		logFile,
		existingPageNames || "(none)",
		planContext,
		signal,
	);

	if (extraction.length === 0) {
		console.error("[brain] compile: no concepts extracted from", logFile);
		return result;
	}

	console.log(
		`[brain] Phase 2 (Extract): extracted ${extraction.length} concepts`,
	);

	// Fix 4: Dedup check — redirect new concepts to existing pages when similar
	const dedupRedirects = new Map<string, string>(); // new slug → existing slug
	for (const concept of extraction) {
		if (!concept.isNew) continue;
		const similar = findSimilarExistingPage(
			concept.slug,
			concept.tags,
			existingTagMap,
		);
		if (similar) {
			console.log(
				`[brain] Dedup: "${concept.slug}" redirected to existing "${similar}" ` +
					`(tag overlap ≥ ${DEDUP_TAG_OVERLAP_THRESHOLD * 100}%)`,
			);
			dedupRedirects.set(concept.slug, similar);
		}
	}

	// Apply dedup redirects
	for (const concept of extraction) {
		if (dedupRedirects.has(concept.slug)) {
			const existingSlug = dedupRedirects.get(concept.slug)!;
			concept.isNew = false;
			concept.slug = existingSlug.split("/").pop() || existingSlug;
		}
	}

	// Phase 3: Generate pages for each concept
	const merged = mergeExtractions([
		{ sourceFile: logFile, concepts: extraction },
	]);

	for (const entry of merged) {
		try {
			// Fix 3: Resolve page path — handle both "concepts/slug" and bare "slug"
			let pagePath: string;
			if (entry.slug.includes("/")) {
				pagePath = `${entry.slug}.md`;
			} else {
				pagePath = `concepts/${entry.slug}.md`;
			}

			const existingContent = readWikiPage(pagePath) || "";
			const isNewPage = !existingContent;

			// Fix 3: Skip new page creation if at page limit
			if (isNewPage && articles.length >= MAX_PAGES) {
				console.warn(
					`[brain] Skipping new page "${entry.slug}": page limit (${MAX_PAGES}) reached.`,
				);
				continue;
			}

			// Load 3 related pages for cross-referencing context
			const relatedPages = articles
				.filter((a) => !a.endsWith(`${entry.slug}.md`))
				.slice(0, 3)
				.map((a) => {
					try {
						return readFileSync(a, "utf-8");
					} catch {
						return "";
					}
				})
				.filter(Boolean)
				.join("\n\n---\n\n");

			// Fix 1: Pass valid links to PAGE_PROMPT
			const pageBody = await generatePage(
				entry,
				logContent,
				existingContent,
				relatedPages,
				validLinksStr,
				signal,
			);

			if (!pageBody.trim()) continue;

			// Fix 2: Post-compile link cleanup — strip broken wikilinks
			const cleanedBody = cleanBrokenWikilinks(pageBody, validPages);

			// Build frontmatter
			const createdAt = existingContent
				? existingContent.match(/created: (.+)/)?.[1] || date
				: date;

			const fullPage = `---
title: ${entry.concept.title}
summary: ${entry.concept.summary}
sources:
  - ${logFile}
tags: [${entry.concept.tags.map((t) => `"${t}"`).join(", ")}]
createdAt: "${createdAt}"
updatedAt: "${date}"
---

${cleanedBody}
`;

			const isCreate = !existsSync(`${WIKI_DIR}/${pagePath}`);
			writeWikiPage(pagePath, fullPage);
			result[isCreate ? "created" : "updated"].push(pagePath);
		} catch (err) {
			console.error(
				`[brain] compile: failed to generate page for ${entry.slug}:`,
				err,
			);
		}
	}

	console.log(
		`[brain] Phase 3 (Generate): created ${result.created.length}, updated ${result.updated.length} pages`,
	);

	// Log dedup stats
	if (dedupRedirects.size > 0) {
		console.log(
			`[brain] Dedup: redirected ${dedupRedirects.size} concepts to existing pages`,
		);
	}

	// Update index
	for (const entry of merged) {
		const indexPath = entry.slug.includes("/")
			? entry.slug
			: `concepts/${entry.slug}`;
		updateIndexEntry(indexPath, entry.concept.summary);
	}

	appendToLog(
		`compile | ${logFile} | created: ${result.created.join(", ")} | updated: ${result.updated.join(", ")} | dedup_redirected: ${dedupRedirects.size}`,
	);

	// Update state
	state.ingested = state.ingested || {};
	state.ingested[logFile] = {
		hash: fileHash(logPath),
		compiled_at: new Date().toISOString(),
		cost_usd: 0,
	};
	state.lastCompile = new Date().toISOString();
	saveState(state);

	return result;
}

function updateIndexEntry(path: string, summary: string): void {
	if (!existsSync(INDEX_PATH)) return;
	let content = readFileSync(INDEX_PATH, "utf-8");
	const pageName = path.split("/").pop()?.replace(".md", "") ?? path;
	const newRow = `| [[${pageName}]] | ${summary} |`;
	const category = path.split("/")[0];
	const sectionName =
		category === "qa"
			? "Queries"
			: category.charAt(0).toUpperCase() + category.slice(1);
	const sectionIdx = content.indexOf(`## ${sectionName}`);
	if (sectionIdx === -1) return;
	const afterSection = content.slice(sectionIdx);
	const tableMatch = afterSection.match(/\n(\|)/);
	if (!tableMatch?.index) return;
	const insertPos = sectionIdx + tableMatch.index;
	content =
		content.slice(0, insertPos) + `\n${newRow}` + content.slice(insertPos);
	writeFileSync(INDEX_PATH, content, "utf-8");
}
