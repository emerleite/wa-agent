/**
 * Store user-generated media (photos, audio, docs) in R2 with a predictable
 * key scheme and public URL.
 *
 * Distinct from `R2Cache` (which caches framework-generated TTS output keyed
 * by a hash): this class handles inbound media the bot receives from users or
 * external sources, keyed by (scope, id) so each conversation's uploads are
 * isolated and easy to enumerate.
 *
 *   store.upload({ scope: '5511999999999', id: 'wamid.abc', body, contentType })
 *     → { key: '5511999999999/wamid.abc', url: 'https://cdn.example.com/5511999999999/wamid.abc' }
 *
 * If `publicHost` is empty, `url` returns the key alone (consumers can compose
 * their own URL — e.g. a Worker route that streams the R2 object).
 */

export interface R2MediaStoreOptions {
	bucket: R2Bucket;
	/** Public host that serves `bucket` — e.g. `https://cdn.example.com`. Trailing slash optional. */
	publicHost?: string;
	/**
	 * Filename appended after `<scope>/<id>/`. Defaults to just `<scope>/<id>` (no filename segment).
	 * Set (e.g.) `'photo.jpg'` if you want a stable extension for CDN sniffing.
	 */
	fileSuffix?: string;
}

export interface UploadArgs {
	scope: string;
	id: string;
	body: ArrayBuffer | Uint8Array | Blob | ReadableStream;
	contentType?: string;
	metadata?: Record<string, string>;
}

export interface UploadResult {
	key: string;
	url: string;
}

export class R2MediaStore {
	private readonly bucket: R2Bucket;
	private readonly publicHost: string;
	private readonly fileSuffix: string;

	constructor(opts: R2MediaStoreOptions) {
		this.bucket = opts.bucket;
		this.publicHost = (opts.publicHost ?? '').replace(/\/$/, '');
		this.fileSuffix = opts.fileSuffix ?? '';
	}

	buildKey(scope: string, id: string): string {
		const base = `${sanitize(scope)}/${sanitize(id)}`;
		return this.fileSuffix ? `${base}/${this.fileSuffix}` : base;
	}

	buildUrl(key: string): string {
		return this.publicHost ? `${this.publicHost}/${key}` : key;
	}

	async upload({ scope, id, body, contentType, metadata }: UploadArgs): Promise<UploadResult> {
		const key = this.buildKey(scope, id);
		const httpMetadata: R2HTTPMetadata = {};
		if (contentType) httpMetadata.contentType = contentType;
		await this.bucket.put(key, body as ArrayBuffer, { httpMetadata, customMetadata: metadata });
		return { key, url: this.buildUrl(key) };
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}
}

function sanitize(s: string): string {
	// R2 keys tolerate `/`, but strip anything that would break URL composition or path traversal.
	return String(s).replace(/[^A-Za-z0-9._\-]/g, '_');
}
