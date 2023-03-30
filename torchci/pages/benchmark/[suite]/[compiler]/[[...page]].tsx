import dayjs, { Dayjs } from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import { Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
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
  BranchPicker,
  SuitePicker,
  SUITES,
} from "../../compilers";
import { CompilerPerformanceData } from "lib/types";
import styles from "components/metrics.module.css";

const LAST_N_DAYS = 7;
const TABLE_ROW_HEIGHT = 1000;
const GRAPH_ROW_HEIGHT = 245;
const ROW_GAP = 30;
const HUD_PREFIX = "/pytorch/pytorch/commit";
const TIME_FIELD_NAME = "granularity_bucket";

const SPEEDUP_THRESHOLD = 0.95;
const COMPILATION_lATENCY_THRESHOLD_IN_SECONDS = 120;
const COMPRESSION_RATIO_THRESHOLD = 0.9;

const OK_ACCURACY = new Set<string>([
  "pass",
  "pass_due_to_skip",
  "eager_variation",
]);

function BuildSummary({ branch, records }: { branch: string; records: any }) {
  // Just need the sha of the latest report, all records have the same value
  const latestSha = records[0].head_sha;
  const latestDate = records[0].granularity_bucket;

  return (
    <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
      <Typography fontSize={"1rem"} fontStyle={"italic"}>
        *This report was last generated by CI running on PyTorch {branch} branch
        at{" "}
        <a href={`${HUD_PREFIX}/${latestSha}#inductor-a100-perf-nightly`}>{latestSha.substring(0, 7)}</a>{" "}
        on {dayjs(latestDate).format("YYYY/MM/DD")}.
      </Typography>
    </Stack>
  );
}

function selectRecordsByIndex(data: any, index: number) {
  const fieldName = "workflow_id";
  const ids = new Set<string>(data.map((record: any) => record[fieldName]));

  if (index >= ids.size) {
    return data;
  }

  const selectId = Array.from(ids).sort((a: string, b: string) =>
    a > b ? -1 : 1
  )[index];
  return data.filter((record: any) => record[fieldName] === selectId);
}

function ModelsPanel({
  branch,
  suite,
  compiler,
  dtypes,
  modelName,
  records,
}: {
  branch: string;
  suite: string;
  compiler: string;
  dtypes: string;
  modelName: string;
  records: any;
}) {
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={12} height={TABLE_ROW_HEIGHT + ROW_GAP}>
        <TablePanelWithData
          title={"Models"}
          data={records}
          columns={[
            {
              field: "name",
              headerName: "Name",
              flex: 1,
              cellClassName: (params: GridCellParams<string>) => {
                return modelName !== undefined && params.value === modelName
                  ? styles.selectedRow
                  : styles.name;
              },
              renderCell: (params: GridRenderCellParams<string>) => {
                const name = params.value;
                if (name === undefined) {
                  return `Invalid model name ${name}`;
                }

                const encodedName = encodeURIComponent(name);
                const url = `/benchmark/${suite}/${compiler}?modelName=${encodedName}&dtypes=${dtypes}&branch=${branch}`;
                return <a href={url}>{name}</a>;
              },
            },
            {
              field: "accuracy",
              headerName: "Accuracy",
              flex: 1,
              cellClassName: (params: GridCellParams<string>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                return OK_ACCURACY.has(v) ? "" : styles.warning;
              },
            },
            {
              field: "speedup",
              headerName: `Performance speedup (threshold = ${SPEEDUP_THRESHOLD}x)`,
              flex: 1,
              valueFormatter: (params: GridValueFormatterParams<any>) => {
                return `${Number(params.value).toFixed(4)}`;
              },
              cellClassName: (params: GridCellParams<string>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                return Number(v) > SPEEDUP_THRESHOLD ? "" : styles.warning;
              },
            },
            {
              field: "compilation_latency",
              headerName: `Compilation latency in seconds (threshold = ${COMPILATION_lATENCY_THRESHOLD_IN_SECONDS}s)`,
              flex: 1,
              valueFormatter: (params: GridValueFormatterParams<any>) => {
                return `${Number(params.value).toFixed(2)}`;
              },
              cellClassName: (params: GridCellParams<string>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                return Number(v) < COMPILATION_lATENCY_THRESHOLD_IN_SECONDS &&
                  Number(v) > 0
                  ? ""
                  : styles.warning;
              },
            },
            {
              field: "compression_ratio",
              headerName: `Peak memory compression ratio (threshold = ${COMPRESSION_RATIO_THRESHOLD}x)`,
              flex: 1,
              valueFormatter: (params: GridValueFormatterParams<any>) => {
                return `${Number(params.value).toFixed(4)}`;
              },
              cellClassName: (params: GridCellParams<string>) => {
                const v = params.value;
                if (v === undefined) {
                  return "";
                }

                return Number(v) > COMPRESSION_RATIO_THRESHOLD
                  ? ""
                  : styles.warning;
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
  suite,
  compiler,
  modelName,
  records,
  startTime,
  stopTime,
  granularity,
}: {
  suite: string;
  compiler: string;
  modelName: string;
  records: any;
  startTime: Dayjs;
  stopTime: Dayjs;
  granularity: Granularity;
}) {
  if (modelName === undefined) {
    return <></>;
  }

  const groupByFieldName = "name";
  const chartData = records.filter(
    (record: any) => record["name"] == modelName
  );

  const geomeanSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "speedup"
  );
  const compTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compilation_latency"
  );
  const memorySeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compression_ratio"
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
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
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
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
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
            return `${unit}`;
          }}
          additionalOptions={{
            yAxis: {
              scale: true,
            },
          }}
        />
      </Grid>
    </Grid>
  );
}

