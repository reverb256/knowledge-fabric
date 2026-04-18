# Knowledge Fabric

Standalone knowledge base engine extracted from the pi brain extension.

## Status
- **Extraction date:** 2026-04-17
- **Source:** `~/.pi/agent/extensions/brain/`
- **Lines of code:** ~1800 (TypeScript)
- **Test coverage:** None yet

## Architecture

```
index.ts          — Pi extension entry (hooks + tool registration)
lib/
├── state.ts      — Directory management, state.json persistence
├── utils.ts      — File I/O, hashing, wiki page CRUD
├── zai.ts        — Tiered LLM provider chain (E4B → ZAI → NIM → sentry)
├── extract.ts    — Knowledge extraction from conversation text
├── compile.ts    — Three-phase wiki compilation (Plan → Extract → Generate)
├── ingest.ts     — Source ingestion (URLs, files, text)
├── query.ts      — v1: Index-guided retrieval (legacy)
├── query-v2.ts   — v2: Qdrant + SearXNG + RRF fusion (active)
├── qdrant.ts     — Vector store client (embed, upsert, search)
├── cache.ts      — Response caching layer
└── lint.ts       — Structural health checks (8 checks)
```

## Key Design Decisions

1. **No pi-ai dependency for LLM calls** — uses raw `fetch` to provider endpoints because ZAI returns non-standard `reasoning_content` that pi-ai doesn't parse
2. **Tiered routing** — different models for different tasks (fast/quality/verify) with automatic fallback
3. **RRF fusion** — merges local vector search + web search by reciprocal rank, with 1.5x weight for local (trusted) results
4. **Three-phase compilation** — Plan → Extract → Generate prevents unbounded page creation and maintains cross-references
5. **384d embeddings** — uses all-MiniLM-L6-v2 via the KB MCP embed endpoint

## Dependencies

- `@mariozechner/pi-ai` — `StringEnum` type utility
- `@mariozechner/pi-coding-agent` — Extension API, conversation serialization
- `@sinclair/typebox` — Tool parameter schemas
- **Runtime services:** Qdrant, embed endpoint, SearXNG

## External Services (hardcoded IPs)

| Service | Address | Configurable? |
|---------|---------|---------------|
| Qdrant | `10.1.1.120:6333` | Hardcoded in `lib/qdrant.ts` |
| Embed | `10.1.1.120:8643/embed` | Hardcoded in `lib/qdrant.ts` |
| SearXNG | `10.1.1.120:30888` | Hardcoded in `lib/query-v2.ts` |

**TODO:** Extract these to environment variables or config file.

## Pi Extension Wrapper

`pi-extension/index.ts` is a thin re-export wrapper. Copy it to `~/.pi/agent/extensions/brain/index.ts` to use the standalone project as a pi extension without duplicating code.

## Immediate Improvements Needed

- [ ] Extract hardcoded IPs to env vars / config
- [ ] Add unit tests for extract, compile, lint
- [ ] Add integration test for qdrant round-trip
- [ ] Remove query.ts (v1 is superseded by query-v2.ts)
- [ ] Add proper TypeScript strict mode compliance
- [ ] Publish to npm for easier installation
