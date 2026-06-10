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
 * Worker اصلی که مسیرها را مدیریت می‌کند
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.split("/").filter(Boolean);
		const method = request.method.toUpperCase();

		// ==== 1. مسیر مربوط به تنظیمات اصلی پروژه (Cloudflare KV) ====
		if (path[0] === "config") {
			const configKey = "main_config"; // تنها یک کلید ثابت برای کل تنظیمات

			if (method === "GET") {
				const value = await env.DASH_KV.get(configKey);

				// اگر زیرمسیر esp بود، داده‌ها را فیلتر کن
				if (path[1] === "esp") {
					try {
						const parsed = JSON.parse(value || "{}");
						const segments = parsed?.payload?.segments_definition || [];
						
						// فیلتر کردن و فقط برگرداندن شناسه، type و pin برای سرعت بیشتر ESP
						const filtered = segments.map((seg: any) => ({
							id: seg.id,
							type: seg.type,
							pin: seg.pin
						}));
						
						return new Response(JSON.stringify(filtered), {
							headers: { "Content-Type": "application/json" },
						});
					} catch (e) {
						return new Response(JSON.stringify([]), {
							headers: { "Content-Type": "application/json" },
						});
					}
				}

				// در غیر این صورت کل تنظیمات را برگردان (برای داشبورد)
				return new Response(value ?? "{}", {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (method === "POST" && !path[1]) {
				const bodyText = await request.text();
				await env.DASH_KV.put(configKey, bodyText);
				return new Response(JSON.stringify({ success: true, message: "Settings saved" }), {
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		// ==== 2. مسیر مربوط به وضعیت داشبورد (Durable Objects) ====
		if (path[0] === "dashboard") {
			// استفاده از یک شناسه ثابت برای وضعیت داشبورد
			const stub = env.MY_DURABLE_OBJECT.getByName("dashboard_state");

			if (method === "GET") {
				const result = await stub.getState();
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (method === "POST") {
				const body = (await request.json()) as Record<string, any>;
				const result = await stub.setState(body);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		// ==== 3. مسیر مربوط به وضعیت پین‌ها (Durable Objects) ====
		if (path[0] === "pins") {
			const pinId = path[1];

			if (!pinId) {
				return new Response("Pin ID required", { status: 400 });
			}

			// ایجاد یک نمونه مجزا برای هر پین
			const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + pinId);

			if (method === "GET") {
				const result = await stub.getState();
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}

			if (method === "POST") {
				const body = (await request.json()) as { value?: unknown };
				if (typeof body.value !== "boolean") {
					return new Response("Invalid body, 'value' must be boolean", { status: 400 });
				}
				// ذخیره مقدار به صورت کلید و مقدار
				const result = await stub.setState({ value: body.value });
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("Method Not Allowed", { status: 405 });
		}

		// اگر مسیر شناخته شده نباشد
		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;