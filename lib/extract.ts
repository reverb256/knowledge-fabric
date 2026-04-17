/**
 * Knowledge extraction from pi session conversations.
 *
 * Uses a cheap model (ZAI GLM-5-turbo) to extract decisions, lessons,
 * gotchas, and patterns from serialized conversation text.
 *
 * Uses raw fetch instead of pi-ai's complete() because ZAI returns
 * non-standard reasoning_content that pi-ai doesn't parse correctly
 * when called outside of pi's model registry context.
 */

import { callLLM } from "./zai.js";

export interface ExtractedItem {
	category:
		| "decision"
		| "lesson"
		| "gotcha"
		| "pattern"
		| "action_item"
		| "fact";
	content: string;
}

export interface ExtractedKnowledge {
	context: string;
	items: ExtractedItem[];
}

const EXTRACTION_PROMPT = `Extract knowledge from conversation. Output JSON only.

{"context":"<one line topic>","items":[{"category":"<decision|lesson|gotcha|pattern|action_item|fact>","content":"<specific with paths/commands/errors>"}]}

3-10 items. Skip trivial. Include rationale for decisions. Empty if nothing worth saving: {"context":"","items":[]}

---
{conversation}`;

export async function extractKnowledge(
	conversationText: string,
	_model?: any,
	_apiKey?: string,
	_headers?: Record<string, string>,
	signal?: AbortSignal,
	tier: "fast" | "quality" | "verify" = "fast",
): Promise<ExtractedKnowledge | null> {
	if (conversationText.length < 100) return null;

	const prompt = EXTRACTION_PROMPT.replace("{conversation}", conversationText);

	try {
		const text = await callLLM(prompt, 8192, signal, undefined, tier);

		// Try to extract JSON from the response
		// Strip markdown code fences first (```json ... ```)
		const cleaned = text
			.replace(/^```(?:json)?\s*\n?/im, "")
			.replace(/\n?```\s*$/m, "")
			.trim();

		const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		let parsed: any;
		try {
			parsed = JSON.parse(jsonMatch[0]);
		} catch {
			// Try progressively smaller substrings (handle trailing junk)
			let lastBrace = cleaned.lastIndexOf("}");
			while (lastBrace > 0) {
				try {
					parsed = JSON.parse(cleaned.substring(0, lastBrace + 1));
					break;
				} catch {
					lastBrace = cleaned.lastIndexOf("}", lastBrace - 1);
				}
			}
			if (!parsed) return null;
		}
		if (
			!parsed.items ||
			!Array.isArray(parsed.items) ||
			parsed.items.length === 0
		) {
			return null;
		}

		return {
			context: parsed.context || "",
			items: parsed.items.map((item: any) => ({
				category: item.category || "fact",
				content: String(item.content),
			})),
		};
	} catch (err) {
		if ((err as any).name !== "AbortError") {
			console.error("[brain] extraction error:", err);
		}
		return null;
	}
}
