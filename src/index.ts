import { DurableObject } from "cloudflare:workers";

/**
 * 欢迎使用 Cloudflare Workers！这是你的第一个 Durable Objects 应用。
 *
 * - 在终端运行 `npm run dev` 启动开发服务器
 * - 在浏览器打开 http://localhost:8787/ 查看 Durable Object 的运行效果
 * - 运行 `npm run deploy` 发布你的应用
 *
 * 在 `wrangler.jsonc` 中绑定资源到你的 worker。添加绑定后，
 * 可以运行 `npm run cf-typegen` 重新生成 `Env` 对象的类型定义。
 *
 * 了解更多：https://developers.cloudflare.com/durable-objects
 */

/** Durable Object 的行为由导出的 JavaScript 类定义 */
export class MyDurableObject extends DurableObject<Env> {
	/**
	 * 构造函数在 Durable Object 首次创建时调用，
	 * 即首次对给定标识符调用 `DurableObjectStub::get` 时（空构造函数可以省略）
	 *
	 * @param ctx - 用于与 Durable Object 状态交互的接口
	 * @param env - 用于引用 wrangler.jsonc 中声明的绑定的接口
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Durable Object 暴露一个 RPC 方法 sayHello，
	 * 当 Worker 通过 stub 上的同名方法调用时，该方法会被触发
	 *
	 * @returns 返回给 Worker 的问候语
	 */
	async sayHello(): Promise<string> {
		let result = this.ctx.storage.sql
			.exec("SELECT 'Hello, World!' as greeting")
			.one() as { greeting: string };
		return result.greeting;

	}
}

export default {
	/**
	 * 这是 Cloudflare Worker 的标准 fetch 处理器
	 *
	 * @param request - 客户端提交给 Worker 的请求
	 * @param env - 用于引用 wrangler.jsonc 中声明的绑定的接口
	 * @param ctx - Worker 的执行上下文
	 * @returns 返回给客户端的响应
	 */
	async fetch(request, env, ctx): Promise<Response> {
		// 为 `MyDurableObject` 类的实例创建一个 `DurableObjectId`。
		// 类名用于标识 Durable Object。
		// 所有 Worker 对同名实例的请求都会路由到同一个全局唯一的 Durable Object 实例。
		const id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(
			new URL(request.url).pathname,
		);

		// 创建一个 stub 来打开与 Durable Object 实例的通信通道
		const stub = env.MY_DURABLE_OBJECT.get(id);

		// 调用 stub 上的 `sayHello()` RPC 方法，
		// 实际上是调用远程 Durable Object 实例上的方法
		const greeting = await stub.sayHello();

		return new Response(greeting);
	},
} satisfies ExportedHandler<Env>;
