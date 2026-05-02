/**
 * Audio transcription (Whisper or compatible).
 *
 * The `openai` SDK is a peer dep — we import `toFile` only when used.
 */
export interface TranscriberOptions {
	client: AudioClient;
	model?: string;
	filename?: string;
}

export interface AudioClient {
	audio: {
		transcriptions: {
			create(body: { file: unknown; model: string }): Promise<{ text?: string }>;
		};
	};
}

export class Transcriber {
	private readonly client: AudioClient;
	private readonly model: string;
	private readonly filename: string;

	constructor({ client, model = 'whisper-1', filename = 'audio.ogg' }: TranscriberOptions) {
		if (!client) throw new Error('Transcriber: client required');
		this.client = client;
		this.model = model;
		this.filename = filename;
	}

	async transcribe(audioStream: ReadableStream | null): Promise<string | null> {
		if (!audioStream) return null;
		try {
			const { toFile } = (await import('openai')) as unknown as {
				toFile: (stream: ReadableStream, name: string) => Promise<unknown>;
			};
			const r = await this.client.audio.transcriptions.create({
				file: await toFile(audioStream, this.filename),
				model: this.model,
			});
			return r.text || null;
		} catch (e) {
			console.error('[Transcriber]', e instanceof Error ? e.message : e);
			return null;
		}
	}
}
