/**
 * Lint the brain wiki for health issues.
 *
 * Eight checks: broken links, orphan pages, stale articles,
 * missing backlinks, sparse articles, orphan sources, contradictions,
 * knowledge gaps (disconnected tag clusters).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DAILY_DIR, loadState, WIKI_DIR } from "./state.js";
import { listWikiArticles, readIndex, readWikiPage } from "./utils.js";
import { callLLM } from "./zai.js";

export interface LintIssue {
	check: string;
	severity: "error" | "warning" | "suggestion";
	message: string;
	file?: string;
}

export interface LintReport {
	timestamp: string;
	issues: LintIssue[];
	totalPages: number;
}

export async function lintWiki(
	structuralOnly: boolean,
	ctx?: ExtensionContext,
	signal?: AbortSignal,
): Promise<LintReport> {
	const issues: LintIssue[] = [];
	const articles = listWikiArticles();
	const totalPages = articles.length;

	// 1. Broken links — [[wikilinks]] pointing to non-existent files
	const allWikiFiles = new Set(
		articles.map((a) => {
			const rel = relative(WIKI_DIR, a).replace(".md", "");
			return rel;
		}),
	);

	const linkPattern = /\[\[([^\]|]+)/g;
	const articleContents = new Map<string, string>();

	// Helper: resolve a wikilink target to an actual wiki page
	const resolveLink = (target: string): string | null => {
		if (allWikiFiles.has(target)) return target;
		// Try matching as leaf name (e.g. "memex" matches "concepts/memex")
		const leaf = target.split("/").pop() || target;
		for (const f of allWikiFiles) {
			if (f.endsWith("/" + leaf) || f === leaf) return f;
		}
		return null;
	};

	for (const artPath of articles) {
		try {
			const content = readFileSync(artPath, "utf-8");
			const rel = relative(WIKI_DIR, artPath).replace(".md", "");
			articleContents.set(rel, content);

			for (const match of content.matchAll(linkPattern)) {
				const target = match[1].trim();
				if (target.startsWith("http") || target.startsWith("/")) continue; // External links ok
				if (!resolveLink(target)) {
					issues.push({
						check: "broken_links",
						severity: "error",
						message: `Link [[${target}]] points to non-existent page`,
						file: rel,
					});
				}
			}
		} catch {
			// Skip unreadable
		}
	}

	// 2. Orphan pages — no inbound links from other pages
	const inboundLinks = new Map<string, number>();
	for (const [rel, content] of articleContents) {
		for (const match of content.matchAll(linkPattern)) {
			const target = match[1].trim();
			const resolved = resolveLink(target);
			if (resolved) {
				inboundLinks.set(resolved, (inboundLinks.get(resolved) || 0) + 1);
			}
		}
	}

	for (const rel of allWikiFiles) {
		if (
			!inboundLinks.has(rel) &&
			!rel.includes("overview") &&
			!rel.includes("index")
		) {
			issues.push({
				check: "orphan_pages",
				severity: "warning",
				message: `No inbound links to this page`,
				file: rel,
			});
		}
	}

	// 3. Sparse articles — under 200 words
	for (const [rel, content] of articleContents) {
		// Strip frontmatter
		const body = content.replace(/^---[\s\S]*?---\n*/, "");
		const wordCount = body.split(/\s+/).length;
		if (wordCount < 200) {
			issues.push({
				check: "sparse_articles",
				severity: "suggestion",
				message: `Only ${wordCount} words (minimum 200 recommended)`,
				file: rel,
			});
		}
	}

	// 4. Missing backlinks — A links to B but B doesn't link back
	for (const [rel, content] of articleContents) {
		const targets = new Set<string>();
		for (const match of content.matchAll(linkPattern)) {
			targets.add(match[1].trim());
		}
		for (const target of targets) {
			const targetContent = articleContents.get(target);
			if (targetContent && !targetContent.includes(`[[${rel}]]`)) {
				issues.push({
					check: "missing_backlinks",
					severity: "suggestion",
					message: `[[${rel}]] links to [[${target}]] but not vice versa`,
					file: target,
				});
			}
		}
	}

	// 5. Orphan sources — daily logs that haven't been compiled
	const state = loadState();
	const ingested = state.ingested || {};
	if (existsSync(DAILY_DIR)) {
		for (const logFile of readdirSync(DAILY_DIR).filter((f) =>
			f.endsWith(".md"),
		)) {
			if (!ingested[logFile]) {
				issues.push({
					check: "orphan_sources",
					severity: "warning",
					message: `Daily log not yet compiled`,
					file: logFile,
				});
			}
		}
	}

	// 6. Stale articles — source log changed since article was compiled
	for (const [logFile, entry] of Object.entries(ingested)) {
		const logPath = join(DAILY_DIR, logFile);
		if (existsSync(logPath)) {
			const currentHash = (() => {
				try {
					return createHash("sha256")
						.update(readFileSync(logPath))
						.digest("hex")
						.slice(0, 16);
				} catch {
					return "";
				}
			})();
			if (currentHash && currentHash !== entry.hash) {
				issues.push({
					check: "stale_articles",
					severity: "warning",
					message: `Source log changed since last compilation`,
					file: logFile,
				});
			}
		}
	}

	// 7. Contradictions — requires LLM (optional)
	if (!structuralOnly && ctx && articles.length >= 2) {
		try {
			const contradictionIssues = await findContradictions(
				articleContents,
				ctx,
				signal,
			);
			issues.push(...contradictionIssues);
		} catch {
			// Skip contradiction check on error
		}
	}

	// 8. Knowledge gaps — disconnected tag clusters
	try {
		const gapIssues = findKnowledgeGaps(articleContents, resolveLink);
		issues.push(...gapIssues);
	} catch {
		// Skip gap analysis on error
	}

	return {
		timestamp: new Date().toISOString(),
		issues,
		totalPages,
	};
}

