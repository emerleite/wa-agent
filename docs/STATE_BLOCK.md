# State block — the form-fill agent pattern

`formatStateBlock({ label, fields, ... })` renders a compact "current draft" block for injection into an LLM system prompt every turn. It's a small helper (~30 lines) but it's load-bearing for one specific agent shape: **form-fill agents** — bots that collect a structured payload across many turns before a final tool call commits it.

Introduced in v0.13. Genericized from a domain-specific block in a real-estate lead bot; the framework version is domain-neutral.

## The problem it solves

Form-fill agents live in an awkward spot:

- **Multiple turns** — a booking, a lead capture, an order intake needs several fields the user gives across the conversation.
- **The model has to remember them** — every turn's system prompt must "know" what has already been collected.
- **Conversation history alone doesn't work reliably** — the model will re-ask fields it just captured ("I said 4 people" → "how many people?"), because the answer is buried in scroll and the tool-call didn't rewrite the ambient state.

The fix is boring but reliable: on every turn, inject a *state block* at the top of the system prompt that lists exactly which fields have been filled. Tell the model to trust it over the transcript.

## Minimal example

```ts
import { formatStateBlock } from '@emerleite/wa-agent';

const draft = {
  day: '2026-08-01',
  time: null,           // not yet given
  partySize: 4,
  notes: '',            // not yet given
};

const block = formatStateBlock({
  label: 'BOOKING IN PROGRESS',
  fields: draft,
  labels: {
    day: 'Day',
    time: 'Time',
    partySize: 'Party size',
    notes: 'Notes',
  },
  instructions: 'Do not re-ask any field already listed below.',
});

console.log(block);
// [BOOKING IN PROGRESS — Do not re-ask any field already listed below.]
// - Day: 2026-08-01
// - Party size: 4
```

The `time` and `notes` fields (null / empty) are skipped automatically. Once every field is filled, the block still renders — the model uses it as its final confirmation summary before dispatching the commit tool.

## Wiring into `AgentLoop`

The state block goes at the top of the system prompt, above your standard scope + rules:

```ts
import { AgentLoop, formatStateBlock } from '@emerleite/wa-agent';

const BASE_PROMPT = `You are BookBot, a reservation assistant.

SCOPE (strict): you may only help with booking, listing, and cancelling
appointments. Never engage with general questions.

When booking, ALWAYS confirm day + time + party size before calling
commit_booking. If a field is already listed in the state block below,
DO NOT re-ask it — trust the block.

Be concise.`;

agent.onText(async ({ text, user, reply }) => {
  const draft = await draftStore.load(user.whatsapp);   // your persistence

  const state = formatStateBlock({
    label: 'BOOKING IN PROGRESS',
    fields: draft.fields,
    labels: FIELD_LABELS,
    instructions: 'This block is the source of truth. Trust it over transcript.',
  });

  const systemPrompt = state ? `${state}\n\n${BASE_PROMPT}` : BASE_PROMPT;

  const result = await loop.run({
    whatsapp: user.whatsapp,
    userText: text,
    systemPrompt,
    context: { env, whatsapp: user.whatsapp, draftId: draft.id },
  });

  await reply.text(result.text || '(no reply)');
});
```

Notes:

