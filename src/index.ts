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

const MAX_SAMPLE_INTERVAL_SECONDS = 3600;

// 类型定义
interface PolymarketMarket {
	conditionId: string;
	clobTokenIds: string;
	outcomes: string;
	slug: string;
	question: string;
}

interface PricePoint {
	ts: number;       // 原始Unix时间戳（秒）
	delta_ts: number | null;  // 距离开始时间的秒数
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

function parseDurationSegment(segment: string | undefined): number | null {
	if (!segment) return null;
	const match = /^(\d+)([smhd])$/i.exec(segment.trim());
	if (!match) return null;
	const value = Number(match[1]);
	const unit = match[2].toLowerCase();
	if (!Number.isFinite(value)) return null;
	const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
	const multiplier = multipliers[unit];
	return multiplier ? value * multiplier : null;
}

function deriveSlugWindow(slug: string): { startTs: number | null; endTs: number | null } {
	const parts = slug.split('-');
	const startTs = parseSlugStartTs(slug);
	if (startTs === null) return { startTs: null, endTs: null };
	const durationSeconds = parseDurationSegment(parts[parts.length - 2]);
	return { startTs, endTs: durationSeconds ? startTs + durationSeconds : null };
}

function secondsToIso(ts: number | null): string | null {
	if (ts === null) return null;
	const date = new Date(ts * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseSampleInterval(value: string | null): { value: number | null; error?: string } {
	if (!value) return { value: null };
	const num = Number(value);
	if (!Number.isFinite(num)) return { value: null, error: 'interval 必须是数字（秒）' };
	if (num < 2) return { value: null, error: 'interval 需大于等于 2 秒' };
	if (num > MAX_SAMPLE_INTERVAL_SECONDS) {
		return { value: null, error: `interval 不得超过 ${MAX_SAMPLE_INTERVAL_SECONDS} 秒` };
	}
	return { value: Math.floor(num) };
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
	sampleSeconds?: number | null;
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
		const unixTs = toUnixSeconds(row.timestamp);
		if (Number.isNaN(price) || unixTs === null) return acc;
		acc.push({
			ts: unixTs,
			delta_ts: params.baseTs === null ? null : unixTs - params.baseTs,
			price
		});
		return acc;
	}, []);

	const sorted = data.sort((a, b) => a.ts - b.ts);
	return { data: applySampling(sorted, params.sampleSeconds) };
}

function applySampling(points: PricePoint[], intervalSeconds?: number | null): PricePoint[] {
	if (!intervalSeconds || intervalSeconds <= 1 || !points.length) return points;
	const sampled: PricePoint[] = [];
	let lastBucket: number | null = null;
	for (const point of points) {
		// 使用delta_ts分桶（如果有），否则使用ts
		const timeVal = point.delta_ts ?? point.ts;
		const bucket = Math.floor(timeVal / intervalSeconds);
		if (lastBucket === bucket && sampled.length) {
			sampled[sampled.length - 1] = point;
			continue;
		}
		sampled.push(point);
		lastBucket = bucket;
	}
	return sampled;
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

		// API: /api/price?token=<token_id> 或 /api/price?market=<slug>&token_index=0/1
		if (pathname === '/api/price') {
			const tokenId = url.searchParams.get('token');
			const marketSlug = url.searchParams.get('market');
			const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
			const startParam = url.searchParams.get('start');
			const endParam = url.searchParams.get('end');
			const intervalRaw = url.searchParams.get('interval') ?? url.searchParams.get('sample');
			const interval = parseSampleInterval(intervalRaw);
			if (interval.error) return json({ error: interval.error, hint: '示例：interval=5 表示5秒采样' }, 400);

			// 模式1: 直接通过token_id查询
			if (tokenId) {
				const slugHint = marketSlug;
				const baseTs = slugHint ? parseSlugStartTs(slugHint) : null;
				const slugWindow = slugHint ? deriveSlugWindow(slugHint) : { startTs: null, endTs: null };
				const effectiveStart = startParam ?? secondsToIso(slugWindow.startTs);
				const effectiveEnd = endParam ?? secondsToIso(slugWindow.endTs);

				const series = await fetchAssetPrices({
					assetId: tokenId,
					limit,
					sqlToken: token,
					start: effectiveStart,
					end: effectiveEnd,
					baseTs,
					sampleSeconds: interval.value
				});

				if ('error' in series) return json({ error: series.error, token_id: tokenId }, 500);

				return json({
					token_id: tokenId,
					market: slugHint || null,
					query: { token: tokenId, limit: clampLimit(limit), interval: interval.value, start: effectiveStart, end: effectiveEnd },
					count: series.data.length,
					data: series.data
				});
			}

			// 模式2: 通过market + token_index查询
			if (marketSlug) {
				const tokenIndexParam = url.searchParams.get('token_index');
				const market = await getMarketBySlug(marketSlug) || await getMarketByConditionId(marketSlug);
				if (!market) return json({ error: 'Market not found', market: marketSlug }, 404);

				let tokenIds: string[], outcomes: string[];
				try {
					tokenIds = JSON.parse(market.clobTokenIds);
					outcomes = JSON.parse(market.outcomes);
				} catch {
					return json({ error: 'Failed to parse market token data' }, 500);
				}
				if (!tokenIds.length) return json({ error: 'No tokens found' }, 404);

				const tokens = tokenIds.map((id, idx) => ({ token_id: id, outcome: outcomes[idx] || `Token ${idx}`, index: idx }));

				let selectedTokens = tokens;
				if (tokenIndexParam !== null) {
					const idx = parseInt(tokenIndexParam, 10);
					if (isNaN(idx) || idx < 0 || idx >= tokens.length) {
						return json({ error: `token_index '${tokenIndexParam}' 无效`, available: tokens.map(t => ({ index: t.index, outcome: t.outcome })) }, 400);
					}
					selectedTokens = [tokens[idx]];
				}

				const marketInfo = { condition_id: market.conditionId, slug: market.slug, question: market.question };
				const startTs = parseSlugStartTs(market.slug);
				const slugWindow = deriveSlugWindow(market.slug);
				const effectiveStart = startParam ?? secondsToIso(slugWindow.startTs);
				const effectiveEnd = endParam ?? secondsToIso(slugWindow.endTs);

				const data = [];
				for (const tkn of selectedTokens) {
					const series = await fetchAssetPrices({
						assetId: tkn.token_id,
						limit,
						sqlToken: token,
						start: effectiveStart,
						end: effectiveEnd,
						baseTs: startTs,
						sampleSeconds: interval.value
					});
					if ('error' in series) {
						return json({ market: { ...marketInfo, token_id: tkn.token_id }, error: series.error }, 500);
					}
					data.push({ token_id: tkn.token_id, outcome: tkn.outcome, token_index: tkn.index, prices: series.data });
				}

				const totalCount = data.reduce((sum, entry) => sum + entry.prices.length, 0);
				return json({
					market: { ...marketInfo, tokens: tokens.map(t => ({ token_id: t.token_id, outcome: t.outcome, index: t.index })) },
					query: { market: marketSlug, token_index: tokenIndexParam ? parseInt(tokenIndexParam, 10) : null, limit: clampLimit(limit), interval: interval.value, start: effectiveStart, end: effectiveEnd },
					count: totalCount,
					data
				});
			}

			return json({
				error: 'Missing parameters',
				usage: [
					'/api/price?token=<token_id>',
					'/api/price?market=<slug>&token_index=0/1'
				]
			}, 400);
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
					'/api/price?token=<id>': { description: '通过token_id查询价格', params: { token: 'token_id', market: '可选slug', limit: '条数', interval: '采样秒' } },
					'/api/price?market=<slug>': { description: '通过market查询价格', params: { market: 'slug', token_index: '0或1', limit: '条数', interval: '采样秒' } },
					'/api/market/:slug': { description: '获取市场信息' },
					'/debug/sample': { description: '样本数据', params: { limit: '条数' } },
					'/debug/sql': { description: '自定义SQL', params: { q: 'SQL语句' } }
				}
			});
		}

		return json({ error: 'Not found' }, 404);
	},
} satisfies ExportedHandler<Env>;
