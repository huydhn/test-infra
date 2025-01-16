import { LLMsBenchmarkData } from "components/benchmark/llms/common";
import { BenchmarkData, CompilerPerformanceData } from "lib/types";

export const TORCHAO_REPO = "pytorch/ao";
// TODO (huydhn): Find a better way to abstract this baseline concept, for example,
// this could be dtype noquant for TorchAO, or eager config for inductor
export const TORCHAO_BASELINE = "noquant";
// TODO (huydhn): The following are TorchAO speedup metrics. Check with ao team to
// see if this information could be codified on the benchmark instead of keeping it
// here on the dashboard
const SPEEDUP_METRICS = ["tok/s", "time_ms(avg)", "time_s(avg)", "img_s(avg)"];

export const TORCHAO_SPEEDUP_METRIC_NAMES = [
  "compile_vs_eager_speedup",
  "autoquant_vs_compile_speedup",
  "eager_speedup",
];
// Different speedup metrics, the key is quantization-torch.compile
export const TORCHAO_SPEEDUP_METRIC_NAMES_MAPPING: { [key: string]: string } = {
  "noquant-false": "compile_vs_eager_speedup",
  "-true": "autoquant_vs_compile_speedup",
};

// TODO (huydhn): Use this function to convert the generic benchmark data to the old
// CompilerPerformanceData format. This is needed until the TorchInductor dashboard
// is migrated to the new format
export function convertToCompilerPerformanceData(data: BenchmarkData[]) {
  const convertData: { [model: string]: CompilerPerformanceData } = {};
  if (data === undefined || data === null) {
    return [];
  }

  data.forEach((r: BenchmarkData) => {
    const k = `${r.granularity_bucket} ${r.model}`;

    if (!(k in convertData)) {
      convertData[k] = {
        abs_latency: 0,
        accuracy: "",
        compilation_latency: 0,
        compiler: "default",
        compression_ratio: 0,
        dynamo_peak_mem: 0,
        eager_peak_mem: 0,
        granularity_bucket: r.granularity_bucket,
        name: r.model,
        speedup: 0,
        suite: r.suite,
        workflow_id: r.workflow_id,
        job_id: r.job_id,
      };
    }

    // Accuracy metric has a string value instead of a number https://github.com/pytorch/pytorch/pull/143611
    if (r.metric === "accuracy") {
      convertData[k][r.metric] = JSON.parse(
        r.extra_info["benchmark_values"]
      )[0];
    } else {
      // @ts-expect-error
      convertData[k][r.metric] = r.value;
    }
  });

  return Object.values(convertData);
}

export function computeSpeedup(
  repoName: string,
  data: LLMsBenchmarkData[],
  useTorchCompile: boolean,
  usebaseCommitbaseline: boolean
) {
  if (repoName !== TORCHAO_REPO) {
    return data;
  }

  // https://github.com/pytorch/test-infra/pull/6178#issuecomment-2596338457, we want
  // to show 3 different speedup in AO:
  // - Current eager perf vs base commit eager
  const baseCommitBaseline: { [key: string]: LLMsBenchmarkData } = {};
  // - Current compile perf vs current eager
  // - Current autoquant perf vs current compile
  const currentCommitBaseline: { [key: string]: LLMsBenchmarkData } = {};

  data.forEach((r: LLMsBenchmarkData) => {
    if (
      r.dtype !== TORCHAO_BASELINE ||
      r.use_torch_compile !== useTorchCompile
    ) {
      return;
    }

    const baseCommitKey = `${r.model} ${r.metric} ${r.device} ${r.arch}`;
    const currentCommitKey = `${r.workflow_id} ${r.job_id} ${baseCommitKey}`;

    // To compare against the current commit
    currentCommitBaseline[currentCommitKey] = r;

    // To compare against the oldest base commit
    if (
      !usebaseCommitbaseline ||
      (baseCommitKey in baseCommitBaseline &&
        baseCommitBaseline[baseCommitKey].workflow_id < r.workflow_id)
    ) {
      return;
    }
    baseCommitBaseline[baseCommitKey] = r;
  });

  const withSpeedup: LLMsBenchmarkData[] = [];
  data.forEach((r: LLMsBenchmarkData) => {
    withSpeedup.push(r);

    // Compute eager speedup vs the base commit baseline
    if (r.dtype === TORCHAO_BASELINE && r.use_torch_compile === false) {
      if (SPEEDUP_METRICS.includes(r.metric)) {
        const k = `${r.model} ${r.metric} ${r.device} ${r.arch}`;
        if (
          k in baseCommitBaseline &&
          baseCommitBaseline[k].actual !== 0 &&
          r.actual !== 0 &&
          baseCommitBaseline[k].workflow_id <= r.workflow_id
        ) {
          const speedup = r.metric.includes("time")
            ? baseCommitBaseline[k].actual / r.actual
            : r.actual / baseCommitBaseline[k].actual;

          withSpeedup.push({
            ...r,
            metric: "eager_speedup",
            actual: Number(speedup.toFixed(2)),
            target: 0,
          });
        }
      }
    }

    if (SPEEDUP_METRICS.includes(r.metric)) {
      const k = `${r.workflow_id} ${r.job_id} ${r.model} ${r.metric} ${r.device} ${r.arch}`;
      if (
        k in currentCommitBaseline &&
        currentCommitBaseline[k].actual !== 0 &&
        r.actual !== 0
      ) {
        const speedup = r.metric.includes("time")
          ? currentCommitBaseline[k].actual / r.actual
          : r.actual / currentCommitBaseline[k].actual;

        const speedupMetricName =
          r.dtype === TORCHAO_BASELINE
            ? // Compile vs eager
              r !== currentCommitBaseline[k]
              ? TORCHAO_SPEEDUP_METRIC_NAMES_MAPPING[
                  `${r.dtype}-${useTorchCompile}`
                ]
              : ""
            : // Autoquant vs compile or vs eager
              TORCHAO_SPEEDUP_METRIC_NAMES_MAPPING[`-${useTorchCompile}`];

        if (!speedupMetricName) {
          return;
        }

        withSpeedup.push({
          ...r,
          metric: speedupMetricName,
          actual: Number(speedup.toFixed(2)),
          target: 0,
        });
      }
    }
  });

  return withSpeedup;
}
