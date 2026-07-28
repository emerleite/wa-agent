/**
 * Download Meta media → put in a `MediaStorage` in one call.
 *
 * Meta serves inbound media through a two-hop dance: fetch the metadata
 * (auth'd) to get a short-lived signed URL, then fetch the URL (also auth'd)
 * to get the bytes. Consumers keep hand-rolling this loop; here it is once
 * with a `MediaStorage` interface so R2, KV, S3 adapters all fit.
 *
 *   const store = new R2MediaStore({ bucket: env.MEDIA_BUCKET, publicHost: 'https://cdn.example.com' });
 *   const { key, url } = await ingestMedia({
 *     client: agent.whatsapp,
 *     mediaId: inbound.imageId!,
 *     store,
 *     scope: user.whatsapp,
 *     id: inbound.wamid,
 *   });
 *
 * `R2MediaStore` (v0.12) implements `MediaStorage` natively — no adapter
 * needed. Consumers wanting KV / S3 / custom storage implement the same
 * `upload({scope, id, body, contentType})` shape.
 */
import type { WhatsAppClient } from '../client/whatsapp.js';

/**
 * The upload interface `ingestMedia` needs. `R2MediaStore` (v0.12) already
 * matches this shape; roll your own for KV, S3, or a Worker-served route.
 */
export interface MediaStorage {
	upload(args: {
		scope: string;
		id: string;
		body: ArrayBuffer | Uint8Array | Blob | ReadableStream;
		contentType?: string;
		metadata?: Record<string, string>;
	}): Promise<{ key: string; url: string }>;
}

export interface IngestMediaArgs {
	client: Pick<WhatsAppClient, 'downloadMediaWithMeta'>;
	mediaId: string;
	store: MediaStorage;
	scope: string;
	id: string;
	/** Fallback when Meta doesn't return `mime_type`. Default `'application/octet-stream'`. */
	defaultContentType?: string;
	/** Optional metadata forwarded to `store.upload`. */
	metadata?: Record<string, string>;
}

export interface IngestMediaResult {
	key: string;
	url: string;
	mimeType?: string;
	sha256?: string;
	fileSize?: number;
}

/**
 * Download the media referenced by `mediaId` from Meta and hand the bytes
 * to `store`. Throws on download failure — callers that want soft-fail
 * behavior wrap in try/catch.
 */
export async function ingestMedia({
	client,
	mediaId,
	store,
	scope,
	id,
	defaultContentType = 'application/octet-stream',
	metadata,
}: IngestMediaArgs): Promise<IngestMediaResult> {
	const dl = await client.downloadMediaWithMeta(mediaId);
	if (!dl) throw new Error(`ingestMedia: Meta returned no bytes for mediaId=${mediaId}`);
	const uploaded = await store.upload({
		scope,
		id,
		body: dl.stream,
		contentType: dl.mimeType ?? defaultContentType,
		metadata,
	});
	return {
		key: uploaded.key,
		url: uploaded.url,
		mimeType: dl.mimeType,
		sha256: dl.sha256,
		fileSize: dl.fileSize,
	};
}
