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
  DEFAULT_BRANCHES,
  SPEEDUP_THRESHOLD,
  COMPRESSION_RATIO_THRESHOLD,
  PASSING_ACCURACY,
  DIFF_HEADER,
  AugmentData,
  ModePicker,
  MODES,
  LogLinks,
  JOB_NAME_REGEX,
  LOG_PREFIX,
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
  SHA_DISPLAY_LENGTH,
  HELP_LINK,
  RELATIVE_THRESHOLD,
} from "../../compilers";
import { CompilerPerformanceData } from "lib/types";
import styles from "components/metrics.module.css";
import CopyLink from "components/CopyLink";

const GRAPH_ROW_HEIGHT = 245;
const ROW_GAP = 30;
const ROW_HEIGHT = 48;

// Headers
const ACCURACY_HEADER = "Accuracy";
const SPEEDUP_HEADER = `Performance speedup (threshold = ${SPEEDUP_THRESHOLD}x)`;
const ABS_LATENCY_HEADER = `Absolute execution time (millisecond)`;
const COMPILATION_LATENCY_HEADER = `Compilation latency (seconds)`;
const MEMORY_HEADER = `Peak memory compression ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`;

// The number of digit after decimal to display on the detail page
const SCALE = 4;

function CommitPanel({
  suite,
  lBranch,
  lCommit,
  lDate,
  rBranch,
  rCommit,
  rDate,
  workflowId,
}: {
  suite: string;
  lBranch: string;
  lCommit: string;
  lDate: string;
  rBranch: string;
  rCommit: string;
  rDate: string;
  workflowId: number;
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

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  data = AugmentData(data);
  data = data
    ? data.filter((e: CompilerPerformanceData) => e.suite === suite)
    : data;

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
    const setting = m[2];
    const index = m[3];
    const total = m[4];

    return {
      index: index,
      setting: setting,
      total: total,
      url: url,
    };
  });

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was generated by CI running on PyTorch {lBranch} branch at{" "}
        <a href={`${HUD_PREFIX}/${lCommit}#inductor-a100-perf-nightly`}>
          {lCommit.substring(0, SHA_DISPLAY_LENGTH)}
        </a>{" "}
        on {dayjs(lDate).format("YYYY/MM/DD")} comparing with {rBranch} branch
        at commit{" "}
        <a href={`${HUD_PREFIX}/${rCommit}#inductor-a100-perf-nightly`}>
          {rCommit.substring(0, SHA_DISPLAY_LENGTH)}
        </a>
        . The running logs per shard are:{" "}
        <LogLinks key={`log-${name}`} suite={name} logs={logs} />.
      </Typography>
    </Stack>
  );
}

