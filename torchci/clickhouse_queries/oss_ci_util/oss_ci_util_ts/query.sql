--- This query is used by utilization dashboard
SELECT
    time_stamp AS ts,
    tags,
    json_data AS data
FROM
    misc.oss_ci_time_series
WHERE
    workflow_id = {workflowId: UInt64}
    AND run_attempt = {runAttempt: UInt32}
    AND job_id = {jobId: UInt64}
    AND repo = {repo: String }
    AND type = {type: String}
ORDER BY
    ts
