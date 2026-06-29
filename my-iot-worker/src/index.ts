import { DurableObject } from "cloudflare:workers";

function getNextTriggerTimestamp(timeStr: string, daysArray: number[], referenceDate?: Date): number | null {
	if (!daysArray || daysArray.length === 0) return null;
	const [hours, minutes] = timeStr.split(':').map(Number);
	
	const now = referenceDate || new Date();
	const tehranOffsetMs = 3.5 * 60 * 60 * 1000;
	const nowTehran = new Date(now.getTime() + tehranOffsetMs);
	
	let bestDelay = Infinity;
	
	for (const day of daysArray) {
		let dayDiff = day - nowTehran.getUTCDay();
		if (dayDiff < 0) dayDiff += 7;
		
		let candidate = new Date(nowTehran);
		candidate.setUTCDate(candidate.getUTCDate() + dayDiff);
		candidate.setUTCHours(hours, minutes, 0, 0);
		
		// If it's today but the time has already passed, add 7 days
		if (dayDiff === 0 && candidate.getTime() <= nowTehran.getTime()) {
			candidate.setUTCDate(candidate.getUTCDate() + 7);
		}
		
		const delay = candidate.getTime() - nowTehran.getTime();
		if (delay < bestDelay) {
			bestDelay = delay;
		}
	}
	
	if (bestDelay === Infinity) return null;
	return now.getTime() + bestDelay;
}

/**
 * Durable Object برای نگهداری وضعیت ماژول‌های پین
 */
