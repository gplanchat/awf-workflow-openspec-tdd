// Tasks of an OpenSpec change: the list of open tasks, classified, and the checking of a task.
//
//   openspec-tasks.sh list  <change>        JSON: [{id, text, group, kind, hexagon, rule}]
//   openspec-tasks.sh check <change> <id>   checks the line `- [ ] <id> ...` and no other
//   openspec-tasks.sh ids <change>          JSON: the numbers of the open tasks (for a workflow loop)
//   openspec-tasks.sh get <change> <id> <field>   the value of a field of an open task, without a trailing newline
//   openspec-tasks.sh verify-task <change> <id>   runs the "Verified by" command of the task: 0 it succeeds, 30 it fails, 31 "Manual" or no mention (the box stays open)
//   openspec-tasks.sh commit-task <change> <id>   commits the tree except .awf/status/ (feat(<change>): ... or docs(<change>): ..., 72 characters at most); nothing to commit, nothing happens
//   openspec-tasks.sh commit-slice <change> <id.n>   the same commit for a slice, checked or not: docs(<change>): ... for a `[docs]` slice, feat(<change>): ... otherwise
//   openspec-tasks.sh close-reviews <change> checks the review tasks still open
//   openspec-tasks.sh report <change> <done|failed>   writes .awf/status/apply-change.json (see apply-change.yaml)
//   openspec-tasks.sh batches <change> [--max-tasks N]   JSON: batches of open tasks, "seq:<id>" or "par:<id> <id>..."
//   openspec-tasks.sh task-report <change> <id> <done|failed|skipped>   writes .awf/status/apply-task.json (see apply-task.yaml)
//   openspec-tasks.sh dod <change>          JSON: the criteria of the "Definition of Done" section {id, text, command, done}
//   openspec-tasks.sh check-dod <change> <id>   checks the criterion `- [ ] <id> ...` and no other
//   openspec-tasks.sh verify-dod <change>   runs the commands of the open criteria, checks those that pass, stops at the first failure (code 30)
//   openspec-tasks.sh dod-snapshot <change>  records the open criteria before an agent step
//   openspec-tasks.sh dod-compare <change>   fails (30) if a criterion open in the snapshot is checked: only verify-dod checks
//   openspec-tasks.sh check-baseline <change>   fails (30) if the baseline of openspec/config.yaml is missing or differs in tasks.md
//   openspec-tasks.sh check-baseline|check-manual <change> --report-only   lists the gaps without failing (code 0)
//   openspec-tasks.sh check-manual <change>  fails (30) if a criterion without a command does not carry "Manual"
//   openspec-tasks.sh verify-dod <change> --replay   reruns the command of every criterion, checked ones included, without touching the boxes (code 30 at the first failure)
//   openspec-tasks.sh dod-fingerprint <change> [expected]   SHA-256 of the Definition of Done section; with an expected fingerprint, fails (30) if it differs
//   openspec-tasks.sh slices <change> <id>   JSON: the slices `  - [ ] <id>.<n> [<language>] text` of a task; fails on a code task without a slice and on a slice without a single language
//   openspec-tasks.sh next-slice <change> <id>   JSON: the first open slice of the task, or null
//   (slices and next-slice: for a change already in main, a code task without a slice becomes a single slice classified by the former rule, with a warning on stderr)
//   openspec-tasks.sh check-slice <change> <id.n>   checks the slice, and the task when all its slices are checked
//   openspec-tasks.sh languages             JSON: the registry .awf/languages.yaml {language: {workflow, dir, tests, mutation, commands}}, aliases resolved
//                                           (commands: test, review, report, red, strip, checks, last, review_steps, fingerprint_scope, proofs, suite_report, mutation_cmd,
//                                           green_setup, green_teardown, green_database_url, review_setup, review_teardown, review_database_url, budget, capture, models)
//   openspec-tasks.sh check-slices <change>  the same validation for every task of the change
//   openspec-tasks.sh record-run-tasks <change>   copies .awf/status/run-tasks.json (commands.sh run-tasks) into the apply-change tracking
//
// Parallel group: a group title that ends with "(parallel)" or "(parallèle)" (case and accents ignored)
// declares its tasks independent of each other. Batches are parallel only when --max-tasks is more than 1.

// The project folder is the current folder, or OPENSPEC_ROOT (tests).
//
// Kind and kind key of a task (the `hexagon` field, a key of .awf/languages.yaml), first rule that applies:
//   1. a task with a slice of a code language (its registry workflow is not free-task) -> slice, that language
//   2. text that starts with "REVIEW", after its tags -> review, the language whose keywords it cites most, or none
//      (the final review of apply-change covers it); a task that cites REVIEW elsewhere follows the next rules
//   3. [tooling] (French alias [outillage]) at the start or the end -> manual, stack; [stack] -> stack; [docs] -> docs
//   4. the `keywords` of a free kind (an entry whose workflow is free-task), in registry order -> manual, that kind
//   5. the `strong_keywords` of the languages: the most cited language -> slice
//   6. the `group_keywords` of the languages on the group title, in registry order -> slice
//   7. the `keywords` of the languages: the most cited language -> slice
//   8. otherwise, or on a tie between two languages at step 5 or 7 -> manual, docs
// Keywords are case-insensitive regular expressions; aliases have none of their own. Without a registry, only the
// built-in markers of steps 2 and 3 apply.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'slice' | 'review' | 'manual';
/** A key of the language registry (a language or a free kind such as docs), or empty for a REVIEW of no language. */
export type Hexagon = string;
export interface Task {
  readonly id: string;
  readonly text: string;
  readonly group: string;
  readonly kind: Kind;
  readonly hexagon: Hexagon;
  readonly rule: string;
  /** The title of its group ends with "(parallel)" or "(parallèle)". */
  readonly parallel: boolean;
}

/** Root of the errors of this script: each subclass names a problem and carries its context. */
export abstract class OpenspecTasksError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends OpenspecTasksError {
  public constructor() {
    super('Usage: openspec-tasks.sh list|ids|close-reviews|record-run-tasks|dod|verify-dod|check-deltas <change> | check-dod <change> <id> | batches <change> [--max-tasks N] | check <change> <id> | get <change> <id> <field> | report <change> <done|failed> | task-report <change> <id> <done|failed|skipped>.');
  }
}

export class InvalidMaxTasks extends OpenspecTasksError {
  public constructor() {
    super('The number of simultaneous tasks must be an integer greater than or equal to 1.');
  }
}

export class TasksFileUnreadable extends OpenspecTasksError {
  public readonly change: string;

  public constructor(change: string, options: ErrorOptions) {
    super('The tasks.md file of the change cannot be found or read. Check the change name and run the command from the project root.', options);
    this.change = change;
  }
}

export class TaskNotOpen extends OpenspecTasksError {
  public readonly change: string;
  public readonly id: string;

  public constructor(change: string, id: string) {
    super('No open task has this number in tasks.md: it does not exist or it is already checked.');
    this.change = change;
    this.id = id;
  }
}

export class CriterionNotOpen extends OpenspecTasksError {
  public readonly change: string;
  public readonly id: string;

