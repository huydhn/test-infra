import dayjs, { Dayjs } from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  Grid,
  Paper,
  Skeleton,
  Stack,
  Typography,
  Divider,
} from "@mui/material";
import { useRouter } from "next/router";
import {
  GridValueFormatterParams,
  GridRenderCellParams,
  GridCellParams,
} from "@mui/x-data-grid";
import React from "react";
import { useState, useEffect } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  TimeSeriesPanelWithData,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import GranularityPicker from "components/GranularityPicker";
import { TimeRangePicker } from "../../../metrics";
import {
  COMPILER_NAMES_TO_DISPLAY_NAMES,
  DTypePicker,
  DTYPES,
  BranchAndCommitPicker,
  SUITES,
  LAST_N_DAYS,
  HUD_PREFIX,
  TIME_FIELD_NAME,
  MAIN_BRANCH,
  SPEEDUP_THRESHOLD,
  COMPILATION_lATENCY_THRESHOLD_IN_SECONDS,
  COMPRESSION_RATIO_THRESHOLD,
  PASSING_ACCURACY,
  DIFF_HEADER,
  ModePicker,
  MODES,
  LogLinks,
  JOB_NAME_REGEX,
  LOG_PREFIX,
  COMMIT_TO_WORKFLOW_ID,
} from "../../compilers";
import { CompilerPerformanceData } from "lib/types";
import styles from "components/metrics.module.css";
import CopyLink from "components/CopyLink";

const TABLE_ROW_HEIGHT = 1000;
const GRAPH_ROW_HEIGHT = 245;
const ROW_GAP = 30;

// Headers
const ACCURACY_HEADER = "Accuracy";
const SPEEDUP_HEADER = `Performance speedup (threshold = ${SPEEDUP_THRESHOLD}x)`;
const LATENCY_HEADER = `Compilation latency in seconds (threshold = ${COMPILATION_lATENCY_THRESHOLD_IN_SECONDS}s)`;
const MEMORY_HEADER = `Peak memory compression ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`;

function CommitPanel({
  suite,
  branch,
  commit,
  workflowId,
  date,
}: {
  suite: string;
  branch: string;
  commit: string;
  workflowId: number;
  date: string;
}) {
  const queryCollection = "commons";
  const queryName = "get_workflow_jobs";

  // Hack alert: The test configuration uses timm instead of timm_model as its output
  const name = suite.includes("timm") ? "timm" : suite;
  // Fetch the job ID to generate the link to its CI logs
  const queryParams: RocksetParam[] = [
    {
      name: "workflowId",
      type: "int",
      value: workflowId,
    },
    {
      name: "jobName",
      type: "string",
      value: `%${name}%`,
    },
  ];
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return <></>;
  }

  const logs = data.map((record: any) => {
    const id = record.id;
    const url = `${LOG_PREFIX}/${id}`;

    const name = record.name;
    // Extract the shard ID
    const m = name.match(JOB_NAME_REGEX);
    if (m === null) {
      return;
    }

    const suite = m[1];
    const index = m[2];
    const total = m[3];

    return {
      index: index,
      total: total,
      url: url,
    };
  });

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was generated by CI running on PyTorch {branch} branch at{" "}
        <a href={`${HUD_PREFIX}/${commit}#inductor-a100-perf-nightly`}>
          {commit.substring(0, 7)}
        </a>{" "}
        on {dayjs(date).format("YYYY/MM/DD")}. The running logs per shard are:{" "}
        <LogLinks key={`log-${name}`} suite={name} logs={logs} />.
      </Typography>
    </Stack>
  );
}

