import dayjs from "dayjs";
import { JobData } from "lib/types";
import getRocksetClient from "./rockset";
import rocksetVersions from "rockset/prodVersions.json";
import { Client } from "@opensearch-project/opensearch";
import { RecentWorkflowsData } from "lib/types";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { Credentials } from "@aws-sdk/types";
import {
  searchSimilarFailures,
  WORKFLOW_JOB_INDEX,
  MIN_SCORE,
} from "lib/searchUtils";
import { isEqual } from "lodash";

export const REMOVE_JOB_NAME_SUFFIX_REGEX = new RegExp(
  ", [0-9]+, [0-9]+, .+\\)"
);
export const GHSTACK_SUFFIX_REGEX = new RegExp("/[0-9]+/head");

export function isFailedJob(job: JobData) {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out"
  );
}

export function isMatchingJobByName(job: JobData, name: string) {
  // Somehow, JobData has both name and jobName field.  They can be populated
  // by different rockset query, so we need to check both
  return (
    (job.name !== undefined && job.name.includes(name)) ||
    (job.jobName !== undefined && job.jobName.includes(name))
  );
}

export function isRerunDisabledTestsJob(job: JobData) {
  // Rerunning disabled tests are expected to fail from time to time depending
  // on the nature of the disabled tests, so we don't want to count them sometimes
  return isMatchingJobByName(job, "rerun_disabled_tests");
}

export function isUnstableJob(job: JobData) {
  return isMatchingJobByName(job, "unstable");
}

export async function getFlakyJobsFromPreviousWorkflow(
  owner: string,
  repo: string,
  branch: string,
  workflowName: string,
  workflowId: number
): Promise<any> {
  const rocksetClient = getRocksetClient();
  const query = await rocksetClient.queryLambdas.executeQueryLambda(
    "commons",
    "flaky_workflows_jobs",
    rocksetVersions.commons.flaky_workflows_jobs,
    {
      parameters: [
        {
          name: "repo",
          type: "string",
          value: `${owner}/${repo}`,
        },
        {
          name: "workflowNames",
          type: "string",
          value: workflowName,
        },
        {
          name: "nextWorkflowId",
          type: "int",
          value: `${workflowId}`, // Query the flaky status of jobs from the previous workflow
        },
        {
          name: "branches",
          type: "string",
          value: branch,
        },
        {
          name: "maxAttempt",
          type: "int",
          value: "1", // If the job was retried and still failed, it wasn't flaky
        },
      ],
    }
  );

  const flakyJobs = query.results;
  if (flakyJobs === undefined || flakyJobs.length === 0) {
    return [];
  }

  // The query returns all the flaky jobs from the previous workflow
  return flakyJobs;
}

export function removeJobNameSuffix(
  jobName: string,
  replaceWith: string = ")"
): string {
  if (!jobName) {
    return jobName;
  }

  return jobName.replace(REMOVE_JOB_NAME_SUFFIX_REGEX, replaceWith);
}

export function isSameHeadBranch(
  branchA: string | null | undefined,
  branchB: string | null | undefined
): boolean {
  if (!branchA || !branchB) {
    return false;
  }

  const replaceWith = "";
  // This function exists because we want to treat all ghstack head branches
  // as one branch when it comes to finding similar failures. A legit failure
  // coming from the same job but different commits in the stack shouldn't be
  // treated as a flaky similar failure
  const branchANoGhstack = branchA.replace(GHSTACK_SUFFIX_REGEX, replaceWith);
  const branchBNoGhstack = branchB.replace(GHSTACK_SUFFIX_REGEX, replaceWith);

  return branchANoGhstack === branchBNoGhstack;
}

export function isSameFailure(
  jobA: RecentWorkflowsData,
  jobB: RecentWorkflowsData
): boolean {
  if (
    jobA.name === undefined ||
    jobA.name === "" ||
    jobB.name === undefined ||
    jobB.name === ""
  ) {
    return false;
  }

  // Return true if two jobs have the same failures. This is used to figure out
  // broken trunk and other similar failures
  const jobANameNoSuffix = removeJobNameSuffix(jobA.name);
  const jobBNameNoSuffix = removeJobNameSuffix(jobB.name);

  if (jobANameNoSuffix !== jobBNameNoSuffix) {
    return false;
  }

  return (
    jobA.conclusion === jobB.conclusion &&
    isEqual(jobA.failure_captures, jobB.failure_captures)
  );
}

export async function querySimilarFailures(
  job: RecentWorkflowsData,
  baseCommitDate: string,
  lookbackPeriodInHours: number = 24,
  client?: Client
): Promise<JobData[]> {
  // This function queries HUD to find all similar failures during a period of time
  // before the current job. If a pre-existing job is found with exactly the same
  // failure and job name, the failure will be considered flaky. The end date is the
  // when the job finishes while the start date is either the time when the base commit
  // finishes minus a look-back period of 24 hours.
  if (
    job.name === undefined ||
    job.name === "" ||
    job.failure_captures === undefined ||
    job.failure_captures === null ||
    job.failure_captures.length === 0 ||
    job.completed_at === undefined ||
    job.completed_at === null ||
    job.completed_at === ""
  ) {
    return [];
  }

  if (client === undefined) {
    // https://opensearch.org/docs/latest/clients/javascript/index
    client = new Client({
      ...AwsSigv4Signer({
        region: process.env.OPENSEARCH_REGION as string,
        service: "es",
        getCredentials: () => {
          const credentials: Credentials = {
            accessKeyId: process.env.OUR_AWS_ACCESS_KEY_ID as string,
            secretAccessKey: process.env.OUR_AWS_SECRET_ACCESS_KEY as string,
          };
          return Promise.resolve(credentials);
        },
      }),
      node: process.env.OPENSEARCH_ENDPOINT,
    });
  }

  // Search for all captured failure
  const failure = job.failure_captures.join(" ");
  const endDate = dayjs(job.completed_at);
  const startDate = dayjs(
    baseCommitDate !== "" ? baseCommitDate : job.completed_at
  ).subtract(lookbackPeriodInHours, "hour");

  const results = await searchSimilarFailures(
    client,
    failure,
    WORKFLOW_JOB_INDEX,
    startDate.toISOString(),
    endDate.toISOString(),
    MIN_SCORE
  );

  return "jobs" in results ? results["jobs"] : [];
}

export async function hasSimilarFailures(
  job: RecentWorkflowsData,
  baseCommitDate: string,
  lookbackPeriodInHours: number = 24,
  client?: Client
): Promise<boolean> {
  const records = await querySimilarFailures(
    job,
    baseCommitDate,
    lookbackPeriodInHours,
    client
  );
  if (records.length === 0) {
    return false;
  }

  for (const record of records) {
    // Convert the result in JobData to RecentWorkflowsData used by Dr.CI
    const failure: RecentWorkflowsData = {
      workflow_id: record.workflowId,
      id: record.id as string,
      name: record.jobName as string,
      conclusion: record.conclusion as string,
      completed_at: record.time as string,
      html_url: record.htmlUrl as string,
      head_sha: record.sha as string,
      head_branch: record.branch as string,
      failure_captures: record.failureCaptures as string[],
      failure_line: record.failureLine,
    };

    // Only count different jobs with the same failure
    if (
      !isSameHeadBranch(job.head_branch, record.branch) &&
      job.id !== failure.id &&
      isSameFailure(job, failure)
    ) {
      return true;
    }
  }

  return false;
}