  public constructor(change: string, id: string) {
    super('No open criterion has this number in the Definition of Done section: it does not exist or it is already checked.');
    this.change = change;
    this.id = id;
  }
}

/** A criterion of the Definition of Done failed: the raw output of its command is in review-last.txt. */
export class CriterionFailed extends OpenspecTasksError {
  public readonly change: string;
  public readonly id: string;

  public constructor(change: string, id: string) {
    super('The command of a Definition of Done criterion fails: fix what it reports above.');
    this.change = change;
    this.id = id;
  }
}

/** A Definition of Done gate stops the change: `ids` names the criteria at fault (exit code 30). */
export abstract class DodGateRefused extends OpenspecTasksError {
  public readonly change: string;
  public readonly ids: readonly string[];

  protected constructor(message: string, change: string, ids: readonly string[]) {
    super(message);
    this.change = change;
    this.ids = ids;
  }
}

export class CriterionCheckedByAgent extends DodGateRefused {
  public constructor(change: string, ids: readonly string[]) {
    super('An agent step checked Definition of Done criteria: only the verify-dod command or /flow:accept checks them. Uncheck them.', change, ids);
  }
}

export class BaselineBroken extends DodGateRefused {
  public constructor(change: string, ids: readonly string[]) {
    super('The Definition of Done baseline of openspec/config.yaml is missing or differs in tasks.md: copy its criteria and their commands.', change, ids);
  }
}

export class UndeclaredManualCriterion extends DodGateRefused {
  public constructor(change: string, ids: readonly string[]) {
    super('A criterion without a command must carry the "Manual" mention: add "Verified by: `command`" or the mention.', change, ids);
  }
}

/** A code task has no slice: the language is declared, not guessed. */
export class TaskWithoutSlices extends OpenspecTasksError {
  public readonly id: string;

  public constructor(id: string) {
    super('A code task must contain at least one slice `  - [ ] <number>.<n> [<language>] text`: add one under the task.');
    this.id = id;
  }
}

export class SliceWithoutLanguage extends OpenspecTasksError {
  public readonly id: string;

  public constructor(id: string) {
    super('A slice must declare its language in brackets at the start of its text, for example `[php]`.');
    this.id = id;
  }
}

export class SliceWithTwoLanguages extends OpenspecTasksError {
  public readonly id: string;

  public constructor(id: string) {
    super('A slice has a single language: split it into one slice per language, in application order.');
    this.id = id;
  }
}

/** The language of a slice is not a key of .awf/languages.yaml (exit code 2). */
export class UnknownLanguage extends OpenspecTasksError {
  public readonly id: string;
  public readonly language: string;
  public readonly known: readonly string[];

  public constructor(id: string, language: string, known: readonly string[]) {
    super('The language of a slice must be a key of .awf/languages.yaml: fix the slice or add the language to the registry.');
    this.id = id;
    this.language = language;
    this.known = known;
  }
}

/** .awf/languages.yaml is missing or does not have the expected shape. */
export class LanguagesRegistryUnreadable extends OpenspecTasksError {
  public constructor(options: ErrorOptions) {
    super('The registry .awf/languages.yaml cannot be found or read. Run the command from the project root.', options);
  }
}

/** The Definition of Done section changed since the fingerprint recorded at acceptance (exit code 30). */
export class DodFingerprintChanged extends OpenspecTasksError {
  public readonly change: string;
  public readonly expected: string;
  public readonly actual: string;

  public constructor(change: string, expected: string, actual: string) {
    super('The Definition of Done section changed since acceptance: restore it or ask for a waiver.');
    this.change = change;
    this.expected = expected;
    this.actual = actual;
  }
}

const PARALLEL_GROUP = /\(\s*(?:parallel|parallele)\s*\)\s*$/;

/** Does the title of a group declare its tasks parallel? */
export function isParallelGroup(title: string): boolean {
  return PARALLEL_GROUP.test(title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
}

/** "Verified by:" and its French alias "Vérifié par :", as a regular expression source. */
const VERIFIED_BY = '(?:Verified by:|Vérifié par :)';

const TASK_LINE = /^- \[( |x)\] (\d+\.\d+) (.*)$/;
const has = (text: string, pattern: RegExp): boolean => pattern.test(text);
const count = (text: string, pattern: RegExp): number => (text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? []).length;

/** A keyword of .awf/languages.yaml is not a valid regular expression. */
export class InvalidKeyword extends OpenspecTasksError {
  public readonly language: string;
  public readonly field: string;
  public readonly pattern: string;

  public constructor(language: string, field: string, pattern: string, options: ErrorOptions) {
    super('A keyword of .awf/languages.yaml is not a valid regular expression: fix it in the registry.', options);
    this.language = language;
    this.field = field;
    this.pattern = pattern;
  }
}

/** The keywords of one registry entry, compiled; aliases have none of their own. */
export interface KeywordEntry {
  readonly key: string;
  /** The entry's workflow is free-task: a task of this kind is manual. */
  readonly free: boolean;
  readonly strong: readonly RegExp[];
  readonly text: readonly RegExp[];
  readonly group: readonly RegExp[];
}

/** Keys of the registry that are aliases, with their target (`api: php`), read from the raw text. */
export function aliasTargets(content: string): Record<string, string> {
  const targets: Record<string, string> = {};
  let key: string | null = null;
  for (const line of content.split('\n')) {
    const top = /^([a-z0-9-]+):\s*$/.exec(line);
    if (top !== null) key = top[1] ?? null;
    const alias = /^ {2}alias:\s*'?([a-z0-9-]+)'?\s*$/.exec(line);
    if (alias !== null && key !== null) targets[key] = alias[1] ?? '';
  }
  return targets;
}

/** Compiles the keywords of the registry, in registry order, skipping the aliases (they would count twice). */
export function keywordEntries(registry: Record<string, Language>, aliases: Record<string, string>): KeywordEntry[] {
  const compile = (key: string, field: string, patterns: readonly string[]): RegExp[] => patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (cause) {
      throw new InvalidKeyword(key, field, pattern, { cause });
    }
  });
  return Object.entries(registry)
    .filter(([key]) => !(key in aliases))
    .map(([key, language]) => ({
      key,
      free: language.workflow === 'free-task',
      strong: compile(key, 'strong_keywords', language.strong_keywords),
      text: compile(key, 'keywords', language.keywords),
      group: compile(key, 'group_keywords', language.group_keywords),
    }));
}

/** The registry of the project, or null when the project has none (the built-in markers apply alone). */
interface Registry {
  readonly languages: Record<string, Language>;
  readonly aliases: Record<string, string>;
  readonly keywords: readonly KeywordEntry[];
}

let registryCache: Registry | null | undefined;

function projectRegistry(): Registry | null {
  if (registryCache !== undefined) return registryCache;
  const file = join(process.env.OPENSPEC_ROOT ?? process.cwd(), '.awf', 'languages.yaml');
  if (!existsSync(file)) return (registryCache = null);
  const content = readFileSync(file, 'utf8');
  const languages = parseLanguages(content);
  const aliases = aliasTargets(content);
  return (registryCache = { languages, aliases, keywords: keywordEntries(languages, aliases) });
}

