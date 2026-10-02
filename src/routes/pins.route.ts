/**
 * @file routes/pins.route.ts
 * مدیریت مسیر /pins/:id — وضعیت پین‌های فیزیکی (Durable Object)
 */

import { jsonResponse } from "../utils/response";

/**
 * Handler برای GET/POST /pins/:id
 */
export async function handlePins(
	request: Request,
	env: Env,
	path: string[],
	method: string
): Promise<Response> {
	const pinId = path[1];

	if (!pinId) {
		return jsonResponse({ ack: false, error: "Pin ID required" }, 400);
	}

	if (pinId === "batch" && method === "POST") {
		try {
			const body = (await request.json()) as { actions: Array<{ pin: string, state: boolean }> };
			
			if (!Array.isArray(body.actions)) {
				return jsonResponse({ ack: false, error: "Invalid body, 'actions' must be an array" }, 400);
			}

			await Promise.all(body.actions.map(async (action) => {
				const stub = (env.MY_DURABLE_OBJECT as any).getByName
					? (env.MY_DURABLE_OBJECT as any).getByName("pin_" + action.pin)
					: env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName("pin_" + action.pin));
				return (stub as any).setState({ value: action.state });
			}));

			// برودکست تغییرات گروهی پین‌ها به سخت‌افزار ESP32 از طریق WebSocket
			try {
				const autoStub = env.MY_DURABLE_OBJECT.get(
					env.MY_DURABLE_OBJECT.idFromName("automations_controller")
				);
				const count = Math.min(body.actions.length, 255);
				const payload = new Uint8Array(2 + count * 2);
				payload[0] = 0x08;
				payload[1] = count;
				for (let i = 0; i < count; i++) {
					payload[2 + i * 2] = parseInt(body.actions[i].pin, 10) & 0xff;
					payload[3 + i * 2] = body.actions[i].state ? 1 : 0;
				}
				await (autoStub as any).testBroadcast(payload);
			} catch (e) {
				console.error("Failed to broadcast batch pins to ESP32 over WS", e);
			}

			return jsonResponse({
				ack: true,
				message: `وضعیت ${body.actions.length} پین با موفقیت به‌روزرسانی شد.`,
			});
		} catch (e) {
			return jsonResponse({ ack: false, error: `خطا در بروزرسانی گروهی پین‌ها.` }, 500);
		}
	}

	const stub = (env.MY_DURABLE_OBJECT as any).getByName
		? (env.MY_DURABLE_OBJECT as any).getByName("pin_" + pinId)
		: env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName("pin_" + pinId));

	if (method === "GET") {
		const result = await (stub as any).getState();
		return jsonResponse(result);
	}

	if (method === "POST") {
		try {
			const body = (await request.json()) as { value?: unknown };

			if (typeof body.value !== "boolean") {
				return jsonResponse({ ack: false, error: "Invalid body, 'value' must be boolean" }, 400);
			}

			const boolVal = body.value === true;
			const result = await (stub as any).setState({ value: boolVal });

			// برودکست فوری تغییر وضعیت پین به ESP32 از طریق وب‌سوکت دائمی کلادفلر
			try {
				const autoStub = env.MY_DURABLE_OBJECT.get(
					env.MY_DURABLE_OBJECT.idFromName("automations_controller")
				);
				const payload = new Uint8Array([0x06, parseInt(pinId, 10) & 0xff, boolVal ? 1 : 0]);
				await (autoStub as any).testBroadcast(payload);
			} catch (e) {
				console.error("Failed to broadcast pin change to ESP32 over WS", e);
			}

			return jsonResponse({
				ack: true,
				message: `وضعیت پین ${pinId} با موفقیت ذخیره شد.`,
				data: result,
			});
		} catch {
			return jsonResponse({ ack: false, error: `خطا در ذخیره وضعیت پین ${pinId}.` }, 500);
		}
	}

	return new Response("Method Not Allowed", { status: 405 });
}
