# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Workers project with Durable Objects for building a tick data API. The project reads market tick data from Cloudflare R2 (`poly-orderbook` bucket) that was ingested via Cloudflare Streams pipeline from Polymarket websocket feeds.

## Commands

```bash
npm run dev      # Start local dev server (uses remote Durable Objects)
npm run deploy   # Deploy to Cloudflare Workers
npm run check    # Type check + dry-run deploy
npm run cf-typegen  # Regenerate Env type definitions from wrangler.json
```

Dev server runs at http://localhost:8787

## Architecture

- **Entry point**: `src/index.ts` - Contains both the Worker fetch handler and Durable Object class
- **Runtime**: Cloudflare Workers with Durable Objects (SQLite storage)
- **Storage**: R2 bucket `poly-orderbook` bound as `BUCKET`
- **Configuration**: `wrangler.json` defines bindings, migrations, and R2 bucket configuration

## R2 Data Schema

The R2 bucket contains tick data with this structure:
- `event_type`, `market`, `asset_id` (string, required)
- `timestamp`, `ingest_ts` (timestamp, required)
- `price`, `size`, `best_bid`, `best_ask`, `last_trade_price` (float64, optional)
- `side`, `hash`, `raw_json`, `snapshot_id` (string/json, optional)

## Polymarket Integration

Use Polymarket API to convert slugs to market IDs: `https://docs.polymarket.com/api-reference/markets/get-market-by-slug`

## TypeScript Configuration

- Target: ES2021
- Strict mode enabled
- No emit (Wrangler handles bundling)：
- 
