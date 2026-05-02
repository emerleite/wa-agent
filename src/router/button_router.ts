/**
 * Match interactive button_reply / template button payloads to handlers by
 * **prefix** (longest match wins) or by exact id.
 */
export interface ButtonHandlerArgs<Ctx> {
	ctx: Ctx;
	buttonId: string;
	suffix: string;
}

export type ButtonHandler<Ctx = unknown> = (args: Ctx & { buttonId: string; suffix: string }) => void | Promise<void>;

interface PrefixEntry<Ctx> {
	prefix: string;
	handler: ButtonHandler<Ctx>;
}

export class ButtonRouter<Ctx = unknown> {
	private exactHandlers = new Map<string, ButtonHandler<Ctx>>();
	private prefixHandlers: PrefixEntry<Ctx>[] = [];
	private _fallback: ButtonHandler<Ctx> | null = null;

	exact(id: string, handler: ButtonHandler<Ctx>): this {
		this.exactHandlers.set(id, handler);
		return this;
	}

	prefix(prefix: string, handler: ButtonHandler<Ctx>): this {
		this.prefixHandlers.push({ prefix, handler });
		this.prefixHandlers.sort((a, b) => b.prefix.length - a.prefix.length);
		return this;
	}

	fallback(handler: ButtonHandler<Ctx>): this {
		this._fallback = handler;
		return this;
	}

	async dispatch(buttonId: string | undefined | null, ctx: Ctx): Promise<boolean> {
		if (!buttonId) return false;

		const exact = this.exactHandlers.get(buttonId);
		if (exact) {
			await exact({ ...(ctx as object), buttonId, suffix: '' } as Ctx & { buttonId: string; suffix: string });
			return true;
		}

		for (const { prefix, handler } of this.prefixHandlers) {
			if (buttonId.startsWith(prefix)) {
				await handler({ ...(ctx as object), buttonId, suffix: buttonId.slice(prefix.length) } as Ctx & { buttonId: string; suffix: string });
				return true;
			}
		}

		if (this._fallback) {
			await this._fallback({ ...(ctx as object), buttonId, suffix: '' } as Ctx & { buttonId: string; suffix: string });
			return true;
		}
		return false;
	}
}
