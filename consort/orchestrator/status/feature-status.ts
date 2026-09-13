import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { readDriveContext } from "../../../consort/orchestrator/state/orchestrator-probe.js";
import { readMasterTestList, type TestListItem } from "../../../consort/test-list/test-list";
import { readPlan, type ExperimentPlan } from "../../../consort/gates/design-spec-gate";
import { storiesDir as storiesDirOf, featuresDir } from "../../../consort/config/consort-paths.js";
import {
  listExperiments,
  listExperimentStories,
  readOutcomes,
  type ExperimentOutcomes,
} from "../../../consort/experiment/experiment";
import { readSmellsLog, type SmellsLog } from "../../../consort/smells/smells";
import { GATE_NAMES, readGates, type GateName, type GateStatus } from "../../../consort/gates/gates";
import { readPipeline, type StoryStatus, type StoryGateStatus } from "../../../consort/pipeline/story-pipeline";

export type TestListStatus = TestListItem["status"];

export interface TestListSummary {
  total: number;
  by_status: Record<TestListStatus, number>;
  completion_pct: number;
}

export interface ExperimentStatusEntry {
  story_id: string;
  slug: string;
  branch_id: string;
  status: ExperimentOutcomes["status"] | null;
  tests_passed: number | null;
  tests_failed: number | null;
  schema_diff_summary: string | null;
  cycle_count: number;
}

export interface SelectionLogEntry {
  timestamp: string;
  title: string;
}

export interface WorkflowPointer {
  feature_id: string | null;
  story_id: string | null;
  ac_id: string | null;
  cycle_id: string | null;
  experiment_id: string | null;
}

export interface GateSummary {
  status: GateStatus;
  approver: string | null;
  approved_at: string | null;
}

export type GatesSummary = Record<GateName, GateSummary>;

export interface PlanStatusEntry {
  story_id: string;
  plan: ExperimentPlan;
}

/** A per-story row from pipeline.json (the source of truth for a per-story-driven
 *  feature's progression, distinct from the coarse feature-level workflow phase). */
export interface StoryStatusEntry {
  story_id: string;
  status: StoryStatus;
  gate_status: StoryGateStatus | null;
  accepted: boolean;
}

/** The deploy/promote completion RECONCILED from the drive engine's own context
 *  (deploy-evidence.json + the SCM workflow-state ladder), the SAME reconciliation
 *  consort-next uses. Lets feature-status show a deployed + merged feature's
 *  deploy/promote as done instead of the stale gates.json approval bit (Finding 13).
 *  null when the drive context cannot be read (e.g. the feature was never authored). */
export interface ProgressionSummary {
  /** The honored coarse drive phase (planning | feature | deploy | promote | done). */
  coarse_phase: string;
  /** The deploy actually ran (deploy-evidence present) or the feature has since merged. */
  deploy_done: boolean;
  /** The feature merged up to its parent tier (SCM workflow-state = merged). */
  promote_done: boolean;
}

export interface FeatureStatusSnapshot {
  feature_id: string;
  current_workflow_phase: string | null;
  /** The feature's phase DERIVED from the per-story pipeline (planning/design/
   *  build/complete), or null when no stories are tracked yet. This reflects the
   *  real per-story progression, which the coarse workflow-state.json phase does
   *  not advance (FEIP-8016). */
  derived_phase: string | null;
  current_workflow_pointer: WorkflowPointer | null;
  /** Per-story statuses from pipeline.json (empty when none tracked yet). */
  stories: StoryStatusEntry[];
  /** Per-story experiment plans: one entry per story that has a plan.json. */
  plans: PlanStatusEntry[];
  test_list: TestListSummary | null;
  experiments: ExperimentStatusEntry[];
  selection_log_recent: SelectionLogEntry[];
  open_smells: SmellsLog["detected"];
  /**
   * Structured gate state surfaced from .tdd/features/<F>/gates.json
   * (ADR-0004). null when the feature directory itself does not exist;
   * default-open shape returned when the directory exists but no
   * gates.json file has been written yet.
   */
  gates: GatesSummary | null;
  /** Deploy/promote completion reconciled from the drive engine, so the gate
   *  display agrees with consort-next instead of dumping the raw (and
   *  stale) gates.json approval bit (Finding 13). null when unreadable. */
  progression: ProgressionSummary | null;
}

const MAX_RECENT_LOG_ENTRIES = 5;

function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Story ids under features/<F>/stories/ (each may carry a plan.json). */
function listFeatureStories(consortDir: string, featureId: string): string[] {
  const storiesDir = storiesDirOf(consortDir, featureId);
  if (!existsSync(storiesDir)) return [];
  return readdirSync(storiesDir)
    .filter((d) => statSync(join(storiesDir, d)).isDirectory())
    .sort();
}