/** The registry key a slice language stands for: the target of an alias, otherwise the key itself. */
function canonical(language: string): string {
  return projectRegistry()?.aliases[language] ?? language;
}

const score = (text: string, patterns: readonly RegExp[]): number => patterns.reduce((sum, pattern) => sum + count(text, pattern), 0);

/** The entry with the highest score, `tie` when two share it, null when none scores. */
function best(entries: readonly KeywordEntry[], scoreOf: (entry: KeywordEntry) => number): string | 'tie' | null {
  let top = 0;
  let winners: string[] = [];
  for (const entry of entries) {
    const value = scoreOf(entry);
    if (value > top) [top, winners] = [value, [entry.key]];
    else if (value === top && value > 0) winners.push(entry.key);
  }
  if (winners.length === 0) return null;
  return winners.length === 1 ? (winners[0] ?? null) : 'tie';
}

/**
 * Kind and kind key of a task, from its text and the title of its group. Built-in markers: REVIEW, [tooling], [stack],
 * [docs]. Then the keywords of the registry: free kinds (entries whose workflow is free-task) in registry order, then
 * the strong keywords of the languages, the group keywords, and the plain keywords; a tie between two languages, or no
 * match at all, gives a manual docs task.
 */
export function classify(text: string, group: string, entries: readonly KeywordEntry[] = projectRegistry()?.keywords ?? []): Pick<Task, 'kind' | 'hexagon' | 'rule'> {
  const languages = entries.filter((entry) => !entry.free);
  if (has(text, /^\s*(\[[^\]]+\]\s*)*REVIEW\b/)) {
    // A REVIEW without a language marker belongs to no language: the final review covers the touched ones.
    const winner = best(languages, (entry) => score(text, [...entry.strong, ...entry.text]));
    return { kind: 'review', hexagon: winner === null || winner === 'tie' ? '' : winner, rule: 'review' };
  }
  // `[tooling]` and its French alias `[outillage]` share the rule id `outillage`, read in the `rule` field.
  if (has(text, /^\s*\[(?:tooling|outillage)\]|\[(?:tooling|outillage)\]\s*$/i)) return { kind: 'manual', hexagon: 'stack', rule: 'outillage' };
  if (has(text, /^\s*\[stack\]/i)) return { kind: 'manual', hexagon: 'stack', rule: 'stack-tag' };
  if (has(text, /^\s*\[docs\]/i)) return { kind: 'manual', hexagon: 'docs', rule: 'docs-tag' };

  const free = entries.find((entry) => entry.free && entry.text.some((pattern) => has(text, pattern)));
  if (free !== undefined) return { kind: 'manual', hexagon: free.key, rule: `keywords:${free.key}` };

  const strong = best(languages, (entry) => score(text, entry.strong));
  if (strong === 'tie') return { kind: 'manual', hexagon: 'docs', rule: 'tie' };
  if (strong !== null) return { kind: 'slice', hexagon: strong, rule: `strong:${strong}` };

  const byGroup = languages.find((entry) => entry.group.some((pattern) => has(group, pattern)));
  if (byGroup !== undefined) return { kind: 'slice', hexagon: byGroup.key, rule: `group:${byGroup.key}` };

  const plain = best(languages, (entry) => score(text, entry.text));
  if (plain === 'tie') return { kind: 'manual', hexagon: 'docs', rule: 'tie' };
  if (plain !== null) return { kind: 'slice', hexagon: plain, rule: `keywords:${plain}` };
  return { kind: 'manual', hexagon: 'docs', rule: 'default' };
}

function tasksPath(change: string): string {
  return join(process.env.OPENSPEC_ROOT ?? process.cwd(), 'openspec', 'changes', change, 'tasks.md');
}

function read(change: string): string {
  try {
    return readFileSync(tasksPath(change), 'utf8');
  } catch (cause) {
    throw new TasksFileUnreadable(change, { cause });
  }
}

export function openTasks(content: string): Task[] {
  const tasks: Task[] = [];
  let group = '';
  let current: string | null = null;
  for (const line of content.split('\n')) {
    const heading = /^## (.*)$/.exec(line);
    if (heading !== null) {
      group = heading[1] ?? '';
      continue;
    }
    // A declared slice makes its open task a task with slices, whatever the text of the task.
    const slice = SLICE_LINE.exec(line);
    const last = tasks.length - 1;
    if (slice !== null && current !== null && tasks[last]?.id === current && tasks[last].kind !== 'review') {
      const language = /^\[([a-z0-9-]+)\]/.exec(slice[3] ?? '')?.[1] ?? '';
      // A slice makes its task a code task unless its language is a free kind (registry workflow free-task); an unknown
      // language counts as code, so that the slice workflow reports it. The first slice names the language.
      const entry = projectRegistry()?.languages[language];
      const code = language !== '' && entry?.workflow !== 'free-task';
      if (code && tasks[last].rule !== 'slices') tasks[last] = { ...tasks[last], kind: 'slice', hexagon: canonical(language), rule: 'slices' };
      continue;
    }
    const match = TASK_LINE.exec(line);
    if (match === null) continue;
    current = match[1] === ' ' ? (match[2] ?? '') : null;
    if (current === null) continue;
    const text = match[3] ?? '';
    tasks.push({ id: current, text, group, ...classify(text, group), parallel: isParallelGroup(group) });
  }
  return tasks;
}

export interface Slice {
  readonly id: string;
  readonly language: string;
  readonly text: string;
  readonly done: boolean;
  /** `[critical]` next to the language tag: the slice realises a critical scenario (critical_steps and required apply). */
  readonly critical?: boolean;
}

const SLICE_LINE = /^ {2}- \[( |x)\] (\d+\.\d+\.\d+) (.*)$/;
const LANGUAGE_TAGS = /^((?:\[[a-z0-9-]+\] ?)*)(.*)$/;

/** The slices of a task, checked or not. Validates the task: a code task has slices, each of a single language. */
export function slices(content: string, id: string, legacy = false): Slice[] {
  const found = parseSlices(content, id);
  if (found.length === 0) {
    const lines = content.split('\n');
    const start = lines.findIndex((line) => TASK_LINE.exec(line)?.[2] === id);
    let group = '';
    for (const line of lines.slice(0, start)) group = /^## (.*)$/.exec(line)?.[1] ?? group;
    const line = TASK_LINE.exec(lines[start] ?? '');
    const text = line?.[3] ?? '';
    const verdict = classify(text, group);
    if (verdict.kind === 'slice') {
      if (!legacy) throw new TaskWithoutSlices(id);
      // Former rule as a fallback: a single slice whose language is the classified hexagon (`api` and `pwa` are registry aliases).
      return [{ id, language: verdict.hexagon, text, done: line?.[1] === 'x' }];
    }
  }
  return found;
}

/** Warning printed when a task without a slice applies through the former classification rule. */
export function legacyWarning(id: string, language: string, rule: string): string {
  return `Warning: task ${id} has no slice; it applies as a single \`${language}\` slice, classified by the former rule "${rule}". Declare its slices.\n`;
}

