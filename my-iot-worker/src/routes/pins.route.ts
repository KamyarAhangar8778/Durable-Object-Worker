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

	const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + pinId);

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

			const result = await (stub as any).setState({ value: body.value });
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
