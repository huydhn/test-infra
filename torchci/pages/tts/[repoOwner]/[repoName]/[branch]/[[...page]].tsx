import { Grid2, Paper, Skeleton, Stack, Typography } from "@mui/material";
import GranularityPicker from "components/GranularityPicker";
import styles from "components/hud.module.css";
import {
  getTooltipMarker,
  Granularity,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay, formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { fetcher } from "lib/GeneralUtils";
import { useRouter } from "next/router";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { TimeRangePicker, TtsPercentilePicker } from "../../../../metrics";

const SUPPORTED_WORKFLOWS = [
  "pull",
  "trunk",
  "nightly",
  "periodic",
  "inductor",
  "inductor-periodic",
  "rocm",
  "inductor-rocm",
];

function Panel({
  series,
  title,
}: {
  series: Array<any>;
  title: string;
}): JSX.Element {
  const options: EChartsOption = {
    title: { text: title },
    grid: { top: 48, right: 200, bottom: 24, left: 48 },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: durationDisplay,
      },
    },
    series,
    legend: {
      orient: "vertical",
      right: 10,
      top: "center",
      type: "scroll",
      textStyle: {
        overflow: "breakAll",
        width: "150",
      },
    },
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.seriesName}` +
        `<br/>${formatTimeForCharts(params.value[0])}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${durationDisplay(params.value[1])}</b>`,
    },
  };

  return (
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={options}
      notMerge={true}
    />
  );
}

function Graphs({
  queryParams,
  granularity,
  ttsPercentile,
  checkboxRef,
  branchName,
  filter,
  toggleFilter,
}: {
  queryParams: { [key: string]: any };
  granularity: Granularity;
  ttsPercentile: number;
  checkboxRef: any;
  branchName: string;
  filter: any;
  toggleFilter: any;
}) {
  const ROW_HEIGHT = 800;

  let queryName = "tts_duration_historical_percentile";
  let ttsFieldName = "tts_percentile_sec";
  let durationFieldName = "duration_percentile_sec";

  // -1 is the special case in which we will use avg instead
  if (ttsPercentile === -1) {
    queryName = "tts_duration_historical";
    ttsFieldName = "tts_avg_sec";
    durationFieldName = "duration_avg_sec";
  }

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "full_name";
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    // TODO: figure out how to deterine what error it actually is, can't just log the error
    // because its in html format instead of json?
    return (
      <div>
        error occured while fetching data, perhaps there are too many results
        with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from the database
  const startTime = dayjs(queryParams["startTime"]).startOf(granularity);
  const stopTime = dayjs(queryParams["stopTime"]).startOf(granularity);

  const tts_true_series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    ttsFieldName
  );
  const duration_true_series = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    durationFieldName
  );
  var tts_series = tts_true_series.filter((item: any) =>
    filter.has(item["name"])
  );
  var duration_series = duration_true_series.filter((item: any) =>
    filter.has(item["name"])
  );

  const repo = queryParams["repo"];
  const encodedBranchName = encodeURIComponent(branchName);
  const jobUrlPrefix = `/tts/${repo}/${encodedBranchName}?jobName=`;

  return (
    <Grid2 container spacing={2}>
      <Grid2 size={{ xs: 9 }} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"tts"} series={tts_series} />
        </Paper>
        <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
          <Panel title={"duration"} series={duration_series} />
        </Paper>
      </Grid2>
      <Grid2 size={{ xs: 3 }} height={ROW_HEIGHT}>
        <div
          style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}
          ref={checkboxRef}
        >
          {tts_true_series.map((job) => (
            <div
              key={job["name"]}
              className={filter.has(job["name"]) ? styles.selectedRow : ""}
            >
              <input
                type="checkbox"
                id={job["name"]}
                onChange={toggleFilter}
                checked={filter.has(job["name"])}
              />
              <label htmlFor={job["name"]}>
                <a href={jobUrlPrefix + encodeURIComponent(job["name"])}>
                  {job["name"]}
                </a>
              </label>
            </div>
          ))}
        </div>
      </Grid2>
    </Grid2>
  );
}

export default function Page() {
  const router = useRouter();
  const repoOwner: string = (router.query.repoOwner as string) ?? "pytorch";
  const repoName: string = (router.query.repoName as string) ?? "pytorch";
  const branch: string = (router.query.branch as string) ?? "main";
  const jobName: string = (router.query.jobName as string) ?? "none";
  const percentile: number =
    router.query.percentile === undefined
      ? 0.5
      : parseFloat(router.query.percentile as string);

  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [ttsPercentile, setTtsPercentile] = useState<number>(percentile);

  const [filter, setFilter] = useState(new Set());
  function toggleFilter(e: any) {
    var jobName = e.target.id;
    const next = new Set(filter);
    if (filter.has(jobName)) {
      next.delete(jobName);
    } else {
      next.add(jobName);
    }
    setFilter(next);
  }

  const queryParams: { [key: string]: any } = {
    branch: branch,
    granularity: granularity,
    percentile: ttsPercentile,
    repo: `${repoOwner}/${repoName}`,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    workflowNames: SUPPORTED_WORKFLOWS,
  };

  const checkboxRef = useCallback(() => {
    const selectedJob = document.getElementById(jobName);
    if (selectedJob != undefined) {
      selectedJob.click();
    }
  }, [jobName]);

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Job TTS and Duration
        </Typography>
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
        <TtsPercentilePicker
          ttsPercentile={ttsPercentile}
          setTtsPercentile={setTtsPercentile}
        />
      </Stack>
      <Graphs
        queryParams={queryParams}
        granularity={granularity}
        ttsPercentile={ttsPercentile}
        checkboxRef={checkboxRef}
        branchName={branch}
        filter={filter}
        toggleFilter={toggleFilter}
      />
    </div>
  );
}