function warnLegacy(content: string, id: string, found: readonly Slice[]): void {
  if (found.length !== 1 || found[0]?.id !== id) return;
  const lines = content.split('\n');
  const start = lines.findIndex((line) => TASK_LINE.exec(line)?.[2] === id);
  let group = '';
  for (const line of lines.slice(0, start)) group = /^## (.*)$/.exec(line)?.[1] ?? group;
  process.stderr.write(legacyWarning(id, found[0].language, classify(found[0].text, group).rule));
}

/** True when the tasks.md of the change is already in main: only these changes fall under the former rule. */
function mergedInMain(change: string): boolean {
  const root = process.env.OPENSPEC_ROOT ?? process.cwd();
  return spawnSync('git', ['cat-file', '-e', `main:openspec/changes/${change}/tasks.md`], { cwd: root }).status === 0;
}

function parseSlices(content: string, id: string): Slice[] {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => TASK_LINE.exec(line)?.[2] === id);
  if (start === -1) throw new TaskNotOpen('', id);
  const found: Slice[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = SLICE_LINE.exec(line);
    if (match === null) {
      if (line.startsWith('  ') || line.trim() === '') continue;
      break;
    }
    const sliceId = match[2] ?? '';
    const [, tags = '', text = ''] = LANGUAGE_TAGS.exec(match[3] ?? '') ?? [];
    const all = [...tags.matchAll(/\[([a-z0-9-]+)\]/g)].map((tag) => tag[1] ?? '');
    const languages = all.filter((tag) => tag !== 'critical');
    if (languages.length === 0) throw new SliceWithoutLanguage(sliceId);
    if (languages.length > 1) throw new SliceWithTwoLanguages(sliceId);
    found.push({ id: sliceId, language: languages[0] ?? '', text, done: match[1] === 'x', ...(all.includes('critical') ? { critical: true } : {}) });
  }
  return found;
}

/** Registry keys whose value is a command or a path; missing or empty, they are ''. */
const LANGUAGE_TEXTS = ['test', 'review', 'report', 'red', 'strip', 'last', 'suite_report', 'mutation_cmd', 'green_setup', 'green_teardown', 'green_database_url', 'review_setup', 'review_teardown', 'review_database_url', 'budget', 'capture', 'database_url_env', 'perf', 'perf_tolerance'] as const;
/** Registry keys whose value is a list; missing, they are []. */
const LANGUAGE_LISTS = ['tests', 'mutation', 'review_steps', 'fingerprint_scope', 'proofs', 'models', 'perf_benches', 'critical_steps', 'required', 'harness_paths', 'keywords', 'strong_keywords', 'group_keywords'] as const;

export type Language = {
  readonly workflow: string;
  readonly dir: string | null;
  /** Command of each `check` tool, by tool name. */
  readonly checks: Readonly<Record<string, string>>;
  /** Checks of merge-gate.sh, in order, when a merge into the main branch touches `dir`. */
  readonly merge_checks: Readonly<Record<string, string>>;
} & Readonly<Record<(typeof LANGUAGE_TEXTS)[number], string>> & Readonly<Record<(typeof LANGUAGE_LISTS)[number], readonly string[]>>;

type RawField = string | string[] | Record<string, string>;

/**
 * Reads the registry: top-level keys, fields at two spaces, `- value` lists or `key: value` tables at four,
 * inline lists `[a, b]`, single-quoted strings (`''` for a single quote). Aliases are resolved.
 */
export function parseLanguages(content: string): Record<string, Language> {
  const raw: Record<string, Record<string, RawField>> = {};
  let entry: Record<string, RawField> | null = null;
  let open: string | null = null;
  const unquote = (value: string): string => (/^'.*'$/.test(value) ? value.slice(1, -1).replaceAll('\'\'', '\'') : value);
  for (const line of content.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const top = /^([a-z0-9-]+):\s*$/.exec(line);
    const field = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
    const item = /^ {4}- (.*)$/.exec(line);
    const pair = /^ {4}([a-z0-9_-]+): (.*)$/.exec(line);
    if (top !== null) {
      entry = raw[top[1] ?? ''] = {};
      open = null;
    } else if (field !== null && entry !== null) {
      const name = field[1] ?? '';
      const value = (field[2] ?? '').trim();
      open = value === '' ? name : null;
      if (value === '') entry[name] = [];
      else if (/^\[.*\]$/.test(value)) entry[name] = value.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter((part) => part !== '');
      else entry[name] = unquote(value);
    } else if (entry !== null && open !== null && item !== null) {
      (entry[open] as string[]).push(unquote(item[1] ?? ''));
    } else if (entry !== null && open !== null && pair !== null) {
      const table = Array.isArray(entry[open]) ? (entry[open] = {}) : (entry[open] as Record<string, string>);
      table[pair[1] ?? ''] = unquote((pair[2] ?? '').trim());
    }
  }
  const resolved: Record<string, Language> = {};
  for (const [name, fields] of Object.entries(raw)) {
    // An alias takes every field of its target; its own fields (other than `alias`) override them.
    const { alias, ...own } = fields;
    const target = typeof alias === 'string' ? { ...(raw[alias] ?? {}), ...own } : fields;
    const text = (key: string): string => (typeof target[key] === 'string' ? target[key] : '');
    const list = (key: string): string[] => (Array.isArray(target[key]) ? target[key] : []);
    const checks = target.checks;
    const mergeChecks = target.merge_checks;
    resolved[name] = {
      workflow: text('workflow'),
      dir: typeof target.dir === 'string' ? target.dir : null,
      checks: typeof checks === 'object' && !Array.isArray(checks) ? checks : {},
      merge_checks: typeof mergeChecks === 'object' && !Array.isArray(mergeChecks) ? mergeChecks : {},
      ...(Object.fromEntries(LANGUAGE_TEXTS.map((key) => [key, text(key)])) as Record<(typeof LANGUAGE_TEXTS)[number], string>),
      ...(Object.fromEntries(LANGUAGE_LISTS.map((key) => [key, list(key)])) as Record<(typeof LANGUAGE_LISTS)[number], string[]>),
    };
  }
  return resolved;
}

export function readLanguages(): Record<string, Language> {
  try {
    return parseLanguages(readFileSync(join(process.env.OPENSPEC_ROOT ?? process.cwd(), '.awf', 'languages.yaml'), 'utf8'));
  } catch (cause) {
    throw new LanguagesRegistryUnreadable({ cause });
  }
}

/** Throws UnknownLanguage for the first slice whose language is not a registry key. */
export function assertKnownLanguages(found: readonly Slice[], registry: Record<string, Language>): void {
  const bad = found.find((slice) => !(slice.language in registry));
  if (bad !== undefined) throw new UnknownLanguage(bad.id, bad.language, Object.keys(registry));
}

/** The first open slice of a task: a rerun resumes where the previous one stopped. */
export function nextSlice(content: string, id: string, legacy = false): Slice | null {
  return slices(content, id, legacy).find((slice) => !slice.done) ?? null;
}