function ModelPanel({
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
  lData,
  rBranch,
  rCommit,
  rData,
}: {
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
  if (lCommit !== rCommit && rData !== undefined) {
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

      // Absolute execution time
      abs_latency: {
        l: hasL ? record["l"]["abs_latency"] : 0,
        r: hasR ? record["r"]["abs_latency"] : 0,
      },
    };
  });

  return (
    <Grid container spacing={2} style={{ height: "100%" }}>
      <Grid item xs={12} lg={12} height={data.length * ROW_HEIGHT + ROW_GAP}>
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
                const url = `/benchmark/${suite}/${compiler}?startTime=${startTime}&stopTime=${stopTime}&granularity=${granularity}&mode=${mode}&model=${encodedName}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}`;

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
                        <u>{lCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
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
                    <a target="_blank" rel="noreferrer" href={rLog}>
                      <u>{rCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
                    </a>{" "}
                    →{" "}
                    <a target="_blank" rel="noreferrer" href={lLog}>
                      <u>{lCommit.substr(0, SHA_DISPLAY_LENGTH)}</u>
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
                if (v === undefined || v.r == undefined) {
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

                if (v.r === undefined) {
                  return (
                    <>
                      {v.l} (<strong>NEW!</strong>)
                    </>
                  );
                } else if (lCommit === rCommit || v.l === v.r) {
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
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= SPEEDUP_THRESHOLD ? "" : styles.warning;
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
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

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "compilation_latency",
              headerName: COMPILATION_LATENCY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return "";
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
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

                const l = Number(v.l).toFixed(0);
                const r = Number(v.r).toFixed(0);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "compression_ratio",
              headerName: MEMORY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return l >= COMPRESSION_RATIO_THRESHOLD ? "" : styles.warning;
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.error;
                  }

                  if (l < COMPRESSION_RATIO_THRESHOLD) {
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

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
                }
              },
            },
            {
              field: "abs_latency",
              headerName: ABS_LATENCY_HEADER,
              flex: 1,
              cellClassName: (params: GridCellParams<any>) => {
                const v = params.value;
                if (v === undefined || v.r === 0) {
                  return "";
                }

                const l = Number(v.l);
                const r = Number(v.r);

                if (lCommit === rCommit) {
                  return "";
                } else {
                  if (l === 0 || l === r) {
                    // 0 means the model isn't run at all
                    return "";
                  }

                  // Decreasing more than x%
                  if (r - l > RELATIVE_THRESHOLD * r) {
                    return styles.ok;
                  }

                  // Increasing more than x%
                  if (l - r > RELATIVE_THRESHOLD * r) {
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

                const l = Number(v.l).toFixed(SCALE);
                const r = Number(v.r).toFixed(SCALE);

                if (lCommit === rCommit || l === r || v.r === 0) {
                  return l;
                } else {
                  return `${r} → ${l}`;
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
      name: "branches",
      type: "string",
      value: branch === MAIN_BRANCH ? DEFAULT_BRANCHES.join(",") : branch,
    },
    ...queryParams,
  ];
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranch)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  data = AugmentData(data);

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
      record.speedup = Number(record.speedup.toFixed(SCALE));
      record.compilation_latency = Number(
        record.compilation_latency.toFixed(0)
      );
      record.compression_ratio = Number(
        record.compression_ratio.toFixed(SCALE)
      );
      record.abs_latency = Number(record.abs_latency.toFixed(SCALE));
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
  const absTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "abs_latency",
    false
  );

  return (
    <>
      <div>
        <h2>Details for {model}</h2>
        <Grid container spacing={2}>
          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={geomeanSeries}
              title={`Speedup`}
              groupByFieldName={groupByFieldName}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
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
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={absTimeSeries}
              title={`Absolute execution time`}
              groupByFieldName={groupByFieldName}
              yAxisLabel={"millisecond"}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>
        </Grid>
      </div>
      <div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Commit</th>
              <th>Accuracy</th>
              <th>Speedup</th>
              <th>Comptime</th>
              <th>Memory</th>
              <th>AbsLatency</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((entry: any, index: number) => {
              let commit = WORKFLOW_ID_TO_COMMIT[entry.workflow_id];
              return (
                <tr key={index}>
                  <td>{entry.granularity_bucket}</td>
                  <td>
                    <code>
                      <a
                        onClick={() => navigator.clipboard.writeText(commit)}
                        className="animate-on-click"
                      >
                        {commit}
                      </a>
                    </code>
                  </td>
                  <td>{entry.accuracy}</td>
                  <td>{entry.speedup}</td>
                  <td>{entry.compilation_latency}</td>
                  <td>{entry.compression_ratio}</td>
                  <td>{entry.abs_latency}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div>
          Tip: to view all commits between two commits, run{" "}
          <code>git log --oneline START..END</code> (NB: this will exclude the
          START commit itself, which is typically what you want.)
        </div>
      </div>
    </>
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
      name: "branches",
      type: "string",
      value: lBranch === MAIN_BRANCH ? DEFAULT_BRANCHES.join(",") : lBranch,
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

  let { data: lData, error: lError } = useSWR(lUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  lData = AugmentData(lData);
  lData = lData
    ? lData.filter((e: CompilerPerformanceData) => e.suite === suite)
    : lData;

  const queryParamsWithR: RocksetParam[] = [
    {
      name: "branches",
      type: "string",
      value: rBranch === MAIN_BRANCH ? DEFAULT_BRANCHES.join(",") : rBranch,
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

  let { data: rData, error: rError } = useSWR(rUrl, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  rData = AugmentData(rData);
  rData = rData
    ? rData.filter((e: CompilerPerformanceData) => e.suite === suite)
    : rData;

  if (lData === undefined || lData.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  return (
    <div>
      <CommitPanel
        suite={suite}
        lBranch={lBranch}
        lCommit={lCommit}
        lDate={lData[0].granularity_bucket}
        rBranch={rBranch}
        rCommit={rCommit}
        rDate={
          rData !== undefined && rData.length !== 0
            ? rData[0].granularity_bucket
            : undefined
        }
        workflowId={lData[0].workflow_id}
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
        granularity={granularity}
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

    const granularity: Granularity =
      (router.query.granularity as Granularity) ?? undefined;
    if (granularity !== undefined) {
      setGranularity(granularity);
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

    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
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
          textToCopy={
            `${baseUrl}?startTime=${encodeURIComponent(
              startTime.toString()
            )}&stopTime=${encodeURIComponent(
              stopTime.toString()
            )}&granularity=${granularity}&mode=${mode}&dtype=${dtype}&lBranch=${lBranch}&lCommit=${lCommit}&rBranch=${rBranch}&rCommit=${rCommit}` +
            (model === undefined ? "" : `&model=${model}`)
          }
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
          setGranularity={setGranularity}
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
          fallbackIndex={-1} // Default to the next to latest in the window
          timeRange={timeRange}
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
          timeRange={timeRange}
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
