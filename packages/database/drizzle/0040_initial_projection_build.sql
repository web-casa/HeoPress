-- HeoPress P06 (design R18, R44; Codex review of task 5.2): sites that existed before the public
-- projection — or whose projection was never built — get a rebuild mark, which the worker's
-- projection-rebuilds job processes within seconds. Until then the rendering service shows them
-- in maintenance (503). Rebuilding is idempotent: when row-level security hides the projection
-- from the migrating role, every site is marked and simply rebuilt once more.
INSERT INTO public.lumibase_projection_rebuilds (site_id, reason)
SELECT s.id, 'initial build'
FROM public.lumibase_sites s
WHERE NOT EXISTS (
  SELECT 1 FROM public.lumibase_public_sites p WHERE p.site_id = s.id AND p.built_at IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM public.lumibase_projection_rebuilds r WHERE r.site_id = s.id
);
