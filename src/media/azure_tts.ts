/**
 * Azure Speech Services Neural TTS driver.
 */
const DEFAULT_VOICE = 'en-US-AriaNeural';
const DEFAULT_RATE = '0%';
const DEFAULT_PITCH = '0%';

export interface AzureTTSOptions {
	key: string;
	region: string;
	voice?: string;
	rate?: string;
	pitch?: string;
	language?: string;
}

export class AzureTTS {
	private readonly key: string;
	private readonly region: string;
	private readonly voice: string;
	private readonly rate: string;
	private readonly pitch: string;
	private readonly language: string;

	constructor({ key, region, voice = DEFAULT_VOICE, rate = DEFAULT_RATE, pitch = DEFAULT_PITCH, language = 'en-US' }: AzureTTSOptions) {
		if (!key) throw new Error('AzureTTS: key required');
		if (!region) throw new Error('AzureTTS: region required');
		this.key = key;
		this.region = region;
		this.voice = voice;
		this.rate = rate;
		this.pitch = pitch;
		this.language = language;
	}

	async synthesize(text: string): Promise<ArrayBuffer> {
		const ssml = buildSSML(text, { voice: this.voice, rate: this.rate, pitch: this.pitch, language: this.language });
		const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Ocp-Apim-Subscription-Key': this.key,
				'Content-Type': 'application/ssml+xml',
				'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
				'User-Agent': 'wa-agent/1.0',
			},
			body: ssml,
		});
		if (!resp.ok) {
			throw new Error(`AzureTTS ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
		}
		return await resp.arrayBuffer();
	}
}

export interface SSMLOptions {
	voice: string;
	rate: string;
	pitch: string;
	language: string;
}

export function buildSSML(text: string, { voice, rate, pitch, language }: SSMLOptions): string {
	const escaped = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
	return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">
	<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}">${escaped}</prosody></voice>
</speak>`;
}
