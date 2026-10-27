-- The approved scope purge already has UPDATE(details). Its WHERE and right-hand
-- expressions also require SELECT on these two columns. Audit RLS stays in force;
-- no audit DELETE, tenant-bypass policy, membership or runtime grant is added.
GRANT SELECT(workspace_id,details) ON faultline.audit TO faultline_authority;
