/**
 * @file durable-object/alarm-manager.ts
 * منطق زمانبندی و اجرای اتوماسیون‌ها از طریق DO Alarms
 */

import { getNextTriggerTimestamp } from "../utils/scheduler";
import type { Automation } from "../types";

/**
 * محاسبه و ثبت آلارم بعدی بر اساس لیست اتوماسیون‌های فعال
 */
export async function scheduleNextAlarm(storage: DurableObjectStorage): Promise<void> {
	const automations = (await storage.get<Automation[]>("automations")) ?? [];
	const activeAutomations = automations.filter((a) => a.enabled);

	if (activeAutomations.length === 0) {
		await storage.deleteAlarm();
		return;
	}

	const now = new Date();
	let nextTime = Infinity;

	for (const auto of activeAutomations) {
		const triggerTime = getNextTriggerTimestamp(auto.time, auto.days, now);
		if (triggerTime !== null && triggerTime < nextTime) {
			nextTime = triggerTime;
		}
	}

	if (nextTime === Infinity) {
		await storage.deleteAlarm();
		return;
	}

	const nextAlarmIds = activeAutomations
		.filter((auto) => getNextTriggerTimestamp(auto.time, auto.days, now) === nextTime)
		.map((auto) => auto.id);

	await storage.put("nextAlarmTime", nextTime);
	await storage.put("nextAlarmIds", nextAlarmIds);
	await storage.setAlarm(nextTime);
}

/**
 * اجرای اتوماسیون‌هایی که الان باید فعال شوند و ارسال payload به ESP از طریق WebSocket
 */
export async function fireAlarm(
	storage: DurableObjectStorage,
	getWebSockets: () => WebSocket[]
): Promise<void> {
	const automations = (await storage.get<Automation[]>("automations")) ?? [];
	const nextAlarmIds = (await storage.get<string[]>("nextAlarmIds")) ?? [];

	const fired = automations.filter((a) => nextAlarmIds.includes(a.id));

	for (const auto of fired) {
		const targetPin = parseInt(auto.targetPin, 10);
		if (isNaN(targetPin)) continue;

		const payload = new Uint8Array([0x06, targetPin, auto.actionOn ? 1 : 0]);
		for (const ws of getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// اتصال قطع شده — نادیده گرفته می‌شود
			}
		}
	}

	// آلارم بعدی را برنامه‌ریزی کن
	await scheduleNextAlarm(storage);
}
