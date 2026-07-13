import { providerPollStateRepository } from "../../db/repositories";
import { runWorkerCycle } from "../../workers/runWorkerCycle";
import { ScriptedFootballDataProvider } from "./scriptedFootballDataProvider";
import type { CheckpointId } from "./gameweekLifecycleScenario";

const scriptedProvider = new ScriptedFootballDataProvider();

/**
 * Moves the running scenario to a checkpoint by pointing the scripted provider at it and running
 * one real worker cycle — so every Match/Gameweek mutation, score calculation, transfer award,
 * and standings update flows through the exact production pipeline. runWorkerCycle gates fixture
 * discovery behind providerPollState.lastDiscoveryRanAt (12h in prod), so that gate is rewound
 * first; awaiting the cycle is enough to know the whole downstream cascade has finished.
 */
export async function advanceScenarioToCheckpoint(checkpointId: CheckpointId): Promise<void> {
  const pollState = await providerPollStateRepository.getOrCreate();
  await providerPollStateRepository.update(pollState.id, { lastDiscoveryRanAt: new Date(0) });

  scriptedProvider.setCurrentCheckpoint(checkpointId);
  await runWorkerCycle(scriptedProvider);
}
