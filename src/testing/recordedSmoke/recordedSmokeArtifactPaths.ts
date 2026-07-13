import path from "node:path";

/** Everything the recorded smoke run writes lives under one gitignored root, wiped per run. */
export const repositoryRoot = path.resolve(__dirname, "../../..");
export const recordedSmokeArtifactsRoot = path.join(repositoryRoot, "artifacts", "recorded-smoke");
export const checkpointScreenshotsDirectory = path.join(recordedSmokeArtifactsRoot, "checkpoints");
export const playwrightTestOutputDirectory = path.join(recordedSmokeArtifactsRoot, "test-output");
export const playwrightHtmlReportDirectory = path.join(recordedSmokeArtifactsRoot, "report");
