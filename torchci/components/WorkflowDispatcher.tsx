import { fetcher } from "lib/GeneralUtils";
import { CommitData, JobData } from "lib/types";
import _ from "lodash";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { CommitApiResponse } from "pages/api/[repoOwner]/[repoName]/commit/[sha]";
import { useState } from "react";
import useSWR from "swr";

const SUPPORTED_WORKFLOWS: { [k: string]: any } = {
  "pytorch/pytorch": {
    trunk: "Run trunk jobs",
    inductor: "Run inductor jobs",
    periodic: "Run periodic jobs",
    slow: "Run slow jobs",
    rocm: "Run rocm jobs",
    "linux-aarch64": "Run Linux ARMv8 jobs",
    "inductor-periodic": "Run periodic inductor jobs",
    "inductor-cu124": "Run inductor-cu124 jobs",
    xpu: "Run XPU jobs",
    h100: "Run H100 jobs",
  },
};

function hasWorkflow(jobs: JobData[], workflow: string) {
  return _.find(
    jobs,
    (job) => job.name !== undefined && getWorkflowName(job.name) === workflow
  );
}

function getWorkflowName(jobName: string) {
  return jobName.split(new RegExp(" / "))[0]?.toLowerCase()?.trim();
}

function Workflow({
  accessToken,
  repoOwner,
  repoName,
  workflow,
  sha,
  jobs,
}: {
  accessToken: string;
  repoOwner: string;
  repoName: string;
  workflow: string;
  sha: string;
  jobs: JobData[];
}) {
  const [alreadyRun, _setAlreadyRun] = useState(
    hasWorkflow(jobs, workflow) !== undefined
  );
  const [isClicked, setIsClicked] = useState(false);

  const repo = `${repoOwner}/${repoName}`;
  const supportedWorkflows = SUPPORTED_WORKFLOWS[repo];
  const [message, setMessage] = useState(supportedWorkflows[workflow]);

  const url = `/api/github/dispatch/${repoOwner}/${repoName}/${workflow}/${sha}`;
  // Only want to tag the commit once https://swr.vercel.app/docs/revalidation

  useSWR(
    isClicked && !alreadyRun ? [url, accessToken] : null,
    ([url, token]) => fetch(url, { headers: { Authorization: token } }),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshWhenOffline: false,
      refreshWhenHidden: false,
      refreshInterval: 0,
    }
  );

  return (
    <div>
      {(alreadyRun && (
        <>
          <strong>{workflow}</strong> jobs already exist.
        </>
      )) || (
        <div
          key={workflow}
          onClick={() => {
            setIsClicked(true);
            setMessage(
              `Trigger ${workflow} jobs on ${sha}. Please refresh the page after a few minutes to see the jobs.`
            );
          }}
        >
          <input
            type="checkbox"
            disabled={isClicked}
            name={workflow}
            checked={isClicked}
            onChange={() => {}}
          />
          <label htmlFor={workflow}> {message}</label>
        </div>
      )}
    </div>
  );
}

export default function WorkflowDispatcher({
  repoOwner,
  repoName,
  commit,
  jobs,
}: {
  repoOwner: string;
  repoName: string;
  commit: CommitData;
  jobs: JobData[];
}) {
  const session = useSession();
  if (
    session === undefined ||
    session.data === null ||
    session.data["accessToken"] === undefined ||
    session.data["user"] == undefined
  ) {
    return <></>;
  }

  const repo = `${repoOwner}/${repoName}`;
  if (!(repo in SUPPORTED_WORKFLOWS)) {
    return <></>;
  }

  const supportedWorkflows = SUPPORTED_WORKFLOWS[repo];
  const accessToken = session.data["accessToken"];

  return (
    <div>
      <h2>Run more jobs?</h2>
      {Object.keys(supportedWorkflows).map((workflow) => (
        <Workflow
          key={workflow}
          accessToken={accessToken}
          repoOwner={repoOwner}
          repoName={repoName}
          workflow={workflow}
          sha={commit.sha}
          jobs={jobs}
        />
      ))}
      <br />
    </div>
  );
}

export function SingleWorkflowDispatcher({
  sha,
  jobName,
}: {
  sha: string;
  jobName: string;
}) {
  let [runMoreJobsClicked, setRunMoreJobsClicked] = useState(false);

  let session: any = useSession();
  const router = useRouter();

  let { repoOwner, repoName } = router.query;

  if (!repoOwner) {
    repoOwner = "pytorch";
    repoName = "pytorch";
  }

  const { data, error } = useSWR<CommitApiResponse>(
    runMoreJobsClicked && `/api/${repoOwner}/${repoName}/commit/${sha}`,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );

  let workflow = getWorkflowName(jobName);

  const repo = `${repoOwner}/${repoName}`;
  if (
    !session ||
    !session.data ||
    !session.data["accessToken"] ||
    !(repo in SUPPORTED_WORKFLOWS) ||
    !workflow ||
    !(workflow in SUPPORTED_WORKFLOWS[repo])
  ) {
    return <></>;
  }

  const accessToken = session.data["accessToken"];

  if (!runMoreJobsClicked) {
    return (
      <div>
        <button onClick={() => setRunMoreJobsClicked(true)}>
          Run more jobs?
        </button>
      </div>
    );
  }

  if (error != null) {
    return <div>Error occurred</div>;
  }

  if (data === undefined) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <Workflow
        accessToken={accessToken}
        repoOwner={repoOwner as string}
        repoName={repoName as string}
        workflow={workflow}
        sha={sha}
        jobs={data.jobs}
      />
    </div>
  );
}
