/**
 * @file routes/config.route.ts
 * مدیریت مسیر /config — تنظیمات اصلی پروژه (Cloudflare KV + DO Alarms)
 */

import { jsonResponse } from "../utils/response";
import type { PinConfig } from "../types";

const CONFIG_KEY = "main_config";

/**
 * ساخت متن فرمت ESP_CFG_V2 برای ارسال به میکروکنترلر
 */
async function buildEspConfigText(env: Env, value: string | null): Promise<string> {
	const parsed = JSON.parse(value ?? "{}");
	const data = parsed?.payload ?? parsed ?? {};
	const segments: PinConfig[] = data.segments_definition ?? data.segments ?? [];

	let text = "ESP_CFG_V2\n";

	const results = await Promise.all(
		segments.map(async (seg) => {
			try {
				const stub = env.MY_DURABLE_OBJECT.getByName("pin_" + seg.pin);
				const state = await (stub as any).getState();
				return { config: seg, state };
			} catch {
				return { config: seg, state: {} };
			}
		})
	);

	for (const { config: seg, state } of results) {
		if (!seg || seg.pin == null) continue;
		text += `S id=${seg.id} type=${seg.type} pin=${seg.pin} val=${state?.value ? 1 : 0} ao=${seg.autoOffDelay ?? 0}\n`;

		if (seg.rule) {
			for (const act of seg.rule.highActions ?? []) {
				text += `RH tgt=${act.targetPin} hld=${act.requiredHoldTime ?? 0} ast=${act.actionState ? 1 : 0} atp=${act.actionType ?? 0} dly=${act.delay ?? 0}\n`;
			}
			for (const act of seg.rule.lowActions ?? []) {
				text += `RL tgt=${act.targetPin} hld=${act.requiredHoldTime ?? 0} ast=${act.actionState ? 1 : 0} atp=${act.actionType ?? 0} dly=${act.delay ?? 0}\n`;
			}
		}
	}

	return text;
}

/**
 * Handler اصلی برای /config
 */
export async function handleConfig(
	request: Request,
	env: Env,
	path: string[],
	method: string
): Promise<Response> {
	if (method === "GET") {
		const value = await env.DASH_KV.get(CONFIG_KEY);

		if (path[1] === "esp") {
			try {
				const text = await buildEspConfigText(env, value);
				return new Response(text, {
					headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
				});
			} catch {
				return new Response("ESP_CFG_V2\n", { headers: { "Content-Type": "text/plain" } });
			}
		}

		// برای داشبورد: کل JSON تنظیمات
		return new Response(value ?? "{}", { headers: { "Content-Type": "application/json" } });
	}

	if (method === "POST" && !path[1]) {
		try {
			const bodyText = await request.text();
			await env.DASH_KV.put(CONFIG_KEY, bodyText);

			// به‌روزرسانی آلارم‌های DO
			try {
				const configData = JSON.parse(bodyText);
				const automations = configData.automations ?? configData.payload?.automations ?? [];
				const stub = env.MY_DURABLE_OBJECT.get(
					env.MY_DURABLE_OBJECT.idFromName("automations_controller")
				);
				await (stub as any).updateAutomations(automations);
			} catch (err) {
				console.error("Failed to update DO alarms", err);
			}

			return jsonResponse({ ack: true, message: "تنظیمات با موفقیت در سرور ذخیره شد." });
		} catch {
			return jsonResponse({ ack: false, error: "خطا در ذخیره تنظیمات در KV." }, 500);
		}
	}

	return new Response("Method Not Allowed", { status: 405 });
}
