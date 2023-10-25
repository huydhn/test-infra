import dayjs from "dayjs";
import _ from "lodash";
import { Octokit } from "octokit";
import { IssueData } from "./types";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import { isDrCIEnabled, isPyTorchPyTorch } from "./bot/utils";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { Credentials } from "@aws-sdk/types";
import { Client } from "@opensearch-project/opensearch";
import {
  searchSimilarFailures,
  WORKFLOW_JOB_INDEX,
  MIN_SCORE,
  MAX_SIZE,
} from "lib/searchUtils";
import { RecentWorkflowsData, JobData } from "lib/types";
import { isSameHeadBranch, isSameFailure } from "lib/jobUtils";

export const NUM_MINUTES = 30;
export const REPO: string = "pytorch";
export const OWNER: string = "pytorch";
export const DRCI_COMMENT_START = "<!-- drci-comment-start -->\n";
export const OH_URL =
  "https://github.com/pytorch/pytorch/wiki/Dev-Infra-Office-Hours";
export const DOCS_URL = "https://docs-preview.pytorch.org";
export const PYTHON_DOCS_PATH = "index.html";
export const CPP_DOCS_PATH = "cppdocs/index.html";
export const DRCI_COMMENT_END = `\n
This comment was automatically generated by Dr. CI and updates every 15 minutes.
<!-- drci-comment-end -->`;
export const HUD_URL = "https://hud.pytorch.org/pr/";
export const BOT_COMMANDS_WIKI_URL =
  "https://github.com/pytorch/pytorch/wiki/Bot-commands";
export const FLAKY_RULES_JSON =
  "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/flaky-rules.json";
export const EXCLUDED_FROM_FLAKINESS = ["lint", "linux-docs"];

export function formDrciHeader(
  owner: string,
  repo: string,
  prNum: number
): string {
  // For PyTorch only
  if (isPyTorchPyTorch(owner, repo)) {
    return `## :link: Helpful Links
### :test_tube: See artifacts and rendered test results at [hud.pytorch.org/pr/${prNum}](${HUD_URL}${prNum})
* :page_facing_up: Preview [Python docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${PYTHON_DOCS_PATH})
* :page_facing_up: Preview [C++ docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${CPP_DOCS_PATH})
* :question: Need help or want to give feedback on the CI? Visit the [bot commands wiki](${BOT_COMMANDS_WIKI_URL}) or our [office hours](${OH_URL})

Note: Links to docs will display an error until the docs builds have been completed.`;
  }

  // For domain libraries
  return `## :link: Helpful Links
### :test_tube: See artifacts and rendered test results at [hud.pytorch.org/pr/${owner}/${repo}/${prNum}](${HUD_URL}${owner}/${repo}/${prNum})
* :page_facing_up: Preview [Python docs built from this PR](${DOCS_URL}/${owner}/${repo}/${prNum}/${PYTHON_DOCS_PATH})

Note: Links to docs will display an error until the docs builds have been completed.`;
}

export function formDrciComment(
  pr_num: number,
  owner: string = OWNER,
  repo: string = REPO,
  pr_results: string = "",
  sevs: string = ""
): string {
  const header = formDrciHeader(owner, repo, pr_num);
  const comment = `${DRCI_COMMENT_START}
${header}
${sevs}
${pr_results}
${DRCI_COMMENT_END}`;
  return comment;
}

export async function getDrciComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNum: number
): Promise<{ id: number; body: string }> {
  const commentsRes = await octokit.rest.issues.listComments({
    owner: owner,
    repo: repo,
    issue_number: prNum,
  });
  for (const comment of commentsRes.data) {
    if (comment.body!.includes(DRCI_COMMENT_START)) {
      return { id: comment.id, body: comment.body! };
    }
  }
  return { id: 0, body: "" };
}

export function getActiveSEVs(issues: IssueData[]): [IssueData[], IssueData[]] {
  const activeSEVs = issues.filter(
    (issue: IssueData) => issue.state === "open"
  );
  return _.partition(activeSEVs, (issue: IssueData) =>
    issue.body.toLowerCase().includes("merge blocking")
  );
}

export function formDrciSevBody(sevs: [IssueData[], IssueData[]]): string {
  const [mergeBlocking, notMergeBlocking] = sevs;
  if (mergeBlocking.length + notMergeBlocking.length === 0) {
    return "";
  }
  const sev_list = mergeBlocking
    .concat(notMergeBlocking)
    .map(
      (issue: IssueData) =>
        `* ${
          issue.body.toLowerCase().includes("merge blocking")
            ? "(merge blocking) "
            : ""
        }[${issue.title}](${issue.html_url.replace(
          "github.com",
          "hud.pytorch.org"
        )})`
    )
    .join("\n");
  if (mergeBlocking.length > 0) {
    return (
      `## :heavy_exclamation_mark: ${mergeBlocking.length} Merge Blocking SEVs
There is ${mergeBlocking.length} active merge blocking SEVs` +
      (notMergeBlocking.length > 0
        ? ` and ${notMergeBlocking.length} non merge blocking SEVs`
        : "") +
      `.  Please view them below:
${sev_list}\n
If you must merge, use \`@pytorchbot merge -f\`.`
    );
  } else {
    return `## :heavy_exclamation_mark: ${notMergeBlocking.length} Active SEVs
There are ${notMergeBlocking.length} currently active SEVs.   If your PR is affected, please view them below:
${sev_list}\n
`;
  }
}

