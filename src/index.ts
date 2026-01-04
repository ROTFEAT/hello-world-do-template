// 扩展Env类型
declare global {
	interface Env {
		R2_SQL_TOKEN: string;
	}
}

// 配置
const CLOUDFLARE_ACCOUNT_ID = "94d197e33c0d7c88c00816c99445ddcc";
const R2_BUCKET_NAME = "poly-orderbook";
const ICEBERG_NAMESPACE = "polymarket";
const ICEBERG_TABLE = "orderbook";
const R2_SQL_API = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2-sql/query/${R2_BUCKET_NAME}`;

// 类型定义
interface PolymarketMarket {
	conditionId: string;
	clobTokenIds: string;
	outcomes: string;
	slug: string;
	question: string;
}

interface PricePoint {
	ts: number;
	ts_delta: string | null;
	price: number;
}

interface R2SqlResult {
	success: boolean;
	result?: {
		schema: Array<{ name: string }>;
		rows: Record<string, unknown>[];
	};
	errors: Array<{ message?: string; code?: number }>;
	messages: unknown[];
}

// 通过slug获取market信息
async function getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
	try {
		const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
		if (!res.ok) return null;
		const data = await res.json() as PolymarketMarket[];
		return data[0] || null;
	} catch {
		return null;
	}
}

// 通过condition_id获取market信息
async function getMarketByConditionId(id: string): Promise<PolymarketMarket | null> {
	try {
		const res = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${id}`);
		if (!res.ok) return null;
		const data = await res.json() as PolymarketMarket[];
		return data[0] || null;
	} catch {
		return null;
	}
}

// 执行R2 SQL查询
async function executeR2Sql(query: string, token: string): Promise<R2SqlResult> {
	try {
		const res = await fetch(R2_SQL_API, {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query })
		});
		if (!res.ok) {
			return { success: false, errors: [{ message: `HTTP ${res.status}: ${await res.text()}` }], messages: [] };
		}
		return await res.json() as R2SqlResult;
	} catch (e) {
		return { success: false, errors: [{ message: String(e) }], messages: [] };
	}
}

// 辅助函数：处理SQL结果错误
function getError(result: R2SqlResult): string {
	return result.errors?.map(e => e.message || String(e.code)).join(', ') || 'Unknown error';
}

function parseSlugStartTs(slug: string): number | null {
	if (!slug) return null;
	const parts = slug.split('-');
	const lastPart = parts[parts.length - 1];
	const ts = Number(lastPart);
	return Number.isFinite(ts) ? ts : null;
}

function toUnixSeconds(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	const ms = Date.parse(String(value));
	if (Number.isNaN(ms)) return null;
	return Math.floor(ms / 1000);
}

function formatDelta(deltaSeconds: number): string {
	const sign = deltaSeconds >= 0 ? '+' : '-';
	return `${sign}${Math.abs(deltaSeconds)}s`;
}

function normalizeQueryTimestamp(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		const num = Number(trimmed);
		if (!Number.isFinite(num)) return null;
		const ms = trimmed.length <= 10 ? num * 1000 : num;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 1000;
	return Math.min(5000, Math.max(1, limit));
}

async function fetchAssetPrices(params: {
	assetId: string;
	limit: number;
	sqlToken: string;
	start?: string | null;
	end?: string | null;
	baseTs: number | null;
}): Promise<{ data: PricePoint[] } | { error: string }> {
	let where = `asset_id = '${params.assetId}'`;
	const startIso = normalizeQueryTimestamp(params.start ?? null);
	if (startIso) where += ` AND timestamp >= '${startIso}'`;
	const endIso = normalizeQueryTimestamp(params.end ?? null);
	if (endIso) where += ` AND timestamp <= '${endIso}'`;

	const query = `SELECT timestamp, best_ask FROM ${ICEBERG_NAMESPACE}.${ICEBERG_TABLE} WHERE ${where} LIMIT ${clampLimit(params.limit)}`;
	const result = await executeR2Sql(query, params.sqlToken);
	if (!result.success || !result.result) {
		return { error: getError(result) };
	}

	const data: PricePoint[] = result.result.rows.reduce<PricePoint[]>((acc, row) => {
		const price = Number(row.best_ask);
		const ts = toUnixSeconds(row.timestamp);
		if (Number.isNaN(price) || ts === null) return acc;
		acc.push({
			ts,
			ts_delta: params.baseTs === null ? null : formatDelta(ts - params.baseTs),
			price
		});
		return acc;
	}, []);

	return { data: data.sort((a, b) => a.ts - b.ts) };
}

