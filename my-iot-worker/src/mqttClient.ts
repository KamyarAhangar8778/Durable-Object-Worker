export async function publishMqtt(topic: string, payload: Uint8Array): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const ws = new WebSocket('wss://broker.emqx.io:8084/mqtt', 'mqtt');
			
			const timeout = setTimeout(() => {
				ws.close();
				resolve(false);
			}, 5000);

			ws.addEventListener('open', () => {
				// Send CONNECT
				const clientId = "achaemenid_cf_" + Math.random().toString(16).substring(2, 10);
				const clientIdBytes = new TextEncoder().encode(clientId);
				const remainingLen = 10 + 2 + clientIdBytes.length;
				
				const connectPacket = new Uint8Array(2 + remainingLen);
				connectPacket[0] = 0x10;
				connectPacket[1] = remainingLen;
				// Variable header (MQTT 3.1.1)
				connectPacket.set([0x00, 0x04, 77, 81, 84, 84, 0x04, 0x02, 0x00, 0x3C], 2);
				// Payload
				connectPacket[12] = clientIdBytes.length >> 8;
				connectPacket[13] = clientIdBytes.length & 0xFF;
				connectPacket.set(clientIdBytes, 14);
				
				ws.send(connectPacket);
			});

			ws.addEventListener('message', (event) => {
				const data = new Uint8Array(event.data as ArrayBuffer);
				if (data[0] === 0x20) { // CONNACK
					if (data[3] === 0x00) { // Connection accepted
						// Send PUBLISH
						const topicBytes = new TextEncoder().encode(topic);
						const pubRemainingLen = 2 + topicBytes.length + payload.length;
						
						const buf: number[] = [];
						buf.push(0x30); // PUBLISH QoS 0
						// Encode Remaining Length
						let len = pubRemainingLen;
						do {
							let encodedByte = len % 128;
							len = Math.floor(len / 128);
							if (len > 0) {
								encodedByte = encodedByte | 128;
							}
							buf.push(encodedByte);
						} while (len > 0);
						
						const pubPacket = new Uint8Array(buf.length + pubRemainingLen);
						pubPacket.set(buf, 0);
						let offset = buf.length;
						
						// Topic length
						pubPacket[offset++] = topicBytes.length >> 8;
						pubPacket[offset++] = topicBytes.length & 0xFF;
						pubPacket.set(topicBytes, offset);
						offset += topicBytes.length;
						
						// Payload
						pubPacket.set(payload, offset);
						
						ws.send(pubPacket);
						
						// Send DISCONNECT
						ws.send(new Uint8Array([0xE0, 0x00]));
						ws.close();
						
						clearTimeout(timeout);
						resolve(true);
					} else {
						clearTimeout(timeout);
						ws.close();
						resolve(false);
					}
				}
			});

			ws.addEventListener('error', () => {
				clearTimeout(timeout);
				resolve(false);
			});

		} catch (e) {
			resolve(false);
		}
	});
}
