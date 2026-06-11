-- wa-agent: tenant-scoping for D1CoalesceQueue.
--
-- v0.6 ships MultiTenantAgentRegistry. The shared `message_queue` table is
-- still safe for multi-tenant use IF claimBatch() filters by tenant_id —
-- otherwise Agent A's drain can pick up Agent B's rows and dispatch them
-- through the wrong WhatsAppClient.
--
-- Single-tenant deployments leave `tenant_id` NULL; the IS NULL filter
-- preserves their behavior bit-for-bit. Multi-tenant deployments pass
-- `tenantId` to D1CoalesceQueue (the registry does this via Agent.queue);
-- claimBatch then scopes to that tenant only.

ALTER TABLE message_queue ADD COLUMN tenant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_message_queue_tenant
	ON message_queue (tenant_id, status, scheduled_at);
