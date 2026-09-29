-- Bot RPC wrappers are SECURITY INVOKER with search_path = private.
-- service_role had EXECUTE on the impl, but no USAGE on the schema.

grant usage on schema private to service_role;
