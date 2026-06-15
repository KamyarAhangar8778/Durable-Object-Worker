import { DurableObject } from "cloudflare:workers";

/**
 * Durable Object برای نگهداری وضعیت ماژول‌های پین
 */
export class MyDurableObject extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	// گرفتن وضعیت کلی
	async getState() {
		const stored = await this.ctx.storage.get("data");
		return stored ?? {};
	}

	// به‌روزرسانی کلی یا جزئی وضعیت
	async setState(newData: Record<string, any>) {
		const current = (await this.getState()) as Record<string, any>;
		const updated = { ...current, ...newData };
		await this.ctx.storage.put("data", updated);
		return updated;
	}
}


/**
 * ساخت پاسخ JSON استاندارد با ساختار ACK
 */
function jsonResponse(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Worker اصلی که مسیرها را مدیریت می‌کند
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.split("/").filter(Boolean);
		const method = request.method.toUpperCase();

		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
		};

		// Handle CORS preflight requests
		if (method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		}

		const handleResponse = (res: Response) => {
			const headers = new Headers(res.headers);
			for (const [key, value] of Object.entries(corsHeaders)) {
				headers.set(key, value);
			}
			return new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers,
			});
		};

		const response: Response = await (async (): Promise<Response> => {
			// ==== 1. مسیر مربوط به تنظیمات اصلی پروژه (Cloudflare KV) ====
		if (path[0] === "config") {
			const configKey = "main_config"; // تنها یک کلید ثابت برای کل تنظیمات

			if (method === "GET") {
				const value = await env.DASH_KV.get(configKey);

				// اگر زیرمسیر esp بود، داده‌ها را فیلتر کن
				if (path[1] === "esp") {
					try {
						const parsed = JSON.parse(value || "{}");
						const data = parsed?.payload || parsed || {};
						const segments = data.segments_definition || data.segments || [];
						
						// فیلتر کردن و فقط برگرداندن شناسه، type، pin و value برای سرعت بیشتر ESP
						const filtered = await Promise.all(segments.map(async (seg: any) => {
							const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + seg.pin);
							const state = await (stub as any).getState();
							return {
								id: seg.id,
								type: seg.type,
								pin: seg.pin,
								auto_off: seg.auto_off || 0,
								value: state.value || false,
								rule: seg.rule || null
							};
						}));
						
						return jsonResponse(filtered);
					} catch (e) {
						return jsonResponse([]);
					}
				}

				// در غیر این صورت کل تنظیمات را برگردان (برای داشبورد)
				return new Response(value ?? "{}", {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (method === "POST" && !path[1]) {
				try {
					const bodyText = await request.text();
					await env.DASH_KV.put(configKey, bodyText);
					return jsonResponse({
						ack: true,
						message: "تنظیمات با موفقیت در سرور ذخیره شد.",
					});
				} catch (e) {
					return jsonResponse({
						ack: false,
						error: "خطا در ذخیره تنظیمات در KV.",
					}, 500);
				}
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		// ==== 2. مسیر مربوط به وضعیت داشبورد (Durable Objects) ====
		if (path[0] === "dashboard") {
			// استفاده از یک شناسه ثابت برای وضعیت داشبورد
			const stub = env.MY_DURABLE_OBJECT.getByName("dashboard_state");

			if (method === "GET") {
				const result = await (stub as any).getState();
				return jsonResponse(result);
			}

			if (method === "POST") {
				try {
					const body = (await request.json()) as Record<string, any>;
					const result = await (stub as any).setState(body);
					return jsonResponse({
						ack: true,
						message: "وضعیت داشبورد با موفقیت به‌روزرسانی شد.",
						data: result,
					});
				} catch (e) {
					return jsonResponse({
						ack: false,
						error: "خطا در به‌روزرسانی وضعیت داشبورد.",
					}, 500);
				}
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		// ==== 3. مسیر مربوط به وضعیت پین‌ها (Durable Objects) ====
		if (path[0] === "pins") {
			const pinId = path[1];

			if (!pinId) {
				return jsonResponse({ ack: false, error: "Pin ID required" }, 400);
			}

			// ایجاد یک نمونه مجزا برای هر پین
			const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + pinId);

			if (method === "GET") {
				const result = await (stub as any).getState();
				return jsonResponse(result);
			}

			if (method === "POST") {
				try {
					const body = (await request.json()) as { value?: unknown };
					if (typeof body.value !== "boolean") {
						return jsonResponse({
							ack: false,
							error: "Invalid body, 'value' must be boolean",
						}, 400);
					}
					// ذخیره مقدار به صورت کلید و مقدار
					const result = await (stub as any).setState({ value: body.value });

					// انتشار به هاب WebSocket حذف شد زیرا از MQTT استفاده می‌شود

					return jsonResponse({
						ack: true,
						message: `وضعیت پین ${pinId} با موفقیت ذخیره شد.`,
						data: result,
					});
				} catch (e) {
					return jsonResponse({
						ack: false,
						error: `خطا در ذخیره وضعیت پین ${pinId}.`,
					}, 500);
				}
			}

			return new Response("Method Not Allowed", { status: 405 });
		}



		// اگر مسیر شناخته شده نباشد
		return new Response("Not Found", { status: 404 });
		})();

		return handleResponse(response);
	},
} satisfies ExportedHandler<Env>;