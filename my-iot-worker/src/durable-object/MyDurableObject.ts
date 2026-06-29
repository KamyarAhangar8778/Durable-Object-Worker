/**
 * @file durable-object/MyDurableObject.ts
 * Durable Object اصلی: مدیریت WebSocket، state پین‌ها، و اتوماسیون‌ها
 */

import { DurableObject } from "cloudflare:workers";
import { scheduleNextAlarm, fireAlarm } from "./alarm-manager";
import type { Automation } from "../types";

export class MyDurableObject extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		// WebSocket upgrade
		if (request.headers.get("Upgrade") === "websocket") {
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}

		// Internal route: به‌روزرسانی وضعیت پین از طریق fetch داخلی
		const url = new URL(request.url);
		if (url.pathname.startsWith("/pins/") && request.method === "POST") {
			const body = (await request.json()) as Record<string, unknown>;
			await this.setState(body);
			return new Response("OK");
		}

		return new Response("Not found", { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;
		try {
			const data = JSON.parse(message);
			if (data.type !== "sync_pin") return;

			// به‌روزرسانی DO مربوط به پین از طریق fetch داخلی
			const stub = this.env.MY_DURABLE_OBJECT.idFromName("pin_" + data.pin);
			const pinDo = this.env.MY_DURABLE_OBJECT.get(stub);
			await pinDo.fetch(
				new Request(`https://internal/pins/${data.pin}`, {
					method: "POST",
					body: JSON.stringify({ value: data.state }),
				})
			);
		} catch (e) {
			console.error("WS parse error", e);
		}
	}

	webSocketClose(ws: WebSocket): void {
		ws.close();
	}

	webSocketError(ws: WebSocket): void {
		ws.close();
	}

	/** ارسال payload باینری به تمام WebSocket‌های متصل */
	async testBroadcast(payload: Uint8Array): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// اتصال قطع شده — نادیده گرفته می‌شود
			}
		}
	}

	/** گرفتن وضعیت کلی از storage */
	async getState(): Promise<Record<string, unknown>> {
		return ((await this.ctx.storage.get("data")) as Record<string, unknown>) ?? {};
	}

	/** به‌روزرسانی جزئی یا کلی وضعیت در storage */
	async setState(newData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const current = await this.getState();
		const updated = { ...current, ...newData };
		await this.ctx.storage.put("data", updated);
		return updated;
	}

	/** ذخیره اتوماسیون‌ها و زمانبندی آلارم بعدی */
	async updateAutomations(automations: Automation[]): Promise<void> {
		await this.ctx.storage.put("automations", automations);

		// اطلاع به ESP از طریق WebSocket (debug)
		const times = automations.map((a) => a.time).join(", ");
		const debugMsg = `[TEST-WS] Worker received automations for times: ${times || "none"}`;
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send(debugMsg); } catch { /* ignored */ }
		}

		await scheduleNextAlarm(this.ctx.storage);
	}

	/** فراخوانی توسط Cloudflare هنگام رسیدن زمان آلارم */
	async alarm(): Promise<void> {
		await fireAlarm(this.ctx.storage, () => this.ctx.getWebSockets());
	}
}
