# Polymarket Tick Data API

基于 Cloudflare Workers + R2 SQL 的 Polymarket tick 数据查询 API。

## 部署

```bash
npm install
npx wrangler secret put R2_SQL_TOKEN  # 设置R2 SQL API Token
npm run deploy
```

## API

| 端点 | 说明 |
|------|------|
| `/api/price?token=<id>` | 通过token_id直接查询价格曲线 |
| `/api/price?market=<slug>&token_index=0/1` | 通过market查询某个token的价格曲线 |
| `/api/market/:slug` | 获取Polymarket市场信息 |
| `/debug/sample?limit=N` | 查看样本数据 |
| `/debug/sql?q=SQL` | 执行自定义SQL |

### 参数

- `token` - token_id，直接查询
- `market` - 市场slug或condition_id
- `token_index` - 0或1，选择market中的哪个token
- `limit` - 返回条数（默认1000，最多5000）
- `interval` - 采样粒度（秒），例如 `interval=5` 表示每5秒取一个点（2~3600）
- `start`/`end` - 时间范围，支持ISO8601或Unix时间戳

### 返回格式

- `ts` - 原始Unix时间戳（秒）
- `delta_ts` - 距离市场开始时间的秒数（正数=开始后，负数=开始前）

### 示例

```bash
# 通过market查询全部token
/api/price?market=eth-updown-15m-1767506400&limit=200

# 仅查询token_index=1的价格
/api/price?market=eth-updown-15m-1767506400&token_index=1&limit=100

# 按5秒采样
/api/price?market=eth-updown-15m-1767506400&interval=5

# 直接用token_id查询（可选market用于计算ts基准）
/api/price?token=4999...53692361&market=eth-updown-15m-1767506400
```

## 数据源

- **R2 Bucket**: `poly-orderbook`
- **Iceberg Table**: `polymarket.orderbook`
- 数据通过 Cloudflare Pipelines 从 WebSocket 入库