/** Checks the slice; checks the task when all its slices are checked. */
export function checkSlice(content: string, sliceId: string, change = ''): string {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`  - [ ] ${sliceId} `));
  if (index === -1) throw new TaskNotOpen(change, sliceId);
  lines[index] = (lines[index] ?? '').replace('- [ ] ', '- [x] ');
  const ticked = lines.join('\n');
  const taskId = sliceId.slice(0, sliceId.lastIndexOf('.'));
  const complete = slices(ticked, taskId).every((slice) => slice.done);
  return complete && ticked.split('\n').some((line) => line.startsWith(`- [ ] ${taskId} `)) ? checkTask(ticked, taskId, change) : ticked;
}

export function checkSlices(content: string, registry?: Record<string, Language>): void {
  for (const line of content.split('\n')) {
    const id = TASK_LINE.exec(line)?.[2];
    if (id === undefined) continue;
    const found = slices(content, id);
    if (registry !== undefined) assertKnownLanguages(found, registry);
  }
}

export function checkTask(content: string, id: string, change = ''): string {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`- [ ] ${id} `));
  if (index === -1) throw new TaskNotOpen(change, id);
  lines[index] = (lines[index] ?? '').replace('- [ ] ', '- [x] ');
  return lines.join('\n');
}

export interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly command: string | null;
  readonly done: boolean;
}

const DOD_HEADING = /^## Definition of Done\s*$/;
const CRITERION_LINE = new RegExp(`^- \\[( |x)\\] (D\\d+) (.*?)(?: ${VERIFIED_BY} \`(.*)\`)?\\s*$`);

/** Criteria of the "Definition of Done" section; D boxes outside this section are not criteria. */
export function criteria(content: string): Criterion[] {
  const found: Criterion[] = [];
  let inSection = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) inSection = DOD_HEADING.test(line);
    const match = inSection ? CRITERION_LINE.exec(line) : null;
    if (match !== null) found.push({ id: match[2] ?? '', text: match[3] ?? '', command: match[4] ?? null, done: match[1] === 'x' });
  }
  return found;
}

export function checkCriterion(content: string, id: string, change = ''): string {
  if (!criteria(content).some((criterion) => criterion.id === id && !criterion.done)) throw new CriterionNotOpen(change, id);
  return content.split('\n').map((line) => (line.startsWith(`- [ ] ${id} `) ? line.replace('- [ ] ', '- [x] ') : line)).join('\n');
}

/** Titles of the baseline line in openspec/config.yaml: the English one, then its French alias. */
const BASELINE_TITLES = ['Definition of Done baseline', 'Socle de la Definition of Done'] as const;

/** Criteria of the baseline set by openspec/config.yaml: id and expected commands (`<change>` replaced). */
export function baseline(config: string, change: string): Array<{ id: string; commands: string[] }> {
  const line = config.split('\n').find((candidate) => BASELINE_TITLES.some((title) => candidate.includes(title)));
  if (line === undefined) return [];
  const starts = [...line.matchAll(/(?<=[:;] )D(\d+) /g)];
  return starts.map((start, index) => {
    const segment = line.slice(start.index, starts[index + 1]?.index ?? line.length);
    const commands = [...segment.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replaceAll('<change>', change));
    return { id: `D${start[1]}`, commands };
  });
}

/** Baseline ids missing from tasks.md, without an expected command (at least one of the baseline commands), or with a different command. */
export function baselineGaps(config: string, content: string, change: string): string[] {
  const found = criteria(content);
  return baseline(config, change)
    .filter(({ id, commands }) => {
      const criterion = found.find((candidate) => candidate.id === id);
      if (criterion === undefined) return true;
      return commands.length > 0 && (criterion.command === null || !commands.some((command) => criterion.command?.includes(command)));
    })
    .map(({ id }) => id);
}

/** Criteria without a command that do not carry the "Manual" (or "Manuel") mention. */
export function undeclaredManual(list: readonly Criterion[]): Criterion[] {
  return list.filter((criterion) => criterion.command === null && !/\b(?:Manual|Manuel)\b/i.test(criterion.text));
}

/** Criteria open in `before` and checked in `after`. */
export function newlyChecked(before: readonly Criterion[], after: readonly Criterion[]): string[] {
  return after.filter((now) => now.done && before.some((was) => was.id === now.id && !was.done)).map((now) => now.id);
}

/** SHA-256 fingerprint of the text of the "Definition of Done" section (title included, up to the next title). */
export function dodFingerprint(content: string): string {
  const lines: string[] = [];
  let inSection = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) inSection = DOD_HEADING.test(line);
    if (inSection) lines.push(line);
  }
  return createHash('sha256').update(lines.join('\n').trimEnd()).digest('hex');
}

const snapshotFile = (): string => join(statusDir(), 'dod-snapshot.json');

/**
 * REVIEW phase of the Definition of Done: the commands of the open criteria run from the project root, in order;
 * each criterion that passes is checked on disk, the first one that fails stops everything (raw output in
 * review-last.txt, as for tdd-gate.sh). Criteria without a command stay open and are named.
 */
export function verifyDod(change: string, replay = false): string {
  const root = process.env.OPENSPEC_ROOT ?? process.cwd();
  const dir = statusDir();
  const record = (checked: string[], failed: string | null): void => {
    const manual = criteria(read(change)).filter((criterion) => !criterion.done && criterion.command === null).map((criterion) => criterion.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dod.json'), `${JSON.stringify({ checked, failed, manual })}\n`);
  };
  if (criteria(read(change)).length === 0) return 'No Definition of Done criterion.\n';
  const checked: string[] = [];
  let out = '';
  for (const criterion of criteria(read(change))) {
    if ((criterion.done && !replay) || criterion.command === null) continue;
    const result = spawnSync('bash', ['-c', criterion.command], { cwd: root, encoding: 'utf8' });
    const raw = `${result.stdout}${result.stderr}\nCriterion ${criterion.id} failed: ${criterion.text}\n`;
    if (result.status !== 0) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'review-last.txt'), raw);
      writeFileSync(join(dir, 'tdd-slice.json'), `${JSON.stringify({ phase: 'review', code: 30, message: `criterion ${criterion.id} failed` })}\n`);
      record(checked, criterion.id);
      process.stdout.write(out);
      process.stderr.write(raw);
      throw new CriterionFailed(change, criterion.id);
    }
    if (replay) {
      checked.push(criterion.id);
      out += `Criterion ${criterion.id} replayed: the command passes.\n`;
      continue;
    }
    writeFileSync(tasksPath(change), checkCriterion(read(change), criterion.id, change));
    checked.push(criterion.id);
    out += `Criterion ${criterion.id} checked.\n`;
  }
  if (!replay) record(checked, null);
  const manual = criteria(read(change)).filter((criterion) => !criterion.done && criterion.command === null).map((criterion) => criterion.id);
  return manual.length === 0 ? out : `${out}Criteria to check by hand: ${manual.join(' ')}.\n`;
}

export interface LongRequirement {
  readonly title: string;
  readonly length: number;
}

/** Requirements of a delta exceed the length the OpenSpec validator tolerates in a main spec. */
export class DeltaRequirementTooLong extends OpenspecTasksError {
  public readonly change: string;
  public readonly requirements: readonly (LongRequirement & { readonly spec: string })[];

