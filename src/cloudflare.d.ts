// Minimal Cloudflare runtime types so the framework typechecks without a hard
// dependency on @cloudflare/workers-types being installed by the consumer.
//
// These are structural — anything matching the shape (including the real
// types from `@cloudflare/workers-types`) is assignable.

declare global {
	interface D1Database {
		prepare(query: string): D1PreparedStatement;
		batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
	}
	interface D1PreparedStatement {
		bind(...values: unknown[]): D1PreparedStatement;
		first<T = unknown>(colName?: string): Promise<T | null>;
		all<T = unknown>(): Promise<D1AllResult<T>>;
		run(): Promise<D1RunResult>;
	}
	interface D1Result<T> {
		results?: T[];
		success: boolean;
		meta: { changes: number };
	}
	interface D1AllResult<T> {
		results?: T[];
		success: boolean;
		meta: { changes: number };
	}
	interface D1RunResult {
		success: boolean;
		meta: { changes: number; last_row_id: number };
	}
	interface R2Bucket {
		head(key: string): Promise<R2HeadResult | null>;
		put(key: string, value: ArrayBuffer | ReadableStream | Blob | string, options?: R2PutOptions): Promise<R2Object | null>;
	}
	interface R2HeadResult {
		key: string;
		size: number;
	}
	interface R2Object {
		key: string;
	}
	interface R2PutOptions {
		httpMetadata?: { contentType?: string };
	}
	interface ExecutionContext {
		waitUntil(promise: Promise<unknown>): void;
		passThroughOnException(): void;
	}
	interface ScheduledEvent {
		cron: string;
		scheduledTime: number;
	}
}

export {};
