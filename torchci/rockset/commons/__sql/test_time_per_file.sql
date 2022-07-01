WITH most_recent_strict_commits AS (
    SELECT
        push.head_commit.id as sha,
    FROM
        commons.push
    WHERE
        push.ref = 'refs/heads/viable/strict'
        AND push.repository.full_name = 'pytorch/pytorch'
    ORDER BY
        push._event_time DESC
    LIMIT
        3
), workflows AS (
    SELECT
        id
    FROM
        commons.workflow_run w
        INNER JOIN most_recent_strict_commits c on w.head_sha = c.sha
),
job AS (
    SELECT
        REGEXP_EXTRACT(j.name, '^(.*) /', 1) as base_name,
        REGEXP_EXTRACT(j.name, '/ test \((\w*),', 1) as test_config,
        j.id
    FROM
        commons.workflow_job j
        INNER JOIN workflows w on w.id = j.run_id
    WHERE
        REGEXP_EXTRACT(j.name, '^(.*) /', 1) IS NOT NULL
        AND REGEXP_EXTRACT(j.name, '/ test \((\w*),', 1) IS NOT NULL
),
duration_per_job AS (
    SELECT
        test_run.invoking_file as file,
        job.base_name,
        job.test_config,
        SUM(time) as time
    FROM
        commons.test_run_s3 test_run
        /* `test_run` is ginormous and `job` is small, so lookup join is essential */
        INNER JOIN job ON test_run.job_id = job.id HINT(join_strategy = lookup)
    WHERE
        /* cpp tests do not populate `file` for some reason. */
        /* Exclude them as we don't include them in our slow test infra */
        test_run.file IS NOT NULL
        /* do some more filtering to cut down on the test_run size */
        AND test_run.skipped IS NULL
        AND test_run.failure IS NULL
        AND test_run.error IS NULL
    GROUP BY
        test_run.invoking_file,
        job.base_name,
        job.test_config
)
SELECT
    REPLACE(file, '.', '/') AS file,
    base_name,
    test_config,
    AVG(time) as time
FROM
    duration_per_job
GROUP BY
    file,
    base_name,
    test_config
ORDER BY
    base_name,
    test_config,
    file
