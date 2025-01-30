-- This query is used to get the list of branches and commits used by different
-- OSS CI benchmark experiments. This powers HUD benchmarks dashboards
SELECT
    DISTINCT replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
    head_sha,
    workflow_id AS id,
    toStartOfDay(fromUnixTimestamp(timestamp)) AS event_time
FROM
    benchmark.oss_ci_benchmark_metadata
WHERE
    timestamp >= toUnixTimestamp({startTime: DateTime64(3) })
    AND timestamp < toUnixTimestamp({stopTime: DateTime64(3) })
    AND repo = {repo: String }
    AND (
        has({benchmarks: Array(String) }, benchmark_name)
        OR empty({benchmarks: Array(String) })
    )
    AND (
        has({models: Array(String) }, model_name)
        OR empty({models: Array(String) })
    )
    AND (
        has({backends: Array(String) }, model_backend)
        OR empty({backends: Array(String) })
    )
    AND (
        has({dtypes: Array(String) }, benchmark_dtype)
        OR empty({dtypes: Array(String) })
    )
    AND (
        NOT has({excludedMetrics: Array(String) }, metric_name)
        OR empty({excludedMetrics: Array(String) })
    )
    AND notEmpty(metric_name)
    AND (
        startsWith({device: String }, device)
        OR {device: String } = ''
    )
    AND notEmpty(device)
    AND (
        arch LIKE concat('%', {arch: String }, '%')
        OR {arch: String } = ''
    )
ORDER BY
    head_branch,
    timestamp DESC