function ModelPanel({
  startTime,
  stopTime,
  suite,
  mode,
  dtype,
  compiler,
  model,
  lBranch,
  lCommit,
  lData,
  rBranch,
  rCommit,
  rData,
}: {
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  suite: string;
  mode: string;
  dtype: string;
  compiler: string;
  model: string;
  lBranch: string;
  lCommit: string;
  lData: CompilerPerformanceData[];
  rBranch: string;
  rCommit: string;
  rData: CompilerPerformanceData[];
}) {
  const dataGroupedByModel: { [k: string]: any } = {};
  lData.forEach((record: CompilerPerformanceData) => {
    dataGroupedByModel[record.name] = {
      l: record,
    };
  });

  // Combine with right data
  if (lCommit !== rCommit) {
    rData.forEach((record: CompilerPerformanceData) => {
      if (record.name in dataGroupedByModel) {
        dataGroupedByModel[record.name]["r"] = record;
      } else {
        dataGroupedByModel[record.name] = {
          r: record,
        };
      }
    });
  }

  // Transform the data into a displayable format
  const data = Object.keys(dataGroupedByModel).map((name: string) => {
    const record = dataGroupedByModel[name];
    const hasL = "l" in record;
    const hasR = "r" in record;

    return {
      // Keep the name as as the row ID as DataGrid requires it
      name: name,

      // The model name and the logs
      metadata: {
        name: name,
        l: hasL ? record["l"]["job_id"] : undefined,
        r: hasR ? record["r"]["job_id"] : undefined,
      },

      // Accuracy
      accuracy: {
        l: hasL ? record["l"]["accuracy"] : undefined,
        r: hasR ? record["r"]["accuracy"] : undefined,
      },

      // Speedup
      speedup: {
        l: hasL ? record["l"]["speedup"] : 0,
        r: hasR ? record["r"]["speedup"] : 0,
      },

      // Compilation latency
      compilation_latency: {
        l: hasL ? record["l"]["compilation_latency"] : 0,
        r: hasR ? record["r"]["compilation_latency"] : 0,
      },

      // Compression ratio
      compression_ratio: {
        l: hasL ? record["l"]["compression_ratio"] : 0,
        r: hasR ? record["r"]["compression_ratio"] : 0,
      },
    };
  });

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={12} height={TABLE_ROW_HEIGHT + ROW_GAP}>
        <TablePanelWithData
          title={"Models"}
          data={data}
          columns={[
            {
              field: "metadata",
              headerName: "Name",
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const name = params.value.name;
                if (name === undefined) {
                  return "";
                }

                return model !== undefined && name === model
                  ? styles.selectedRow
                  : "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const name = params.value.name;
                if (name === undefined) {
                  return `Invalid model name ${name}`;
                }

                const lLog =
                  params.value.l !== undefined
                    ? `${LOG_PREFIX}/${params.value.l}`
                    : undefined;
                const rLog =
                  params.value.r !== undefined
                    ? `${LOG_PREFIX}/${params.value.r}`
                    : undefined;

                const encodedName = encodeURIComponent(name);
                const url = `/benchmark/${suite}/${compiler}?startTime=${startTime}&stopTime=${stopTime}&mode=${mode}&model=${encodedName}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

                if (lLog === undefined) {
                  return (
                    <a href={url}>
                      <b>{name}</b>
                    </a>
                  );
                } else if (lLog === rLog) {
                  return (
                    <>
                      <a href={url}>
                        <b>{name}</b>
                      </a>
                      &nbsp;(
                      <a target="_blank" rel="noreferrer" href={lLog}>
                        <u>{lCommit.substr(0, 7)}</u>
                      </a>
                      )
                    </>
                  );
                }

                return (
                  <>
                    <a href={url}>
                      <b>{name}</b>
                    </a>
                    &nbsp;(
                    <a target="_blank" rel="noreferrer" href={lLog}>
                      <u>{rCommit.substr(0, 7)}</u>
                    </a>{" "}
                    →{" "}
                    <a target="_blank" rel="noreferrer" href={rLog}>
                      <u>{lCommit.substr(0, 7)}</u>
                    </a>
                    )
                  </>
                );
              },
            },
            {
              field: "accuracy",
              headerName:
                lCommit === rCommit
                  ? ACCURACY_HEADER
                  : `${ACCURACY_HEADER}: ${DIFF_HEADER}`,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                if (lCommit === rCommit) {
                  return PASSING_ACCURACY.includes(v.l) ? "" : styles.warning;
                } else {
                  if (
                    PASSING_ACCURACY.includes(v.l) &&
                    !PASSING_ACCURACY.includes(v.r)
                  ) {
                    return styles.ok;
                  }

                  if (
                    !PASSING_ACCURACY.includes(v.l) &&
                    PASSING_ACCURACY.includes(v.r)
                  ) {
                    return styles.error;
                  }

                  if (v.l === v.r) {
                    return "";
                  }
                }

                return "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                if (lCommit === rCommit) {
                  return v.l;
                } else {
                  return `${v.r} → ${v.l}`;
                }
              },
            },
            {
              field: "speedup",
              headerName: SPEEDUP_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= SPEEDUP_THRESHOLD ? "" : styles.warning;
                } else {
                  if (l >= SPEEDUP_THRESHOLD && r < SPEEDUP_THRESHOLD) {
                    return styles.ok;
                  }

                  if (l < SPEEDUP_THRESHOLD && r >= SPEEDUP_THRESHOLD) {
                    return styles.error;
                  }

                  if ((l === 0 && r === 0) || l === r) {
                    return "";
                  }

                  // If the value decreases more than SPEEDUP_THRESHOLD, this also needs to be marked
                  // as a regression
                  if (r * SPEEDUP_THRESHOLD > l) {
                    return styles.error;
                  }
                }

                return "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l).toFixed(2);
                const r = Number(v.r).toFixed(2);

                if (lCommit === rCommit) {
                  return l;
                } else {
                  return `${r} → ${l} ${
                    Number(l) < Number(r) ? "\uD83D\uDD3B" : ""
                  }`;
                }
              },
            },
            {
              field: "compilation_latency",
              headerName: LATENCY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                    ? styles.warning
                    : "";
                } else {
                  if (
                    l <= COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                    r > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                  ) {
                    return styles.ok;
                  }

                  if (
                    l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                    r <= COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                  ) {
                    return styles.error;
                  }

                  if (l === r) {
                    return "";
                  }

                  if (
                    l > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                    r > COMPILATION_lATENCY_THRESHOLD_IN_SECONDS
                  ) {
                    return styles.warning;
                  }
                }

                return "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l).toFixed(0);
                const r = Number(v.r).toFixed(0);

                if (lCommit === rCommit) {
                  return l;
                } else {
                  return `${r} → ${l} ${
                    Number(l) > Number(r) && Number(r) != 0
                      ? "\uD83D\uDD3A"
                      : ""
                  }`;
                }
              },
            },
            {
              field: "compression_ratio",
              headerName: MEMORY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= COMPRESSION_RATIO_THRESHOLD ? "" : styles.warning;
                } else {
                  if (
                    l >= COMPRESSION_RATIO_THRESHOLD &&
                    r < COMPRESSION_RATIO_THRESHOLD
                  ) {
                    return styles.ok;
                  }

                  if (
                    l < COMPRESSION_RATIO_THRESHOLD &&
                    r >= COMPRESSION_RATIO_THRESHOLD
                  ) {
                    return styles.error;
                  }

                  if ((l === 0 && r === 0) || l === r) {
                    return "";
                  }

                  // If the value decreases more than SPEEDUP_THRESHOLD, this also needs to be marked
                  // as a regression
                  if (r * COMPRESSION_RATIO_THRESHOLD > l) {
                    return styles.error;
                  }
                }

                return "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                const l = Number(v.l).toFixed(2);
                const r = Number(v.r).toFixed(2);

                if (lCommit === rCommit) {
                  return l;
                } else {
                  return `${r} → ${l} ${
                    Number(l) < Number(r) ? "\uD83D\uDD3B" : ""
                  }`;
                }
              },
            },
          ]}
          dataGridProps={{ getRowId: (el: any) => el.name }}
        />
      </Grid>
    </Grid>
  );
}

function GraphPanel({
  queryParams,
  granularity,
  compiler,
  model,
  branch,
  lCommit,
  rCommit,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  compiler: string;
  model: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithBranch: RocksetParam[] = [
    {
      name: "branch",
      type: "string",
      value: branch,
    },
    ...queryParams,
  ];
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranch)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  if (model === undefined) {
    return <></>;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lCommit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rCommit];

  const groupByFieldName = "name";
  const chartData = data
    .filter((record: CompilerPerformanceData) => record.name == model)
    .filter((record: CompilerPerformanceData) => {
      const id = record.workflow_id;
      return (
        (id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)
      );
    })
    .map((record: CompilerPerformanceData) => {
      record.speedup = Number(record.speedup.toFixed(2));
      record.compilation_latency = Number(
        record.compilation_latency.toFixed(0)
      );
      record.compression_ratio = Number(record.compression_ratio.toFixed(2));
      // Truncate the data to make it consistent with the display value
      return record;
    });

  const geomeanSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "speedup",
    false
  );
  const compTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compilation_latency",
    false
  );
  const memorySeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compression_ratio",
    false
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={chartData}
          series={geomeanSeries}
          title={`Geomean`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit.toFixed(2)}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return Number(r.value[1]).toFixed(2);
              },
            },
          }}
        />
      </Grid>

      <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={chartData}
          series={compTimeSeries}
          title={`Mean compilation time`}
          groupByFieldName={groupByFieldName}
          yAxisLabel={"second"}
          yAxisRenderer={(unit) => {
            return `${unit.toFixed(0)}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return Number(r.value[1]).toFixed(0);
              },
            },
          }}
        />
      </Grid>

      <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
        <TimeSeriesPanelWithData
          data={chartData}
          series={memorySeries}
          title={`Peak memory footprint compression ratio`}
          groupByFieldName={groupByFieldName}
          yAxisRenderer={(unit) => {
            return `${unit.toFixed(2)}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
            label: {
              show: true,
              align: "left",
              formatter: (r: any) => {
                return Number(r.value[1]).toFixed(2);
              },
            },
          }}
        />
      </Grid>
    </Grid>
  );
}

function Report({
  queryParams,
  startTime,
  stopTime,
  granularity,
  suite,
  mode,
  dtype,
  compiler,
  model,
  lBranch,
  lCommit,
  rBranch,
  rCommit,
}: {
  queryParams: RocksetParam[];
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  granularity: Granularity;
  suite: string;
  mode: string;
  dtype: string;
  compiler: string;
  model: string;
  lBranch: string;
  lCommit: string;
  rBranch: string;
  rCommit: string;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithL: RocksetParam[] = [
    {
      name: "branch",
      type: "string",
      value: lBranch,
    },
    {
      name: "commits",
      type: "string",
      value: lCommit,
    },
    {
      name: "getJobId",
      type: "bool",
      value: true,
    },
    ...queryParams,
  ];
  const lUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithL)
  )}`;

  const { data: lData, error: lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  const queryParamsWithR: RocksetParam[] = [
    {
      name: "branch",
      type: "string",
      value: rBranch,
    },
    {
      name: "commits",
      type: "string",
      value: rCommit,
    },
    {
      name: "getJobId",
      type: "bool",
      value: true,
    },
    ...queryParams,
  ];
  const rUrl = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithR)
  )}`;

  const { data: rData, error: rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (
    lData === undefined ||
    lData.length === 0 ||
    rData === undefined ||
    rData.length === 0
  ) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  return (
    <div>
      <CommitPanel
        suite={suite}
        branch={lBranch}
        commit={lCommit}
        workflowId={lData[0].workflow_id}
        date={lData[0].granularity_bucket}
      />
      <GraphPanel
        queryParams={queryParams}
        granularity={granularity}
        compiler={compiler}
        model={model}
        branch={lBranch}
        lCommit={lCommit}
        rCommit={rCommit}
      />
      <ModelPanel
        startTime={startTime}
        stopTime={stopTime}
        suite={suite}
        mode={mode}
        dtype={dtype}
        compiler={compiler}
        model={model}
        lBranch={lBranch}
        lCommit={lCommit}
        lData={lData}
        rBranch={rBranch}
        rCommit={rCommit}
        rData={rData}
      />
    </div>
  );
}

export default function Page() {
  const router = useRouter();

  // The dimensions to query Rockset
  const suite: string = (router.query.suite as string) ?? undefined;
  const compiler: string = (router.query.compiler as string) ?? undefined;
  const model: string = (router.query.model as string) ?? undefined;

  const defaultStartTime = dayjs().subtract(LAST_N_DAYS, "day");
  const [startTime, setStartTime] = useState(defaultStartTime);
  const defaultStopTime = dayjs();
  const [stopTime, setStopTime] = useState(defaultStopTime);
  const [timeRange, setTimeRange] = useState<number>(LAST_N_DAYS);

  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [mode, setMode] = useState<string>(MODES[0]);
  const [dtype, setDType] = useState<string>(DTYPES[0]);
  const [lBranch, setLBranch] = useState<string>(MAIN_BRANCH);
  const [lCommit, setLCommit] = useState<string>("");
  const [rBranch, setRBranch] = useState<string>(MAIN_BRANCH);
  const [rCommit, setRCommit] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");

  // Set the dropdown value what is in the param
  useEffect(() => {
    const startTime: string = (router.query.startTime as string) ?? undefined;
    if (startTime !== undefined) {
      setStartTime(dayjs(startTime));

      if (dayjs(startTime).valueOf() !== defaultStartTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const stopTime: string = (router.query.stopTime as string) ?? undefined;
    if (stopTime !== undefined) {
      setStopTime(dayjs(stopTime));

      if (dayjs(stopTime).valueOf() !== defaultStopTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const mode: string = (router.query.mode as string) ?? undefined;
    if (mode !== undefined) {
      setMode(mode);
    }

    const dtype: string = (router.query.dtype as string) ?? undefined;
    if (dtype !== undefined) {
      setDType(dtype);
    }

    const lBranch: string = (router.query.lBranch as string) ?? undefined;
    if (lBranch !== undefined) {
      setLBranch(lBranch);
    }

    const lCommit: string = (router.query.lCommit as string) ?? undefined;
    if (lCommit !== undefined) {
      setLCommit(lCommit);
    }

    const rBranch: string = (router.query.rBranch as string) ?? undefined;
    if (rBranch !== undefined) {
      setRBranch(rBranch);
    }

    const rCommit: string = (router.query.rCommit as string) ?? undefined;
    if (rCommit !== undefined) {
      setRCommit(rCommit);
    }

    setBaseUrl(`${window.location.host}${router.asPath.replace(/\?.+/, "")}`);
  }, [router.query]);

  if (suite === undefined || compiler === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
    {
      name: "suites",
      type: "string",
      value: suite,
    },
    {
      name: "mode",
      type: "string",
      value: mode,
    },
    {
      name: "compilers",
      type: "string",
      value: compiler,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtype,
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchInductor Performance DashBoard (
          {COMPILER_NAMES_TO_DISPLAY_NAMES[compiler] || compiler})
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?startTime=${startTime}&stopTime=${stopTime}&mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}&model=${model}`}
        />
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
        <ModePicker mode={mode} setMode={setMode} />
        <DTypePicker dtype={dtype} setDType={setDType} />
        <BranchAndCommitPicker
          branch={rBranch}
          setBranch={setRBranch}
          commit={rCommit}
          setCommit={setRCommit}
          queryParams={queryParams}
          titlePrefix={"Base"}
          fallbackIndex={0} // Default to the latest commit
        />
        <Divider orientation="vertical" flexItem>
          &mdash;Diff→
        </Divider>
        <BranchAndCommitPicker
          branch={lBranch}
          setBranch={setLBranch}
          commit={lCommit}
          setCommit={setLCommit}
          queryParams={queryParams}
          titlePrefix={"New"}
          fallbackIndex={0} // Default to the latest commit
        />
      </Stack>

      <Grid item xs={12}>
        <Report
          queryParams={queryParams}
          startTime={startTime}
          stopTime={stopTime}
          granularity={granularity}
          suite={suite}
          mode={mode}
          dtype={dtype}
          compiler={compiler}
          model={model}
          lBranch={lBranch}
          lCommit={lCommit}
          rBranch={rBranch}
          rCommit={rCommit}
        />
      </Grid>
    </div>
  );
}