  public constructor(change: string, requirements: readonly (LongRequirement & { readonly spec: string })[]) {
    super('A delta adds or modifies a requirement longer than 500 characters. Keep the normative sentence in the requirement and move the detail into scenarios.');
    this.change = change;
    this.requirements = requirements;
  }
}

/** Length beyond which `openspec validate --specs --strict` reports a requirement (the text, scenarios excluded). */
export const MAX_REQUIREMENT_LENGTH = 500;

/** The `ADDED` or `MODIFIED` requirements of a delta whose text, from the title to the first scenario, exceeds the threshold. */
export function longRequirements(delta: string): LongRequirement[] {
  const found: LongRequirement[] = [];
  let checked = false;
  let current: { title: string; lines: string[] } | null = null;
  const close = (): void => {
    const length = current === null ? 0 : current.lines.join('\n').trim().length;
    if (current !== null && length > MAX_REQUIREMENT_LENGTH) found.push({ title: current.title, length });
    current = null;
  };
  for (const line of delta.split('\n')) {
    if (line.startsWith('## ')) {
      close();
      checked = /^## (ADDED|MODIFIED) Requirements\s*$/.test(line);
    } else if (line.startsWith('### Requirement:')) {
      close();
      current = checked ? { title: line.slice('### Requirement:'.length).trim(), lines: [] } : null;
    } else if (line.startsWith('#### Scenario') || line.startsWith('### ')) {
      close();
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  close();
  return found;
}

/** Checks the `specs/<capability>/spec.md` deltas of a change; a change without `specs/` has nothing to check. */
export function checkDeltas(change: string): string {
  const specs = join(process.env.OPENSPEC_ROOT ?? process.cwd(), 'openspec', 'changes', change, 'specs');
  if (!existsSync(specs)) return 'No spec delta to check.\n';
  const tooLong = readdirSync(specs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(specs, entry.name, 'spec.md')))
    .flatMap((entry) => longRequirements(readFileSync(join(specs, entry.name, 'spec.md'), 'utf8')).map((requirement) => ({ spec: entry.name, ...requirement })));
  if (tooLong.length > 0) throw new DeltaRequirementTooLong(change, tooLong);
  return 'No delta requirement exceeds 500 characters.\n';
}

/** The command of the last "Verified by: `command`" (or "Vérifié par : `command`") mention of a task line, or null. */
export function verifyCommand(text: string): string | null {
  return new RegExp(`^.*${VERIFIED_BY} \`(.*)\`\\s*$`).exec(text)?.[1] ?? null;
}

/** The task has no command to run ("Manual" or no mention): a person checks it. */
export class TaskVerificationManual extends OpenspecTasksError {
  public constructor() {
    super('The task has no "Verified by" command: a person verifies and checks it.');
  }
}

/** The "Verified by" command of a task fails: the box stays open. */
export class TaskVerificationFailed extends OpenspecTasksError {
  public constructor() {
    super('The "Verified by" command of the task fails: fix what it reports above.');
  }
}

export function verifyTask(change: string, id: string): string {
  // The agent of the task sometimes checks its own box: the task is looked up as if it were open.
  const task = openTasks(read(change).replace(/^- \[x\] /gm, '- [ ] ')).find((candidate) => candidate.id === id);
  if (task === undefined) throw new TaskNotOpen(change, id);
  const command = verifyCommand(task.text);
  if (command === null) throw new TaskVerificationManual();
  const result = spawnSync('bash', ['-c', command], { cwd: process.env.OPENSPEC_ROOT ?? process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new TaskVerificationFailed();
  }
  return `Task ${id} verified: the command succeeds.\n`;
}

/** A git call fails while committing a task. */
export class TaskCommitFailed extends OpenspecTasksError {
  public constructor(options?: ErrorOptions) {
    super('The commit of the task fails: read the git output above.', options);
  }
}

/** No slice has this number in tasks.md, checked or not. */
export class UnknownSlice extends OpenspecTasksError {
  public readonly change: string;
  public readonly id: string;

  public constructor(change: string, id: string) {
    super('No slice has this number in tasks.md: check the number, of the form <task>.<n>.');
    this.change = change;
    this.id = id;
  }
}

const COMMIT_MAX = 72;

/** Commit message of a task: type from the hexagon, text without tags or "Verified by", 72 characters at most. */
export function commitMessage(change: string, task: Pick<Task, 'text' | 'hexagon'>): string {
  return commitSubject(task.hexagon === 'docs' ? 'docs' : 'feat', change, task.text);
}

function commitSubject(type: 'docs' | 'feat', change: string, raw: string): string {
  const prefix = `${type}(${change}): `;
  const text = raw.replace(/^(\s*\[[a-z0-9-]+\])+\s*/i, '').replace(new RegExp(`\\s*${VERIFIED_BY} .*$`), '');
  const room = COMMIT_MAX - prefix.length;
  return prefix + (text.length <= room ? text : `${text.slice(0, room - 3).trimEnd()}...`);
}

export function commitTask(change: string, id: string): string {
  // The task is already checked at this point: it is looked up as if it were open.
  const task = openTasks(read(change).replace(/^- \[x\] /gm, '- [ ] ')).find((candidate) => candidate.id === id);
  if (task === undefined) throw new TaskNotOpen(change, id);
  return commitTree(`Task ${id}`, commitMessage(change, task));
}

/** Commit of a slice, checked or not: the box of the task, checked with its last slice, goes in. */
export function commitSlice(change: string, sliceId: string): string {
  const content = read(change);
  const taskId = sliceId.slice(0, Math.max(0, sliceId.lastIndexOf('.')));
  const known = content.split('\n').some((line) => TASK_LINE.exec(line)?.[2] === taskId);
  const slice = known ? parseSlices(content, taskId).find((candidate) => candidate.id === sliceId) : undefined;
  if (slice === undefined) throw new UnknownSlice(change, sliceId);
  return commitTree(`Slice ${sliceId}`, commitSubject(slice.language === 'docs' ? 'docs' : 'feat', change, slice.text));
}

/** Commits the whole tree except .awf/status/; nothing to commit, nothing happens. */
function commitTree(label: string, message: string): string {
  const cwd = process.env.OPENSPEC_ROOT ?? process.cwd();
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error !== undefined) throw new TaskCommitFailed({ cause: result.error });
    return result;
  };
  const failed = (result: ReturnType<typeof git>) => {
    process.stderr.write(result.stderr);
    return new TaskCommitFailed();
  };
  // `git add` fails on an ignored path cited in the pathspec (even as an exclusion): add everything, then remove .awf/status/ from the index.
  const added = git('add', '-A');
  if (added.status !== 0) throw failed(added);
  git('reset', '-q', '--', '.awf/status');
  if (git('diff', '--cached', '--quiet').status === 0) return `${label}: no change to commit.\n`;
  const committed = git('commit', '-m', message);
  if (committed.status !== 0) throw failed(committed);
  return `${label} committed: ${message}\n`;
}