function timelineCycleCount(experimentDir: string): number {
  const timeline = readJsonIfExists<{ entries?: Array<{ kind?: string }> }>(
    join(experimentDir, "timeline.json")
  );
  return timeline?.entries?.length ?? 0;
}

function summarizeTestList(
  consortDir: string,
  featureId: string
): TestListSummary | null {
  try {
    const list = readMasterTestList(consortDir, featureId);
    const counters: Record<TestListStatus, number> = {
      pending: 0,
      red: 0,
      green: 0,
      refactored: 0,
      skipped: 0,
    };
    for (const item of list.items) counters[item.status]++;
    const total = list.items.length;
    const done = counters.green + counters.refactored;
    return {
      total,
      by_status: counters,
      completion_pct: total === 0 ? 0 : Math.round((done / total) * 100),
    };
  } catch {
    return null;
  }
}

function readSelectionLogRecent(
  consortDir: string,
  limit: number
): SelectionLogEntry[] {
  const path = join(consortDir, "selection-log.md");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  // selection-log entries start with `## <ISO-timestamp> – <title>` (en-dash, U+2013).
  const entries: SelectionLogEntry[] = [];
  const headingRe = /^##\s+(\S+T\S+?)\s+–\s+(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text)) !== null) {
    entries.push({ timestamp: match[1], title: match[2].trim() });
  }
  return entries.slice(-limit);
}

function readGatesSummary(consortDir: string, featureId: string): GatesSummary | null {
  // readGates throws when the feature directory does not exist (a clean
  // signal that no spec has been authored yet). Surface as null so the
  // snapshot stays renderable for not-yet-started features.
  try {
    const state = readGates(featureId, { consortDir });
    const out = {} as GatesSummary;
    for (const name of GATE_NAMES) {
      const rec = state.gates[name];
      out[name] = {
        status: rec.status,
        approver: rec.approver ?? null,
        approved_at: rec.approved_at ?? null,
      };
    }
    return out;
  } catch {
    return null;
  }
}

function readWorkflowState(consortDir: string): {
  phase: string | null;
  pointer: WorkflowPointer | null;
} {
  const state = readJsonIfExists<{
    phase?: string;
    feature_id?: string | null;
    story_id?: string | null;
    ac_id?: string | null;
    cycle_id?: string | null;
    experiment_id?: string | null;
  }>(join(consortDir, "workflow-state.json"));
  if (!state) return { phase: null, pointer: null };
  return {
    phase: state.phase ?? null,
    pointer: {
      feature_id: state.feature_id ?? null,
      story_id: state.story_id ?? null,
      ac_id: state.ac_id ?? null,
      cycle_id: state.cycle_id ?? null,
      experiment_id: state.experiment_id ?? null,
    },
  };
}

/** The per-story rows from pipeline.json (empty when none tracked yet). Exported
 *  so consort-next reuses the SAME reconciled view + derived phase as
 *  feature-status, and the two can never disagree (FEIP-8016/8017). */
export function summarizeStories(consortDir: string, featureId: string): StoryStatusEntry[] {
  let pipeline;
  try {
    pipeline = readPipeline(consortDir, featureId);
  } catch {
    return [];
  }
  return Object.entries(pipeline.stories).map(([story_id, e]) => ({
    story_id,
    status: e.status,
    gate_status: e.gate?.status ?? null,
    accepted: e.acceptance?.decision === "accepted" || e.status === "done",
  }));
}

/** Derive the feature's phase from the per-story pipeline, so the display reflects
 *  the real progression instead of the coarse (and stale) workflow-state phase
 *  (FEIP-8016). null when no stories are tracked (fall back to the workflow phase).
 *   - complete: every tracked story is done + accepted
 *   - build:    at least one story is past its spec gate (ready/building/awaiting-
 *               acceptance/done, or a gate approved)
 *   - design:   stories tracked but none has cleared its spec gate yet */
export function deriveFeaturePhase(stories: StoryStatusEntry[]): string | null {
  if (stories.length === 0) return null;
  if (stories.every((s) => s.status === "done" && s.accepted)) return "complete";
  const inBuild = (s: StoryStatusEntry): boolean =>
    s.status === "ready" ||
    s.status === "building" ||
    s.status === "awaiting-acceptance" ||
    s.status === "done" ||
    s.gate_status === "approved";
  if (stories.some(inBuild)) return "build";
  return "design";
}

/** The feature-request.md H1 (the feature's title in the PO's voice), or the id when
 *  the request is absent or has no heading. */
