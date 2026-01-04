# Repository Guidelines

## Project Structure & Module Organization
`src/index.ts` contains the single Worker entry point plus helper functions for `/api/price`, `/api/market`, and `/debug/*`. Keep new logic close to these handlers or extract small helpers within the same file to preserve the lightweight bundle. Runtime bindings are declared in `worker-configuration.d.ts`, while Wrangler metadata lives in `wrangler.json` and `.wrangler/`. Place future fixtures or integration helpers in `src/` or a new `test/` folder so deployments remain simple.

## Build, Test, and Development Commands
- `npm install` — install Wrangler and TypeScript prerequisites.
- `npm run dev` — `wrangler dev --remote` to exercise edge calls against live R2 SQL.
- `npm run start` — purely local `wrangler dev` when offline iteration is enough.
- `npm run cf-typegen` — regenerate binding types after editing Wrangler config or secrets.
- `npm run check` — TypeScript compile plus `wrangler deploy --dry-run` to catch config drift.
- `npm run deploy` — publish to production; confirm `R2_SQL_TOKEN` first.

## Coding Style & Naming Conventions
The codebase targets ES2021 with strict TypeScript enabled. Match the existing tab indentation, single quotes, and arrow-function handlers. Interfaces use PascalCase (`PolymarketMarket`), locals camelCase, and environment constants SCREAMING_SNAKE_CASE. Keep helpers like `executeR2Sql` stateless and prefer early returns over nested branches so Worker traces stay readable.

## Testing Guidelines
Formal tests are pending; rely on `npm run check` plus targeted curl calls against `npm run dev`. Document manual scenarios in your PR (e.g., ``curl -G http://localhost:8787/api/price/demo --data limit=5``) so reviewers can replay them. If you add automated tests, place them in `test/*.spec.ts`, favor Vitest or Miniflare, and assert both successful R2 SQL responses and error paths.

## Commit & Pull Request Guidelines
History favors concise, present-tense summaries (“source repo import”, “中文翻译”). Follow that style, keep commits focused, and ensure each includes any matching config updates (`Env` interface plus `wrangler.json`). Pull requests should describe motivation, list key commands run (`npm run check`, curl samples), link issues, and attach logs when modifying endpoints. Screenshots are optional unless UI dashboards change.

## Security & Configuration Tips
Manage secrets with Wrangler: `npx wrangler secret put R2_SQL_TOKEN` and double-check via `wrangler secret list`. Never echo tokens into logs. When introducing new bindings, update `Env` and rerun `npm run cf-typegen` so deployments fail fast. Disable or guard `/debug/*` routes before production rollout by checking feature flags or limiting access to authenticated accounts.
Always respond in Chinese-simplified