function Report({
  branch,
  suite,
  compiler,
  dtypes,
  modelName,
  queryParams,
  granularity,
}: {
  branch: string;
  suite: string;
  compiler: string;
  dtypes: string;
  modelName: string;
  queryParams: RocksetParam[];
  granularity: Granularity;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  // Select 0 for the latest record, 1 for the next to latest, etc
  const selectRecords = selectRecordsByIndex(data, 0);

  return (
    <div>
      <BuildSummary branch={branch} records={selectRecords} />
      <GraphPanel
        suite={suite}
        compiler={compiler}
        modelName={modelName}
        records={data}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
      />
      <ModelsPanel
        branch={branch}
        suite={suite}
        compiler={compiler}
        dtypes={dtypes}
        modelName={modelName}
        records={selectRecords}
      />
    </div>
  );
}

export default function Page() {
  const router = useRouter();

  // The dimensions to query Rockset
  const compiler: string = (router.query.compiler as string) ?? undefined;
  const modelName: string = (router.query.modelName as string) ?? undefined;

  const [startTime, setStartTime] = useState(dayjs().subtract(LAST_N_DAYS, "day"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [dtypes, setDTypes] = useState<string>(DTYPES[0]);
  const [suite, setSuite] = useState<string>(Object.keys(SUITES)[0]);
  const [branch, setBranch] = useState<string>("master");

  // Set the dropdown value what is in the param
  useEffect(() => {
    const dtypes: string = (router.query.dtypes as string) ?? undefined;
    if (dtypes !== undefined) {
      setDTypes(dtypes);
    }

    const suite: string = (router.query.suite as string) ?? undefined;
    if (suite !== undefined) {
      setSuite(suite);
    }

    const branch: string = (router.query.branch as string) ?? undefined;
    if (branch !== undefined) {
      setBranch(branch);
    }
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
      name: "compilers",
      type: "string",
      value: compiler,
    },
    {
      name: "dtypes",
      type: "string",
      value: dtypes,
    },
    {
      name: "branch",
      type: "string",
      value: branch,
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchDynamo Performance DashBoard (
          {COMPILER_NAMES_TO_DISPLAY_NAMES[compiler] || compiler})
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
          defaultValue={LAST_N_DAYS}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
        <BranchPicker branch={branch} setBranch={setBranch} queryParams={queryParams} />
        <SuitePicker suite={suite} setSuite={setSuite} />
        <DTypePicker dtypes={dtypes} setDTypes={setDTypes} />
      </Stack>

      <Grid item xs={12}>
        <Report
          branch={branch}
          suite={suite}
          compiler={compiler}
          dtypes={dtypes}
          modelName={modelName}
          queryParams={queryParams}
          granularity={granularity}
        />
      </Grid>
    </div>
  );
}