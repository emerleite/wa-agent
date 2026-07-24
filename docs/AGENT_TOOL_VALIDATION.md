# Agent tool input validation

`ToolRegistry` validates every incoming tool call against its `inputSchema` (Zod) before dispatching to `execute`. This doc covers what happens on a bad input and — more importantly — the pattern to use inside your tools when *runtime* checks fail (schema-valid but semantically bad).

## What the framework does for you

```ts
const bookAppointment = {
	name: 'book_appointment',
	inputSchema: z.object({
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO YYYY-MM-DD'),
		time: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM in 24h'),
	}),
	execute: async ({ day, time }, ctx) => { /* … */ },
};
```

When the LLM calls `book_appointment` with `{ day: "next Monday" }`, `AgentLoop` never calls `execute`. Instead:

1. Zod fails validation.
2. `ToolRegistry.execute` returns the flattened Zod error as the tool-result **string** — not an exception. Example: `"day: must be ISO YYYY-MM-DD"`.
3. That string is appended to the conversation memory as the tool call's result.
4. The next LLM step sees the error and re-asks the user for the correct format.

The loop doesn't crash, the model self-corrects, and the whole thing is invisible to the end user.

## Runtime errors that are NOT schema failures

Sometimes the input is well-formed but the operation can't proceed — the slot is taken, the id doesn't exist, the referenced entity was already deleted. **Return an error string, don't throw.** Throwing terminates the AgentLoop with `finishReason: 'error'`; returning gives the model another chance.

```ts
execute: async ({ day, time }, { env, whatsapp }) => {
	const existing = await env.DB.prepare(
		'SELECT id FROM appointments WHERE whatsapp=? AND day=? AND time=?',
	).bind(whatsapp, day, time).first();
	if (existing) {
		// Semantic failure — tell the model, let it recover.
		return `Slot ${day} ${time} already booked for this user. Ask them to pick another time.`;
	}
	// … happy path
	return `Booked on ${day} at ${time}.`;
},
```

Rule of thumb:

| Situation | Do this |
|---|---|
| Bad input format (regex, enum, type) | Encode it in Zod → framework returns the error to the model. |
| Semantic failure (conflict, not found, permission denied) | Return a descriptive string from `execute`. |
| Infrastructure failure (D1 down, network broken) | Throw. The loop halts with `finishReason: 'error'` and the outer handler replies with a generic apology. |

## Never throw when you can steer

The single most impactful pattern for a well-behaved agent: **return actionable strings for anything the model can plausibly recover from**. The examples in `examples/tool-agent/` follow this: `cancel_appointment` returns `"No appointment <id> for this user. Call list_appointments to see valid ids."` instead of throwing.

## Complementary reading

- `docs/AGENT_LOOP.md` — full architecture, when to reach for AgentLoop vs. AIRouter, adapter authoring.
- `docs/SCOPED_AGENT_PROMPT.md` — how to keep the model in-scope (Meta AI policy).