function featureRequestTitle(featureDirPath: string, id: string): string {
  const p = join(featureDirPath, "feature-request.md");
  if (!existsSync(p)) return id;
  try {
    const h1 = readFileSync(p, "utf8").split("\n").find((l) => /^#\s+/.test(l));
    return h1 ? h1.replace(/^#\s+/, "").trim() : id;
  } catch {
    return id;
  }
}

/**
 * The features prior sprints have ALREADY DELIVERED: those whose every tracked story is
 * done + accepted (the same `deriveFeaturePhase === "complete"` signal feature-status
 * derives, so the two can never disagree). Pure pipeline.json reads — no git/SCM — so it
 * is cheap enough to seed the sprint-planning prompt. Empty when nothing is delivered yet
 * (a first sprint), which is what keeps the propose prompt byte-identical there. Sorted by
 * id for a stable directive; title is the feature-request.md H1 when present, else the id.
 */
export function deliveredFeatures(consortDir: string): { id: string; title: string }[] {
  const root = featuresDir(consortDir);
  if (!existsSync(root)) return [];
  const out: { id: string; title: string }[] = [];
  const ids = readdirSync(root)
    .filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (const id of ids) {
    const stories = summarizeStories(consortDir, id);
    if (deriveFeaturePhase(stories) !== "complete") continue; // null (no stories) or not-yet-done → not delivered
    out.push({ id, title: featureRequestTitle(join(root, id), id) });
  }
  return out;
}

/** Reconcile deploy/promote completion from the drive engine's context (the SAME
 *  readDriveContext consort-next consumes), tolerant of an unreadable state.
 *  `projectDir` reaches the SCM workflow-state at <projectDir>/.lakebase/. */
function readProgression(
  consortDir: string,
  featureId: string,
  projectDir: string
): ProgressionSummary | null {
  try {
    const ctx = readDriveContext(consortDir, featureId, projectDir);
    return {
      coarse_phase: ctx.phase,
      // A merged feature was necessarily deployed first, so merge implies deploy.
      deploy_done: Boolean(ctx.deploy?.deployed || ctx.promote?.merged),
      promote_done: Boolean(ctx.promote?.merged),
    };
  } catch {
    return null;
  }
}

export function getFeatureStatus(
  consortDir: string,
  featureId: string,
  projectDir: string = dirname(consortDir)
): FeatureStatusSnapshot {
  // Plans live per story now: one plan.json under each
  // features/<F>/stories/<story>/. Collect every story that has one.
  const plans: PlanStatusEntry[] = [];
  for (const storyId of listFeatureStories(consortDir, featureId)) {
    const p = readPlan(consortDir, featureId, storyId);
    if (p) plans.push({ story_id: storyId, plan: p });
  }

  // Experiments live under stories now: collect across every
  // story that has an experiments subtree.
  const experiments: ExperimentStatusEntry[] = [];
  for (const storyId of listExperimentStories(consortDir, featureId)) {
    for (const rec of listExperiments(consortDir, featureId, storyId)) {
      const outcomes = readOutcomes(consortDir, featureId, storyId, rec.experiment_slug);
      experiments.push({
        story_id: storyId,
        slug: rec.experiment_slug,
        branch_id: rec.branch_id,
        status: outcomes?.status ?? null,
        tests_passed: outcomes?.tests_passed ?? null,
        tests_failed: outcomes?.tests_failed ?? null,
        schema_diff_summary: outcomes?.schema_diff_summary ?? null,
        cycle_count: timelineCycleCount(rec.dir),
      });
    }
  }

  let smells: SmellsLog["detected"] = [];
  try {
    smells = readSmellsLog(consortDir).detected.filter((d) => !d.resolution);
  } catch {
    smells = [];
  }

  const { phase, pointer } = readWorkflowState(consortDir);
  const stories = summarizeStories(consortDir, featureId);

  return {
    feature_id: featureId,
    current_workflow_phase: phase,
    derived_phase: deriveFeaturePhase(stories),
    current_workflow_pointer: pointer,
    stories,
    plans,
    test_list: summarizeTestList(consortDir, featureId),
    experiments,
    selection_log_recent: readSelectionLogRecent(consortDir, MAX_RECENT_LOG_ENTRIES),
    open_smells: smells,
    gates: readGatesSummary(consortDir, featureId),
    progression: readProgression(consortDir, featureId, projectDir),
  };
}

function formatTestPassRatio(exp: ExperimentStatusEntry): string {
  if (exp.tests_passed === null && exp.tests_failed === null) {
    return "tests=n/a";
  }
  const passed = exp.tests_passed ?? 0;
  const failed = exp.tests_failed ?? 0;
  return `tests=${passed}/${passed + failed} pass`;
}

export function renderFeatureStatus(snapshot: FeatureStatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`Feature: ${snapshot.feature_id}`);

  {
    const ptr = snapshot.current_workflow_pointer;
    const focus =
      ptr?.feature_id === snapshot.feature_id
        ? " (active workflow)"
        : ptr?.feature_id
          ? ` (active workflow on ${ptr.feature_id})`
          : "";
    if (snapshot.derived_phase) {
      // The per-story pipeline is the source of truth for a per-story-driven
      // feature; the coarse workflow-state.json phase is not advanced per story,
      // so show the derived phase and note the workflow phase only when it lags.
      const coarse = snapshot.current_workflow_phase;
      const lag = coarse && coarse !== snapshot.derived_phase ? ` [workflow-state.json: ${coarse}]` : "";
      lines.push(`  Phase: ${snapshot.derived_phase}${focus}${lag}`);
    } else if (snapshot.current_workflow_phase) {
      lines.push(`  Phase: ${snapshot.current_workflow_phase}${focus}`);
    } else {
      lines.push(`  Phase: unknown (no workflow-state.json)`);
    }
  }

  if (snapshot.plans.length > 0) {
    for (const { story_id, plan } of snapshot.plans) {
      const plural = plan.strategies.length === 1 ? "y" : "ies";
      lines.push(
        `  Plan [${story_id}]: ${plan.mode} (N=${plan.N}, ${plan.strategies.length} strateg${plural})`
      );
    }
  } else {
    lines.push(`  Plan: not yet approved (design-spec gate pending)`);
  }

  if (snapshot.test_list) {
    const s = snapshot.test_list;
    const breakdown = (Object.entries(s.by_status) as [TestListStatus, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(" ");
    const done = s.by_status.green + s.by_status.refactored;
    lines.push(
      `  Test list: ${done}/${s.total} (${s.completion_pct}%)${breakdown ? `  [${breakdown}]` : ""}`
    );
  } else {
    lines.push(`  Test list: not yet written`);
  }

  if (snapshot.stories.length > 0) {
    const done = snapshot.stories.filter((s) => s.status === "done").length;
    lines.push(`  Stories: ${done}/${snapshot.stories.length} done`);
    for (const s of snapshot.stories) {
      const gate = s.gate_status ? ` gate=${s.gate_status}` : "";
      const acc = s.accepted ? " accepted" : "";
      lines.push(`    ${s.story_id.padEnd(28)} ${s.status}${gate}${acc}`);
    }
  }

  lines.push(``);
  if (snapshot.experiments.length > 0) {
    lines.push(`Experiments (${snapshot.experiments.length}):`);
    for (const exp of snapshot.experiments) {
      lines.push(
        `  ${exp.slug.padEnd(28)} branch=${exp.branch_id.padEnd(22)} status=${(exp.status ?? "unknown").padEnd(11)} ${formatTestPassRatio(exp)}  cycles=${exp.cycle_count}`
      );
    }
  } else {
    lines.push(`Experiments: none cut yet`);
  }

  if (snapshot.gates) {
    lines.push(``);
    lines.push(`Gates:`);
    for (const name of GATE_NAMES) {
      const g = snapshot.gates[name];
      // Overlay the drive engine's reconciliation onto the raw gates.json bit so a
      // deployed + merged feature reads done, not the stale `open` (Finding 13). The
      // ground truth is deploy-evidence / the SCM merge; only overlay when the raw
      // gate is still open (an explicit approval already renders itself).
      const p = snapshot.progression;
      if (name === "deploy" && g.status === "open" && p?.deploy_done) {
        lines.push(`  ${name.padEnd(10)} done (deployed)`);
        continue;
      }
      if (name === "promote" && g.status === "open" && p?.promote_done) {
        lines.push(`  ${name.padEnd(10)} done (merged)`);
        continue;
      }
      const when = g.approved_at ? ` @ ${g.approved_at}` : "";
      const by = g.approver ? ` by ${g.approver}` : "";
      lines.push(`  ${name.padEnd(10)} ${g.status}${when}${by}`);
    }
  }

  if (snapshot.selection_log_recent.length > 0) {
    lines.push(``);
    lines.push(`Recent decisions (${snapshot.selection_log_recent.length}):`);
    for (const entry of snapshot.selection_log_recent) {
      lines.push(`  ${entry.timestamp} – ${entry.title}`);
    }
  }

  lines.push(``);
  if (snapshot.open_smells.length > 0) {
    lines.push(`Open smells (${snapshot.open_smells.length}):`);
    for (const hit of snapshot.open_smells) {
      lines.push(`  ${hit.smell} – ${hit.detail}`);
    }
  } else {
    lines.push(`Open smells: none`);
  }

  return lines.join("\n") + "\n";
}