export class UnknownField extends OpenspecTasksError {
  public constructor() {
    super('This field does not exist. Possible fields: id, text, group, kind, hexagon, rule, parallel, verify.');
  }
}

const FIELDS = ['id', 'text', 'group', 'kind', 'hexagon', 'rule', 'parallel'] as const;

/**
 * Batches of open tasks, in order. A parallel group gives a "par:" batch of its code or manual tasks when several
 * tasks can run at the same time (maxTasks > 1 and at least two tasks); any other task, a REVIEW included, is a
 * "seq:" batch of one task.
 */
export function batches(tasks: readonly Task[], maxTasks: number): string[] {
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new InvalidMaxTasks();
  const lots: string[] = [];
  const parallelSlot = new Map<string, number>();
  for (const task of tasks) {
    const eligible = maxTasks > 1 && task.parallel && task.kind !== 'review' && tasks.filter((other) => other.group === task.group && other.kind !== 'review').length > 1;
    if (!eligible) {
      lots.push(`seq:${task.id}`);
      continue;
    }
    const slot = parallelSlot.get(task.group);
    if (slot === undefined) {
      parallelSlot.set(task.group, lots.length);
      lots.push(`par:${task.id}`);
    } else {
      lots[slot] = `${lots[slot] ?? ''} ${task.id}`;
    }
  }
  return lots;
}

export function closeReviews(content: string): { content: string; ids: string[] } {
  const ids = openTasks(content).filter((task) => task.kind === 'review').map((task) => task.id);
  return { content: ids.reduce((text, id) => checkTask(text, id), content), ids };
}

function statusDir(): string {
  return process.env.OPENSPEC_STATUS_DIR ?? join(process.env.OPENSPEC_ROOT ?? process.cwd(), '.awf', 'status');
}