// The context here is the context from probot.
// Today we only use probot for upserts, but this could later be split into logger
export async function upsertDrCiComment(
  owner: string,
  repo: string,
  prNum: number,
  context: any,
  prUrl: string
) {
  // Dr.CI only supports [pytorch/pytorch, pytorch/vision] at the moment
  if (!isDrCIEnabled(owner, repo)) {
    context.log(
      `Pull request to ${owner}/${repo} is not supported by Dr.CI bot, no comment is made`
    );
    return;
  }

  const existingDrciData = await getDrciComment(
    context.octokit,
    owner,
    repo,
    prNum
  );
  context.log(
    "Got existing ID: " +
      existingDrciData.id +
      " with body " +
      existingDrciData.body
  );
  const existingDrciID = existingDrciData.id;
  const existingDrciComment = existingDrciData.body;
  const sev = getActiveSEVs(await fetchIssuesByLabel("ci: sev"));
  const drciComment = formDrciComment(
    prNum,
    owner,
    repo,
    "",
    formDrciSevBody(sev)
  );

  if (existingDrciComment === drciComment) {
    return;
  }

  if (existingDrciID === 0) {
    await context.octokit.issues.createComment({
      body: drciComment,
      owner: owner,
      repo: repo,
      issue_number: prNum,
    });
    context.log(`Commenting with "${drciComment}" for pull request ${prUrl}`);
  } else {
    context.log({
      body: drciComment,
      owner: owner,
      repo: repo,
      comment_id: existingDrciID,
    });
    await context.octokit.issues.updateComment({
      body: drciComment,
      owner: owner,
      repo: repo,
      comment_id: existingDrciID,
    });
    context.log(
      `Updated comment with "${drciComment}" for pull request ${prUrl}`
    );
  }
}

export async function querySimilarFailures(
  job: RecentWorkflowsData,
  baseCommitDate: string,
  lookbackPeriodInHours: number = 24,
  maxSize: number = MAX_SIZE,
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

  // Get the workflow name if possible
  const jobNameIndex = job.name.indexOf(` / ${job.jobName}`);
  const workflowName =
    jobNameIndex !== -1 ? job.name.substring(0, jobNameIndex) : "";

  const results = await searchSimilarFailures(
    client,
    failure,
    workflowName,
    "",
    WORKFLOW_JOB_INDEX,
    startDate.toISOString(),
    endDate.toISOString(),
    MIN_SCORE,
    maxSize
  );

  return "jobs" in results ? results["jobs"] : [];
}

export async function hasSimilarFailures(
  job: RecentWorkflowsData,
  baseCommitDate: string,
  lookbackPeriodInHours: number = 24,
  client?: Client
): Promise<boolean> {
  if (isExcludedFromFlakiness(job)) {
    return false;
  }

  const records = await querySimilarFailures(
    job,
    baseCommitDate,
    lookbackPeriodInHours,
    MAX_SIZE,
    client
  );
  if (records.length === 0) {
    return false;
  }

  for (const record of records) {
    // Convert the result in JobData to RecentWorkflowsData used by Dr.CI
    const failure: RecentWorkflowsData = {
      workflowId: record.workflowId,
      id: record.id as string,
      jobName: record.jobName as string,
      name: record.name as string,
      conclusion: record.conclusion as string,
      completed_at: record.time as string,
      html_url: record.htmlUrl as string,
      head_sha: record.sha as string,
      head_branch: record.branch as string,
      failure_captures: record.failureCaptures as string[],
      failure_lines: record.failureLines,
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

export function isInfraFlakyJob(job: RecentWorkflowsData): boolean {
  // An infra flaky job is a failed job without any failure line and runner. It shows
  // up as an empty job without any logs on GitHub. The failure can only be seen via
  // the workflow summary tab
  return (
    job.conclusion === "failure" &&
    (job.failure_lines === null ||
      job.failure_lines === undefined ||
      job.failure_lines.join("") === "") &&
    (job.runnerName === null ||
      job.runnerName === undefined ||
      job.runnerName === "")
  );
}

export function isExcludedFromFlakiness(job: RecentWorkflowsData): boolean {
  // Lintrunner job are generally stable and should be excluded from flakiness
  // detection
  return (
    _.find(
      EXCLUDED_FROM_FLAKINESS,
      (exclude: string) =>
        job.name !== undefined && job.name.toLowerCase().includes(exclude)
    ) !== undefined
  );
}
