-- Per-OAuth-client access policy for inbound MCP connections (self-host fork).
--
-- One account, many connected agents. Each OAuth client id (one per agent
-- install / Hermes profile) may be narrowed independently on three gates:
--
--   package_mode     'all' | 'allowlist' -> allowed_package_ids_json
--                    Saved packages (by id) ad hoc execute may import/invoke,
--                    and whose retrievers/search rows the connection sees.
--   domain_mode      'all' | 'allowlist' -> allowed_domains_json
--                    Builtin capability domains and mcp:* remote server
--                    domains. meta + coding always stay available.
--   credential_mode  'all' | 'allowlist' -> allowed_secret_names_json,
--                    allowed_integrations_json, allowed_secret_providers_json
--                    User-scoped secrets, integrations, and secret providers
--                    any code in the run may resolve (including nested
--                    package runs).
--
-- No row means the client keeps the full assistant grant, so existing
-- connections are unchanged until the owner opts a client in from
-- /account/connections.

CREATE TABLE mcp_client_access_policies (
	user_id TEXT NOT NULL,
	client_id TEXT NOT NULL,
	package_mode TEXT NOT NULL DEFAULT 'all'
		CHECK (package_mode IN ('all', 'allowlist')),
	allowed_package_ids_json TEXT NOT NULL DEFAULT '[]',
	domain_mode TEXT NOT NULL DEFAULT 'all'
		CHECK (domain_mode IN ('all', 'allowlist')),
	allowed_domains_json TEXT NOT NULL DEFAULT '[]',
	credential_mode TEXT NOT NULL DEFAULT 'all'
		CHECK (credential_mode IN ('all', 'allowlist')),
	allowed_secret_names_json TEXT NOT NULL DEFAULT '[]',
	allowed_integrations_json TEXT NOT NULL DEFAULT '[]',
	allowed_secret_providers_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, client_id)
);