/**
 * Find knowledge gaps by detecting disconnected tag clusters.
 *
 * Algorithm:
 * 1. Extract tags from frontmatter of all wiki pages
 * 2. Group pages into clusters by shared tags (pages sharing ≥1 tag)
 * 3. Build adjacency: two clusters are "connected" if any page in one
 *    links to any page in the other
 * 4. Report the top disconnected cluster pairs as gaps
 */
function findKnowledgeGaps(
	articleContents: Map<string, string>,
	resolveLink: (target: string) => string | null,
): LintIssue[] {
	const issues: LintIssue[] = [];
	const tagPattern = /^tags:\s*\[(.*?)\]/m;
	const linkPattern = /\[\[([^\]|]+)/g;

	// Step 1: Extract tags per page
	const pageTags = new Map<string, Set<string>>();
	for (const [rel, content] of articleContents) {
		const match = content.match(tagPattern);
		if (match) {
			const tags = new Set(
				match[1]
					.split(",")
					.map((t) => t.trim().replace(/["']/g, "").toLowerCase())
					.filter((t) => t.length > 0),
			);
			if (tags.size > 0) {
				pageTags.set(rel, tags);
			}
		}
	}

	if (pageTags.size < 4) return issues; // Not enough tagged pages

	// Step 2: Build tag → pages index
	const tagPages = new Map<string, Set<string>>();
	for (const [page, tags] of pageTags) {
		for (const tag of tags) {
			let set = tagPages.get(tag);
			if (!set) {
				set = new Set();
				tagPages.set(tag, set);
			}
			set.add(page);
		}
	}

	// Only consider tags with 2+ pages (meaningful clusters)
	const clusters = new Map<string, Set<string>>();
	for (const [tag, pages] of tagPages) {
		if (pages.size >= 2) {
			clusters.set(tag, pages);
		}
	}

	if (clusters.size < 2) return issues; // Need at least 2 clusters

	// Step 3: Check connectivity between cluster pairs
	// Two clusters are connected if a page in one links to a page in the other
	const clusterNames = [...clusters.keys()];
	const gaps: { tag1: string; tag2: string; size1: number; size2: number }[] =
		[];

	for (let i = 0; i < clusterNames.length; i++) {
		for (let j = i + 1; j < clusterNames.length; j++) {
			const c1 = clusterNames[i];
			const c2 = clusterNames[j];
			const p1 = clusters.get(c1)!;
			const p2 = clusters.get(c2)!;

			// Skip if they share pages (not really separate clusters)
			const shared = [...p1].some((p) => p2.has(p));
			if (shared) continue;

			// Check for cross-links
			let hasCrossLink = false;
			for (const page of p1) {
				const content = articleContents.get(page);
				if (!content) continue;
				for (const linkMatch of content.matchAll(linkPattern)) {
					const resolved = resolveLink(linkMatch[1].trim());
					if (resolved && p2.has(resolved)) {
						hasCrossLink = true;
						break;
					}
				}
				if (hasCrossLink) break;
			}

			// Also check reverse direction
			if (!hasCrossLink) {
				for (const page of p2) {
					const content = articleContents.get(page);
					if (!content) continue;
					for (const linkMatch of content.matchAll(linkPattern)) {
						const resolved = resolveLink(linkMatch[1].trim());
						if (resolved && p1.has(resolved)) {
							hasCrossLink = true;
							break;
						}
					}
					if (hasCrossLink) break;
				}
			}

			if (!hasCrossLink) {
				gaps.push({
					tag1: c1,
					tag2: c2,
					size1: p1.size,
					size2: p2.size,
				});
			}
		}
	}

	// Step 4: Report top gaps (sorted by combined cluster size, limit to 10)
	gaps.sort((a, b) => b.size1 + b.size2 - (a.size1 + a.size2));
	const topGaps = gaps.slice(0, 10);

	for (const gap of topGaps) {
		issues.push({
			check: "knowledge_gaps",
			severity: "suggestion",
			message: `Disconnected clusters: [${gap.tag1}] (${gap.size1} pages) ↔ [${gap.tag2}] (${gap.size2} pages) — consider creating a connection page in wiki/connections/`,
		});
	}

	if (gaps.length > 10) {
		issues.push({
			check: "knowledge_gaps",
			severity: "suggestion",
			message: `...and ${gaps.length - 10} more disconnected cluster pairs (total: ${gaps.length})`,
		});
	}

	return issues;
}

async function findContradictions(
	articles: Map<string, string>,
	_ctx?: ExtensionContext,
	signal?: AbortSignal,
): Promise<LintIssue[]> {
	const entries = [...articles.entries()].slice(0, 10);
	const summary: string[] = [];

	for (const [rel, content] of entries) {
		const body = content.replace(/^---[\s\S]*?---\n*/, "");
		const firstParagraph = body.split("\n\n")[1] || body.slice(0, 200);
		summary.push(`### ${rel}\n${firstParagraph}`);
	}

	const prompt = `Find contradictions. Output JSON only.
{"contradictions":[{"file1":"<path>","file2":"<path>","claim":"<what contradicts>","details":"<explanation>"}]}
Empty if none: {"contradictions":[]}

${summary.join("\n\n")}`;

	try {
		const text = await callLLM(prompt, 1024, signal);
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return [];

		const parsed = JSON.parse(jsonMatch[0]);
		return (parsed.contradictions || []).map((c: any) => ({
			check: "contradictions",
			severity: "warning" as const,
			message: `Contradiction with [[${c.file2}]]: ${c.details || c.claim}`,
			file: c.file1,
		}));
	} catch {
		return [];
	}
}

export interface KnowledgeGap {
	tag1: string;
	tag2: string;
	pages1: string[];
	pages2: string[];
}

export function findKnowledgeGapsData(
	articleContents: Map<string, string>,
	resolveLink: (target: string) => string | null,
): KnowledgeGap[] {
	const tagPattern = /^tags:\s*\[(.*?)\]/m;
	const linkPattern = /\[\[([^\]|]+)/g;

	const pageTags = new Map<string, Set<string>>();
	for (const [rel, content] of articleContents) {
		const match = content.match(tagPattern);
		if (match) {
			const tags = new Set(
				match[1]
					.split(",")
					.map((t) => t.trim().replace(/["']/g, "").toLowerCase())
					.filter((t) => t.length > 0),
			);
			if (tags.size > 0) pageTags.set(rel, tags);
		}
	}

	if (pageTags.size < 4) return [];

	const tagPages = new Map<string, Set<string>>();
	for (const [page, tags] of pageTags) {
		for (const tag of tags) {
			let set = tagPages.get(tag);
			if (!set) {
				set = new Set();
				tagPages.set(tag, set);
			}
			set.add(page);
		}
	}

	const clusters = new Map<string, Set<string>>();
	for (const [tag, pages] of tagPages) {
		if (pages.size >= 2) clusters.set(tag, pages);
	}

	if (clusters.size < 2) return [];

	const clusterNames = [...clusters.keys()];
	const gaps: KnowledgeGap[] = [];

	for (let i = 0; i < clusterNames.length; i++) {
		for (let j = i + 1; j < clusterNames.length; j++) {
			const c1 = clusterNames[i];
			const c2 = clusterNames[j];
			const p1 = clusters.get(c1)!;
			const p2 = clusters.get(c2)!;

			if ([...p1].some((p) => p2.has(p))) continue;

			let hasCrossLink = false;
			for (const page of p1) {
				const content = articleContents.get(page);
				if (!content) continue;
				for (const linkMatch of content.matchAll(linkPattern)) {
					const resolved = resolveLink(linkMatch[1].trim());
					if (resolved && p2.has(resolved)) {
						hasCrossLink = true;
						break;
					}
				}
				if (hasCrossLink) break;
			}

			if (!hasCrossLink) {
				for (const page of p2) {
					const content = articleContents.get(page);
					if (!content) continue;
					for (const linkMatch of content.matchAll(linkPattern)) {
						const resolved = resolveLink(linkMatch[1].trim());
						if (resolved && p1.has(resolved)) {
							hasCrossLink = true;
							break;
						}
					}
					if (hasCrossLink) break;
				}
			}

			if (!hasCrossLink) {
				gaps.push({
					tag1: c1,
					tag2: c2,
					pages1: [...p1],
					pages2: [...p2],
				});
			}
		}
	}

	gaps.sort((a, b) => (b.pages1.length + b.pages2.length) - (a.pages1.length + a.pages2.length));
	return gaps;
}
