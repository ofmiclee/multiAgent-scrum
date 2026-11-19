// Shared by personal and project cards. Aliases a/d are Agent/Runner rows.
// Model selection and defaults are system-owned catalog data, never Runner input.
const modelReady=`(a.profile='demo' OR EXISTS(SELECT 1 FROM mas_business_model_catalog catalog
  WHERE catalog.profile=a.profile AND catalog.enabled AND (catalog.model=a.model OR (a.model IS NULL AND catalog.is_default))))`;
const runnerReady=`(d.session_until>clock_timestamp() AND a.ready_until>clock_timestamp()
  AND a.ready_session_hash=d.session_hash)`;
export const agentRuntimeProjection=`
  coalesce(a.model,(SELECT catalog.model FROM mas_business_model_catalog catalog
    WHERE catalog.profile=a.profile AND catalog.enabled AND catalog.is_default
    ORDER BY catalog.sort_order,catalog.model LIMIT 1)) AS "effectiveModel",
  (d.revoked_at IS NULL AND d.session_until>clock_timestamp()) IS TRUE AS "runnerConnected",
  (d.revoked_at IS NULL AND ${runnerReady}) IS TRUE AS "executorReady",
  (${modelReady}) IS TRUE AS "modelReady",
  (d.revoked_at IS NULL AND ${runnerReady} AND ${modelReady}) IS TRUE AS available,
  CASE
    WHEN d.revoked_at IS NOT NULL THEN 'runner_revoked'
    WHEN (d.session_until>clock_timestamp()) IS NOT TRUE THEN 'runner_offline'
    WHEN (a.ready_until>clock_timestamp() AND a.ready_session_hash=d.session_hash) IS NOT TRUE THEN 'executor_unavailable'
    WHEN ${modelReady} IS NOT TRUE THEN 'model_unavailable'
    ELSE 'ready'
  END AS "readiness"`;