function readOptional(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * The apply-change report: tasks checked during this run (apply-change.done, one per line), current task
 * (apply-change.current) and failed phase, read from the status of the last gate (tdd-slice.json).
 */
export function report(change: string, status: 'done' | 'failed'): string {
  const dir = statusDir();
  const done = (readOptional(join(dir, 'apply-change.done')) ?? '').split('\n').filter((line) => line !== '');
  let failed: { id: string; phase: string | null; status: number | null } | null = null;
  if (status === 'failed') {
    const gate = readOptional(join(dir, 'tdd-slice.json'));
    const parsed = gate === null ? null : (JSON.parse(gate) as { phase?: string; code?: number });
    failed = {
      id: (readOptional(join(dir, 'apply-change.current')) ?? '').trim(),
      phase: parsed?.phase ?? null,
      status: parsed?.code ?? null,
    };
  }
  mkdirSync(dir, { recursive: true });
  const dod = readOptional(join(dir, 'dod.json'));
  const body = `${JSON.stringify({ change, done, failed, status, ...(dod === null ? {} : { dod: JSON.parse(dod) as unknown }) })}\n`;
  writeFileSync(join(dir, 'apply-change.json'), body);
  return body;
}

interface Gate {
  phase?: string;
  code?: number;
}

function lastGate(dir: string): Gate | null {
  const gate = readOptional(join(dir, 'tdd-slice.json'));
  return gate === null ? null : (JSON.parse(gate) as Gate);
}

/** The apply-task report: a single task, in its own worktree (.awf/status/apply-task.json). */
export function taskReport(change: string, id: string, status: 'done' | 'failed' | 'skipped'): string {
  const dir = statusDir();
  const gate = status === 'failed' ? lastGate(dir) : null;
  const failed = status === 'failed' ? { phase: gate?.phase ?? null, status: gate?.code ?? null } : null;
  const found = parseSlices(read(change), id);
  // Slices appear in the report only when the task has some; the first open one carries the failure, the next ones stay pending.
  const firstOpen = found.findIndex((slice) => !slice.done);
  const perSlice = found.map((slice, index) => ({
    id: slice.id,
    language: slice.language,
    status: slice.done ? 'done' : index === firstOpen && failed !== null ? 'failed' : 'pending',
    failed: !slice.done && index === firstOpen ? failed : null,
  }));
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify({ change, task: id, status, failed, ...(found.length === 0 ? {} : { slices: perSlice }) })}\n`;
  writeFileSync(join(dir, 'apply-task.json'), body);
  return body;
}

interface RunTasks {
  tasks?: Record<string, { status?: string; merged?: boolean }>;
}

/**
 * Copies the report of `commands.sh run-tasks`: the merged tasks join the list of done tasks, and the first failed
 * task becomes the current task (the failure report names it, with the "parallel" phase).
 */
export function recordRunTasks(): string {
  const dir = statusDir();
  const text = readOptional(join(dir, 'run-tasks.json'));
  if (text === null) return 'No run-tasks report.\n';
  const tasks = (JSON.parse(text) as RunTasks).tasks ?? {};
  const merged = Object.entries(tasks).filter(([, task]) => task.merged === true).map(([id]) => id);
  const failed = Object.entries(tasks).find(([, task]) => task.status !== 'done' || task.merged !== true)?.[0];
  mkdirSync(dir, { recursive: true });
  if (merged.length > 0) writeFileSync(join(dir, 'apply-change.done'), `${[...(readOptional(join(dir, 'apply-change.done')) ?? '').split('\n').filter((line) => line !== ''), ...merged].join('\n')}\n`);
  if (failed !== undefined) {
    writeFileSync(join(dir, 'apply-change.current'), `${failed}\n`);
    writeFileSync(join(dir, 'tdd-slice.json'), `${JSON.stringify({ phase: 'parallel', code: null, message: 'parallel task failed or not merged' })}\n`);
  }
  return `Parallel tasks merged: ${merged.join(' ') || 'none'}.\n`;
}

function maxTasksOption(rest: readonly (string | undefined)[]): number {
  const [flag, value] = rest;
  if (flag === undefined) return 1;
  if (flag !== '--max-tasks' || value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new InvalidMaxTasks();
  return Number(value);
}

/** Option of check-baseline and check-manual: lists the gaps and returns 0, to measure a hardening before enabling it. */
const REPORT_ONLY = '--report-only';

export function run(argv: string[]): string {
  const [command, change, id, field] = argv;
  if (command === 'languages' && change === undefined) return `${JSON.stringify(readLanguages())}\n`;
  if (change === undefined) throw new UsageError();
  if (command === 'list' && id === undefined) return `${JSON.stringify(openTasks(read(change)))}\n`;
  if (command === 'ids' && id === undefined) return `${JSON.stringify(openTasks(read(change)).map((task) => task.id))}\n`;
  if (command === 'check' && id !== undefined && field === undefined) {
    const content = read(change);
    // A task the agent checked itself stays checked: the workflow's marking must not fail the run.
    if (content.split('\n').some((line) => line.startsWith(`- [x] ${id} `))) return `Task ${id} already checked.\n`;
    writeFileSync(tasksPath(change), checkTask(content, id, change));
    return `Task ${id} checked.\n`;
  }
  if (command === 'slices' && id !== undefined && field === undefined) {
    const found = slices(read(change), id, mergedInMain(change));
    assertKnownLanguages(found, readLanguages());
    warnLegacy(read(change), id, found);
    return `${JSON.stringify(found)}\n`;
  }
  if (command === 'next-slice' && id !== undefined && field === undefined) {
    const found = slices(read(change), id, mergedInMain(change));
    assertKnownLanguages(found, readLanguages());
    warnLegacy(read(change), id, found);
    return `${JSON.stringify(nextSlice(read(change), id, mergedInMain(change)))}\n`;
  }
  if (command === 'check-slice' && id !== undefined && field === undefined) {
    writeFileSync(tasksPath(change), checkSlice(read(change), id, change));
    return `Slice ${id} checked.\n`;
  }
  if (command === 'check-slices' && id === undefined) {
    checkSlices(read(change), readLanguages());
    return 'Every code task has its slices, each of a single language.\n';
  }
  if (command === 'verify-task' && id !== undefined && field === undefined) return verifyTask(change, id);
  if (command === 'commit-task' && id !== undefined && field === undefined) return commitTask(change, id);
  if (command === 'commit-slice' && id !== undefined && field === undefined) return commitSlice(change, id);
  if (command === 'get' && id !== undefined && field === 'verify') {
    const task = openTasks(read(change)).find((candidate) => candidate.id === id);
    if (task === undefined) throw new TaskNotOpen(change, id);
    return verifyCommand(task.text) ?? '';
  }
  if (command === 'get' && id !== undefined && field !== undefined) {
    if (!(FIELDS as readonly string[]).includes(field)) throw new UnknownField();
    const task = openTasks(read(change)).find((candidate) => candidate.id === id);
    if (task === undefined) throw new TaskNotOpen(change, id);
    // No trailing newline: AWF passes the output of a step as is into the inputs of a sub-workflow.
    return String(task[field as (typeof FIELDS)[number]]);
  }
  if (command === 'close-reviews' && id === undefined) {
    const closed = closeReviews(read(change));
    writeFileSync(tasksPath(change), closed.content);
    return `Review tasks checked: ${closed.ids.join(' ') || 'none'}.\n`;
  }
  if (command === 'dod' && id === undefined) return `${JSON.stringify(criteria(read(change)))}\n`;
  if (command === 'check-dod' && id !== undefined && field === undefined) {
    writeFileSync(tasksPath(change), checkCriterion(read(change), id, change));
    return `Criterion ${id} checked.\n`;
  }
  if (command === 'verify-dod' && id === undefined) return verifyDod(change);
  if (command === 'verify-dod' && id === '--replay' && field === undefined) return verifyDod(change, true);
  if (command === 'dod-fingerprint' && field === undefined) {
    const actual = dodFingerprint(read(change));
    if (id !== undefined && id !== actual) throw new DodFingerprintChanged(change, id, actual);
    return `${actual}\n`;
  }
  if (command === 'dod-snapshot' && id === undefined) {
    mkdirSync(statusDir(), { recursive: true });
    writeFileSync(snapshotFile(), `${JSON.stringify(criteria(read(change)))}\n`);
    return 'Criteria recorded before the agent step.\n';
  }
  if (command === 'dod-compare' && id === undefined) {
    const before = JSON.parse(readFileSync(snapshotFile(), 'utf8')) as Criterion[];
    const ids = newlyChecked(before, criteria(read(change)));
    if (ids.length > 0) throw new CriterionCheckedByAgent(change, ids);
    return 'No criterion checked during the agent step.\n';
  }
  if (command === 'check-baseline' && (id === undefined || id === REPORT_ONLY) && field === undefined) {
    const ids = baselineGaps(readFileSync(join(process.env.OPENSPEC_ROOT ?? process.cwd(), 'openspec', 'config.yaml'), 'utf8'), read(change), change);
    if (ids.length > 0 && id === REPORT_ONLY) return `Definition of Done baseline: gaps ${ids.join(' ')}.\n`;
    if (ids.length > 0) throw new BaselineBroken(change, ids);
    return 'The Definition of Done baseline is met.\n';
  }
  if (command === 'check-manual' && (id === undefined || id === REPORT_ONLY) && field === undefined) {
    const ids = undeclaredManual(criteria(read(change))).map((criterion) => criterion.id);
    if (ids.length > 0 && id === REPORT_ONLY) return `Criteria without a command or "Manual": ${ids.join(' ')}.\n`;
    if (ids.length > 0) throw new UndeclaredManualCriterion(change, ids);
    return 'Every criterion without a command carries the "Manual" mention.\n';
  }
  if (command === 'check-deltas' && id === undefined) return checkDeltas(change);
  if (command === 'report' && (id === 'done' || id === 'failed') && field === undefined) return report(change, id);
  if (command === 'batches') return `${JSON.stringify(batches(openTasks(read(change)), maxTasksOption(argv.slice(2))))}\n`;
  if (command === 'task-report' && id !== undefined && (field === 'done' || field === 'failed' || field === 'skipped')) return taskReport(change, id, field);
  if (command === 'record-run-tasks' && id === undefined) return recordRunTasks();
  throw new UsageError();
}

if (import.meta.main) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof CriterionFailed || error instanceof TaskVerificationFailed) {
      process.exit(30);
    } else if (error instanceof TaskVerificationManual) {
      process.stderr.write(`${error.message}\n`);
      process.exit(31);
    } else if (error instanceof DodFingerprintChanged) {
      process.stderr.write(`${error.message} Change: ${error.change}, recorded fingerprint: ${error.expected}, current fingerprint: ${error.actual}.\n`);
      process.exit(30);
    } else if (error instanceof DodGateRefused) {
      process.stderr.write(`${error.message} Change: ${error.change}, criteria: ${error.ids.join(' ')}.\n`);
      process.exit(30);
    } else if (error instanceof CriterionNotOpen) {
      process.stderr.write(`${error.message} Change: ${error.change}, criterion: ${error.id}.\n`);
    } else if (error instanceof TaskWithoutSlices || error instanceof SliceWithoutLanguage || error instanceof SliceWithTwoLanguages) {
      process.stderr.write(`${error.message} Number: ${error.id}.\n`);
    } else if (error instanceof UnknownLanguage) {
      process.stderr.write(`${error.message} Slice: ${error.id}, language: ${error.language}, known languages: ${error.known.join(', ')}.\n`);
    } else if (error instanceof UnknownSlice) {
      process.stderr.write(`${error.message} Change: ${error.change}, slice: ${error.id}.\n`);
    } else if (error instanceof TaskNotOpen) {
      process.stderr.write(`${error.message} Change: ${error.change}, task: ${error.id}.\n`);
    } else if (error instanceof DeltaRequirementTooLong) {
      process.stderr.write(`${error.message} Change: ${error.change}.\n${error.requirements.map((r) => `  ${r.spec}: "${r.title}" (${r.length} characters)\n`).join('')}`);
    } else if (error instanceof TasksFileUnreadable) {
      process.stderr.write(`${error.message} Change: ${error.change}.\n`);
    } else if (error instanceof OpenspecTasksError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      throw error;
    }
    process.exit(error instanceof UsageError || error instanceof UnknownLanguage ? 2 : 1);
  }
}