export class MyDurableObject extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request) {
		if (request.headers.get("Upgrade") === "websocket") {
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		
		// Internal route for DO-to-DO communication
		const url = new URL(request.url);
		if (url.pathname.startsWith("/pins/")) {
			const method = request.method;
			if (method === "POST") {
				const body = (await request.json()) as Record<string, any>;
				await this.setState(body);
				return new Response("OK");
			}
		}
		
		return new Response("Not found", { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message === "string") {
			try {
				const data = JSON.parse(message);
				if (data.type === "sync_pin") {
					const pinId = data.pin;
					const state = data.state;
					
					// Update the specific pin DO
					const stubId = this.env.MY_DURABLE_OBJECT.idFromName("pin_" + pinId);
					const stub = this.env.MY_DURABLE_OBJECT.get(stubId);
					
					// Make an internal fetch request to update the pin state
					const req = new Request(`https://internal/pins/${pinId}`, {
						method: "POST",
						body: JSON.stringify({ value: state })
					});
					await stub.fetch(req);
				}
			} catch (e) {
				console.error("WS parse error", e);
			}
		}
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		ws.close();
	}

	webSocketError(ws: WebSocket, error: unknown) {
		ws.close();
	}

	async testBroadcast(payload: Uint8Array) {
		const sockets = this.ctx.getWebSockets();
		for (const ws of sockets) {
			try {
				ws.send(payload);
			} catch (e) {
				// Ignored
			}
		}
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

	async updateAutomations(automations: any[]) {
		await this.ctx.storage.put("automations", automations);
		await this.scheduleNextAlarm();
	}

	async scheduleNextAlarm() {
		const automations = (await this.ctx.storage.get<any[]>("automations")) || [];
		const activeAutomations = automations.filter(a => a.enabled);

		if (activeAutomations.length === 0) {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		let nextTime = Infinity;
		const now = new Date(); // Use a single reference date for all calculations

		for (const auto of activeAutomations) {
			const triggerTime = getNextTriggerTimestamp(auto.time, auto.days, now);
			if (triggerTime !== null && triggerTime < nextTime) {
				nextTime = triggerTime;
			}
		}

		if (nextTime !== Infinity) {
			const autoIds = activeAutomations
				.filter(auto => getNextTriggerTimestamp(auto.time, auto.days, now) === nextTime)
				.map(auto => auto.id);

			await this.ctx.storage.put("nextAlarmTime", nextTime);
			await this.ctx.storage.put("nextAlarmIds", autoIds);
			await this.ctx.storage.setAlarm(nextTime);
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}

	async alarm() {
		const automations = (await this.ctx.storage.get<any[]>("automations")) || [];
		const nextAlarmIds = (await this.ctx.storage.get<string[]>("nextAlarmIds")) || [];

		// Filter to the ones that just fired
		const fired = automations.filter(a => nextAlarmIds.includes(a.id));

		for (const auto of fired) {
			const targetPin = parseInt(auto.targetPin, 10);
			if (!isNaN(targetPin)) {
				const payload = new Uint8Array([0x06, targetPin, auto.actionOn ? 1 : 0]);
				const sockets = this.ctx.getWebSockets();
				for (const ws of sockets) {
					try {
						ws.send(payload);
					} catch (e) {
						// Ignored
					}
				}
			}
		}

		// Schedule next
		await this.scheduleNextAlarm();
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

		if (path[0] === "test-ws") {
			const payload = new Uint8Array([0x06, 2, 1]); // pin 2 ON
			try {
				const stubId = env.MY_DURABLE_OBJECT.idFromName("automations_controller");
				const stub = env.MY_DURABLE_OBJECT.get(stubId);
				await (stub as any).testBroadcast(payload);
				return new Response(`WS Broadcast Success`, { status: 200, headers: corsHeaders });
			} catch (e: any) {
				return new Response(`WS Error: ${e.message}`, { status: 200, headers: corsHeaders });
			}
		}

		if (path[0] === "ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426, headers: corsHeaders });
			}
			const stubId = env.MY_DURABLE_OBJECT.idFromName("automations_controller");
			const stub = env.MY_DURABLE_OBJECT.get(stubId);
			return stub.fetch(request);
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

				// اگر زیرمسیر esp بود، داده‌ها را با فرمت متنی سفارشی برگردان
				if (path[1] === "esp") {
					try {
						const parsed = JSON.parse(value || "{}");
						const data = parsed?.payload || parsed || {};
						const segments = data.segments_definition || data.segments || [];
						
						let responseText = "ESP_CFG_V2\n";

						const result = await Promise.all(segments.map(async (seg: any) => {
							try {
								const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + seg.pin);
								const state = await (stub as any).getState();
								return { config: seg, pin_number: seg.pin, state };
							} catch (e) {
								return { config: seg, pin_number: seg.pin, state: {} };
							}
						}));

						for (const pin of result) {
							if (pin.config && pin.pin_number != null) {
								responseText += `S id=${pin.config.id} type=${pin.config.type} pin=${pin.pin_number} val=${pin.state?.value ? 1 : 0} ao=${pin.config.autoOffDelay || 0}\n`;

								if (pin.config.rule) {
									if (Array.isArray(pin.config.rule.highActions)) {
										for (const act of pin.config.rule.highActions) {
											responseText += `RH tgt=${act.targetPin} hld=${act.requiredHoldTime || 0} ast=${act.actionState ? 1 : 0} atp=${act.actionType || 0} dly=${act.delay || 0}\n`;
										}
									}
									if (Array.isArray(pin.config.rule.lowActions)) {
										for (const act of pin.config.rule.lowActions) {
											responseText += `RL tgt=${act.targetPin} hld=${act.requiredHoldTime || 0} ast=${act.actionState ? 1 : 0} atp=${act.actionType || 0} dly=${act.delay || 0}\n`;
										}
									}
								}
							}
						}

						return new Response(responseText, {
							headers: {
								'Content-Type': 'text/plain',
								'Cache-Control': 'no-store'
							}
						});
					} catch (e) {
						return new Response("ESP_CFG_V2\n", {
							headers: { "Content-Type": "text/plain" },
						});
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
					
					// Update DO Alarms for automations
					try {
						const configData = JSON.parse(bodyText);
						const automations = configData.automations || configData.payload?.automations || [];
						const stubId = env.MY_DURABLE_OBJECT.idFromName("automations_controller");
						const stub = env.MY_DURABLE_OBJECT.get(stubId);
						await (stub as any).updateAutomations(automations);
					} catch (err) {
						console.error("Failed to update DO alarms", err);
					}

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