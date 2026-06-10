import { DurableObject } from "cloudflare:workers";

/**
 * Durable Object برای نگهداری وضعیت ماژول‌های پین
 */
export class MyDurableObject extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	// گرفتن وضعیت همه پین‌ها
	async getState() {
		const stored = await this.ctx.storage.get("pins");
		return stored ?? {};
	}

	// به‌روزرسانی وضعیت یک پین
	async setState(pinId: string, value: boolean) {
		const current = (await this.getState()) as Record<string, boolean>;
		current[pinId] = value;
		await this.ctx.storage.put("pins", current);
		return current;
	}
}

/**
 * Worker اصلی که مسیرها را مدیریت می‌کند
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.split("/").filter(Boolean);

		// اگر مسیر pins نباشد
		if (path[0] !== "pins") {
			return new Response("Not Found", { status: 404 });
		}

		const pinId = path[1];
		const method = request.method.toUpperCase();

		if (!pinId) {
			return new Response("Pin ID required", { status: 400 });
		}

		// stub مخصوص همان Pin
		const stub = env.MY_DURABLE_OBJECT.getByName(pinId);

		// GET: دریافت وضعیت
		if (method === "GET") {
			const result = await stub.getState();
			return new Response(JSON.stringify(result), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// POST: به‌روزرسانی وضعیت
		if (method === "POST") {
			const body = (await request.json()) as { value?: unknown };
			const value = body.value;
			if (typeof value !== "boolean") {
				return new Response("Invalid body", { status: 400 });
			}
			const result = await stub.setState(pinId, value);
			return new Response(JSON.stringify(result), {
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response("Method Not Allowed", { status: 405 });
	},
} satisfies ExportedHandler<Env>;