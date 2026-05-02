/**
 * Match inbound *text* messages to keyword commands (case-insensitive).
 */
export type CommandHandler<Ctx = unknown> = (ctx: Ctx) => void | Promise<void>;

interface Command<Ctx> {
	aliases: string[];
	handler: CommandHandler<Ctx>;
}

export class CommandRouter<Ctx = unknown> {
	private commands: Command<Ctx>[] = [];
	private _fallback: CommandHandler<Ctx> | null = null;

	command(aliases: string | string[], handler: CommandHandler<Ctx>): this {
		const list = Array.isArray(aliases) ? aliases : [aliases];
		this.commands.push({ aliases: list.map((a) => a.toLowerCase()), handler });
		return this;
	}

	fallback(handler: CommandHandler<Ctx>): this {
		this._fallback = handler;
		return this;
	}

	async dispatch(text: string | undefined | null, ctx: Ctx): Promise<boolean> {
		const norm = (text || '').trim().toLowerCase();
		for (const c of this.commands) {
			if (c.aliases.includes(norm)) {
				await c.handler(ctx);
				return true;
			}
		}
		if (this._fallback) {
			await this._fallback(ctx);
			return true;
		}
		return false;
	}
}
