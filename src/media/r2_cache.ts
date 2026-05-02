/**
 * R2-backed cache for generated media (TTS audio, OG images, charts).
 */
export interface R2CacheOptions {
	bucket: R2Bucket;
	publicHost: string;
}

export interface ProducerResult {
	body: ArrayBuffer | ReadableStream | Blob | string;
	contentType: string;
}

export class R2Cache {
	readonly bucket: R2Bucket;
	readonly publicHost: string;

	constructor({ bucket, publicHost }: R2CacheOptions) {
		if (!bucket) throw new Error('R2Cache: bucket required');
		if (!publicHost) throw new Error('R2Cache: publicHost required');
		this.bucket = bucket;
		this.publicHost = publicHost.replace(/\/$/, '');
	}

	async getOrCreate(key: string, producer: () => Promise<ProducerResult>): Promise<{ url: string; fromCache: boolean }> {
		const head = await this.bucket.head(key);
		if (head) {
			return { url: this.urlFor(key), fromCache: true };
		}
		const { body, contentType } = await producer();
		await this.bucket.put(key, body, { httpMetadata: { contentType } });
		return { url: this.urlFor(key), fromCache: false };
	}

	urlFor(key: string): string {
		return `${this.publicHost}/${key}`;
	}
}
