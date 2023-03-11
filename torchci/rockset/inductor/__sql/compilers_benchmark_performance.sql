WITH performance_results AS (
  SELECT
    name,
    speedup,
    REPLACE(
      filename,
      CONCAT(
        '_', : dtypes, '_', : mode, '_', : device,
        '_performance'
      )
    ) AS filename,
    compilation_latency,
    compression_ratio,
    workflow_id,
  FROM
    inductor.torch_dynamo_perf_stats
  WHERE
    filename LIKE '%_performance'
    AND filename LIKE CONCAT(
      '%_', : dtypes, '_', : mode, '_', : device,
      '_%'
    )
    AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
),
accuracy_results AS (
  SELECT
    name,
    accuracy,
    REPLACE(
      filename,
      CONCAT(
        '_', : dtypes, '_', : mode, '_', : device,
        '_accuracy'
      )
    ) AS filename,
    workflow_id,
    FORMAT_ISO8601(
      DATE_TRUNC(: granularity, _event_time)
    ) AS granularity_bucket,
  FROM
    inductor.torch_dynamo_perf_stats
  WHERE
    filename LIKE '%_accuracy'
    AND filename LIKE CONCAT(
      '%_', : dtypes, '_', : mode, '_', : device,
      '_%'
    )
    AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
)
SELECT
  accuracy_results.workflow_id,
  granularity_bucket,
  CASE
    WHEN accuracy_results.filename LIKE '%_torchbench' THEN 'torchbench'
    WHEN accuracy_results.filename LIKE '%_timm_models' THEN 'timm_models'
    WHEN accuracy_results.filename LIKE '%_huggingface' THEN 'huggingface'
    ELSE NULL
  END AS suite,
  CASE
    WHEN accuracy_results.filename LIKE '%_torchbench' THEN REPLACE(
      accuracy_results.filename, '_torchbench'
    )
    WHEN accuracy_results.filename LIKE '%_timm_models' THEN REPLACE(
      accuracy_results.filename, '_timm_models'
    )
    WHEN accuracy_results.filename LIKE '%_huggingface' THEN REPLACE(
      accuracy_results.filename, '_huggingface'
    )
    ELSE NULL
  END AS compiler,
  accuracy_results.name,
  CAST(IF(
    speedup IS NULL, '0.0000',
    speedup
  ) AS FLOAT) AS speedup,
  accuracy,
  CAST(IF(
    compilation_latency IS NULL, '0.0000',
    compilation_latency
  ) AS FLOAT) AS compilation_latency,
  CAST(IF(
    compression_ratio IS NULL, '0.0000',
    compression_ratio
  ) AS FLOAT) AS compression_ratio,
FROM
  accuracy_results
  LEFT JOIN performance_results ON performance_results.name = accuracy_results.name
  AND performance_results.filename = accuracy_results.filename
  AND performance_results.workflow_id = accuracy_results.workflow_id
ORDER BY
  granularity_bucket DESC