- **`state` may be empty.** `formatStateBlock` returns `""` when no field renders (first turn, everything null). The `state ? ... : BASE_PROMPT` guard avoids an empty header block muddling the prompt.
- **Load draft state before the loop.** The draft lives in your D1 (your table, not the framework's — the shape is app-specific). `AgentLoop` sees a static string.
- **Update the draft state inside tools.** Your `set_day` / `set_time` / `set_party` tools write to the draft table and return an acknowledgement. The next turn's block reflects the change automatically because it's rebuilt from D1.

## Recommended tool shape for form fills

Split the commit into small "set one field" tools + one "commit" tool:

```ts
const setDay = {
  name: 'set_day',
  description: 'Set the booking day. Value must be ISO YYYY-MM-DD.',
  inputSchema: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  execute: async ({ day }, ctx) => {
    await ctx.env.DB.prepare('UPDATE drafts SET day=? WHERE id=?').bind(day, ctx.draftId).run();
    return `Day set to ${day}.`;
  },
};

// … set_time, set_party, set_notes …

const commitBooking = {
  name: 'commit_booking',
  description: 'Finalize the booking. Only call after ALL required fields are set.',
  inputSchema: z.object({}),
  execute: async (_input, ctx) => {
    const draft = await loadDraft(ctx.env.DB, ctx.draftId);
    const missing = requiredFieldsMissing(draft);
    if (missing.length) return `Cannot commit — still missing: ${missing.join(', ')}. Ask the user for them.`;
    await commitBookingToRealTable(ctx.env.DB, draft);
    return `Booking committed. Confirmation id: ${draft.id}.`;
  },
};
```

Notice how the commit tool returns an error string — not throws — if fields are missing. That's `docs/AGENT_TOOL_VALIDATION.md`'s "return semantic failures as steering signals" pattern applied to a form-fill flow.

## Customization

### Custom labels

```ts
formatStateBlock({
  label: 'ORDER',
  fields: { sku: 'X-4210', qty: 3, ship: null },
  labels: { sku: 'SKU', qty: 'Quantity', ship: 'Ship to' },
});
```

### Custom `formatValue`

By default, booleans render as `yes` / `no`, arrays as comma-joined, everything else as `String(v)`. Override when your domain needs it:

```ts
formatStateBlock({
  label: 'CART',
  fields: { subtotal: 199.9, discount: 0.15 },
  formatValue: (v, key) => {
    if (key === 'subtotal') return `$${Number(v).toFixed(2)}`;
    if (key === 'discount') return `${Math.round(Number(v) * 100)}%`;
    return String(v);
  },
});
// [CART]
// - subtotal: $199.90
// - discount: 15%
```

### Custom `skip`

Default skips `null | undefined | '' | []`. Override to hide fields that are set to a sentinel:

```ts
formatStateBlock({
  label: 'CONFIG',
  fields: { region: 'BR-SP', tier: 'default' },
  skip: (v) => v === 'default',   // hide fields still at default
});
```

### Multiple blocks

`formatStateBlock` returns a plain string. Compose several:

```ts
const systemPrompt = [
  formatStateBlock({ label: 'CUSTOMER', fields: customerFields }),
  formatStateBlock({ label: 'CART', fields: cartFields }),
  BASE_PROMPT,
].filter(Boolean).join('\n\n');
```

Empty strings are filtered so a partially-filled state doesn't leave a bare header.

## Anti-patterns

- **Rendering fields the model shouldn't see.** The state block is user-facing via the model — don't include internal ids, database keys, or PII you wouldn't want leaked in a response.
- **Using it as the ONLY memory.** `formatStateBlock` snapshots a *decision-relevant slice*. `ConversationMemory` still owns the running transcript. Both play different roles; keep both.
- **Skipping empty-string values with a custom skip that lets `""` render.** An empty label like `- Notes:` invites the model to guess or hallucinate content. Default skip is empty-string-aware for a reason.
- **Injecting the block only when convenient.** If the block appears sometimes and not others, the model learns to distrust it. Either always inject (empty is fine — returns `""` which composes to nothing) or never.
- **Editing the block inline in every tool.** The block is derived; tools should update the underlying D1 row, and the block re-renders next turn. Editing the string in the running system prompt is a code smell.

## Complementary reading

- `docs/AGENT_LOOP.md` — the loop this pattern targets
- `docs/AGENT_TOOL_VALIDATION.md` — how to write the small "set one field" tools + the commit tool
- `docs/SCOPED_AGENT_PROMPT.md` — the scope-restriction template you sandwich around the state block
