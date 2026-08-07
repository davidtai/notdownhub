/**
 * The one canonical list of GitHub-hosted `runs-on` labels this product maps onto a
 * self-hosted fleet. Two consumers, one source of truth so they can never drift:
 *
 *  - runcmd.ts (`ndh run`): client-side Runner.Client `-P` defaults for one-shot local runs
 *    (linux labels may map to a docker image there — the local machine can run containers);
 *  - rerunmap.ts (the hub front): the hub-side default mapping applied when a schedule2
 *    dispatch carries no explicit `platform`, and when a finished run is re-run (#92) —
 *    the engine stores no platform mapping with a run, so the hub must re-supply one.
 *
 * `self-hosted` itself is deliberately NOT in this list: a workflow that already targets
 * self-hosted labels needs no mapping, and the engine only rewrites a job whose whole
 * runs-on set is covered by a mapping key — so native-label workflows pass through untouched.
 */
export const HOSTED_LABELS = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "macos-latest", "windows-latest"] as const;

/**
 * Engine platform mappings (the `-P name=target` value syntax) sending every hosted label to
 * the self-hosted fleet: `-self-hosted` targets runners registered with the `self-hosted`
 * label — which every runner joined via `ndh runner join` carries. This is the hub's default:
 * it cannot know whether a docker image mapping was wanted, and a hub fleet is self-hosted
 * machines by definition, so `-self-hosted` is the one mapping that matches every fleet.
 * A dispatcher that wants containers (or anything else) passes explicit `-P`, which wins.
 */
export function hostedToSelfHosted(): string[] {
  return HOSTED_LABELS.map((label) => `${label}=-self-hosted`);
}