// JSON响应
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers }
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
			});
		}

		const token = env.R2_SQL_TOKEN;
		if (!token && pathname !== '/') {
			return json({ error: 'R2_SQL_TOKEN not configured', message: 'Run: npx wrangler secret put R2_SQL_TOKEN' }, 500);
		}

		// Debug: 获取样本数据
		if (pathname === '/debug/sample') {
			const limit = parseInt(url.searchParams.get('limit') || '10', 10);
			const result = await executeR2Sql(`SELECT * FROM ${ICEBERG_NAMESPACE}.${ICEBERG_TABLE} LIMIT ${limit}`, token);
			if (!result.success || !result.result) return json({ error: getError(result) }, 500);
			return json({ columns: result.result.schema.map(s => s.name), count: result.result.rows.length, data: result.result.rows });
		}

		// Debug: 执行自定义SQL
		if (pathname === '/debug/sql') {
			const q = url.searchParams.get('q');
			if (!q) return json({ error: 'Missing ?q= parameter' }, 400);
			return json(await executeR2Sql(q, token));
		}

		// API: /api/price?slug=...&limit=...&side=...
		if (pathname === '/api/price') {
			const slugOrId = url.searchParams.get('slug');
			if (!slugOrId) return json({ error: 'Missing slug parameter', example: '/api/price?slug=eth-updown-15m-1767506400' }, 400);

			const sideParam = url.searchParams.get('side');
			const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
			const start = url.searchParams.get('start');
			const end = url.searchParams.get('end');

			const market = await getMarketBySlug(slugOrId) || await getMarketByConditionId(slugOrId);
			if (!market) return json({ error: 'Market not found', message: `slug or condition_id: ${slugOrId}` }, 404);

			let tokenIds: string[], outcomes: string[];
			try {
				tokenIds = JSON.parse(market.clobTokenIds);
				outcomes = JSON.parse(market.outcomes);
			} catch {
				return json({ error: 'Failed to parse market token data' }, 500);
			}
			if (!tokenIds.length) return json({ error: 'No tokens found' }, 404);

			const tokens = tokenIds.map((tokenId, index) => ({
				token_id: tokenId,
				outcome: outcomes[index] || `Token ${index + 1}`,
				index
			}));

			let selectedTokens = tokens;
			if (sideParam) {
				const normalized = sideParam.trim().toLowerCase();
				selectedTokens = tokens.filter(t => t.token_id === sideParam || t.outcome?.trim().toLowerCase() === normalized || String(t.index) === normalized);
				if (!selectedTokens.length) {
					return json({ error: `side '${sideParam}' not found`, available: tokens.map(t => ({ index: t.index, outcome: t.outcome, token_id: t.token_id })) }, 404);
				}
			}

			const marketInfo = { condition_id: market.conditionId, slug: market.slug, question: market.question };
			const startTs = parseSlugStartTs(market.slug);

			const data = [];
			for (const tkn of selectedTokens) {
				const series = await fetchAssetPrices({
					assetId: tkn.token_id,
					limit,
					sqlToken: token,
					start,
					end,
					baseTs: startTs
				});
				if ('error' in series) {
					return json({ market: { ...marketInfo, token_id: tkn.token_id }, error: series.error }, 500);
				}
				data.push({ token_id: tkn.token_id, outcome: tkn.outcome, side_index: tkn.index, prices: series.data });
			}

			const totalCount = data.reduce((sum, entry) => sum + entry.prices.length, 0);
			return json({
				market: { ...marketInfo, tokens: tokens.map(t => ({ token_id: t.token_id, outcome: t.outcome })) },
				query: { slug: slugOrId, side: sideParam || null, limit: clampLimit(limit), start: start || null, end: end || null },
				count: totalCount,
				data
			});
		}

		// 兼容旧路径提示
		if (pathname.startsWith('/api/price/')) {
			return json({ error: 'API 已更新', message: '请改用 /api/price?slug=...&limit=...&side=...' }, 400);
		}

		// API: /api/token?token=...
		if (pathname === '/api/token') {
			const tokenId = url.searchParams.get('token');
			if (!tokenId) return json({ error: 'Missing token parameter', example: '/api/token?token=<token_id>' }, 400);
			const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
			const start = url.searchParams.get('start');
			const end = url.searchParams.get('end');
			const slugHint = url.searchParams.get('slug');
			const baseTs = slugHint ? parseSlugStartTs(slugHint) : null;

			const series = await fetchAssetPrices({
				assetId: tokenId,
				limit,
				sqlToken: token,
				start,
				end,
				baseTs
			});

			if ('error' in series) return json({ error: series.error, token_id: tokenId }, 500);

			return json({
				token_id: tokenId,
				slug: slugHint || null,
				query: { token: tokenId, limit: clampLimit(limit), start: start || null, end: end || null },
				count: series.data.length,
				data: series.data
			});
		}

		// API: /api/market/:slug
		if (pathname.startsWith('/api/market/')) {
			const slug = decodeURIComponent(pathname.slice('/api/market/'.length));
			const market = await getMarketBySlug(slug);
			if (!market) return json({ error: 'Market not found' }, 404);
			return json(market);
		}

		// 首页
		if (pathname === '/' || pathname === '') {
			return json({
				name: 'Polymarket Tick Data API',
				status: token ? 'ready' : 'R2_SQL_TOKEN not configured',
				config: { namespace: ICEBERG_NAMESPACE, table: ICEBERG_TABLE, bucket: R2_BUCKET_NAME },
				endpoints: {
					'/api/price': { description: '根据slug获取价格', params: { slug: '市场slug', side: 'Up/Down/索引', limit: '每个token条数', start: '开始时间', end: '结束时间' } },
					'/api/token': { description: '根据token_id获取价格', params: { token: 'token_id', limit: '条数', start: '开始', end: '结束' } },
					'/api/market/:slug': { description: '获取市场信息' },
					'/debug/sample': { description: '样本数据', params: { limit: '条数' } },
					'/debug/sql': { description: '自定义SQL', params: { q: 'SQL语句' } }
				}
			});
		}

		return json({ error: 'Not found' }, 404);
	},
} satisfies ExportedHandler<Env>;
