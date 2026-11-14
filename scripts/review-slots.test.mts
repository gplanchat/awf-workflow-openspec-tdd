import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'review-slots.sh');
const work = mkdtempSync(join(tmpdir(), 'review-slots-'));
// The launcher may tune the queue (priority, dry run): these settings stay out of the tests.
for (const name of Object.keys(process.env)) if (/^TDD_(REVIEW_|DRY_RUN$)/.test(name)) delete process.env[name];
after(() => rmSync(work, { recursive: true, force: true }));

// Direct call of the script: `args` carries the subcommand and the command to run.
function slots(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: work,
    env: { ...process.env, XDG_RUNTIME_DIR: work, TDD_REVIEW_LEASE_POLL: '0.2', ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
const sh = (command: string) => ['bash', '-c', command];

// Review slots: `run` takes one per command, `lease-run` one per lease, returned here by `lease-end` after each call.
const modes = [
  { name: 'run', call: (command: string, env: Record<string, string>) => slots(['run', '--', ...sh(command)], env) },
  {
    name: 'lease-run',
    call: (command: string, env: Record<string, string>) => {
      const result = slots(['lease-run', '--', ...sh(command)], env);
      slots(['lease-end'], env);
      return result;
    },
  },
];

// Takes the `count` slots for `seconds`; returns the function that releases them.
function takeSlots(count: number, seconds: number) {
  const holders = Array.from({ length: count }, (_, i) =>
    spawn('bash', ['-c', `exec 9>"${join(work, `openspec-tdd-review-slot-${i + 1}.lock`)}"; flock -n 9 && exec sleep ${seconds}`], { stdio: 'ignore' }),
  );
  // Under load, the process may lag: wait until each lock is actually taken.
  for (let i = 1; i <= count; i++) {
    const lock = join(work, `openspec-tdd-review-slot-${i}.lock`);
    for (let n = 0; n < 100 && spawnSync('bash', ['-c', `exec 9>"${lock}"; flock -n 9`]).status === 0; n++) spawnSync('sleep', ['0.1']);
  }
  return () => holders.forEach((holder) => holder.kill());
}

for (const { name, call } of modes) {
  test(`slots (${name}): a free slot is taken and the command runs`, () => {
    const { status, output } = call('echo ok', {});

    assert.equal(status, 0);
    assert.match(output, /^ok$/m);
    assert.doesNotMatch(output, /waiting/);
  });

  test(`slots (${name}): all taken, the command waits then starts on release`, () => {
    const release = takeSlots(2, 3);
    try {
      const { status, output } = call('echo ok', { TDD_REVIEW_SLOT_STEP: '0.2' });

      assert.equal(status, 0);
      assert.match(output, /waiting for a slot/);
    } finally {
      release();
    }
  });

  test(`slots (${name}): timeout exceeded, code 13 naming the timeout and the setting`, () => {
    const release = takeSlots(2, 30);
    try {
      const { status, output } = call('echo ok', { TDD_REVIEW_SLOT_STEP: '0.2', TDD_REVIEW_SLOT_TIMEOUT: '1' });

      assert.equal(status, 13);
      assert.match(output, /after 1 s/);
      assert.match(output, /TDD_REVIEW_SLOTS/);
      assert.doesNotMatch(output, /^ok$/m);
    } finally {
      release();
    }
  });

  test(`slots (${name}): the slot is released after a failed command`, () => {
    assert.equal(call('exit 1', { TDD_REVIEW_SLOTS: '1' }).status, 1);
    assert.equal(call('echo ok', { TDD_REVIEW_SLOTS: '1', TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 0);
  });

  test(`slots (${name}): an invalid setting is wrong usage (code 2)`, () => {
    for (const value of ['0', '9', 'two']) {
      const { status, output } = call('echo ok', { TDD_REVIEW_SLOTS: value });

      assert.equal(status, 2);
      assert.match(output, /TDD_REVIEW_SLOTS/);
      assert.doesNotMatch(output, /^ok$/m);
    }
  });

  test(`slots (${name}): TDD_DRY_RUN takes none`, () => {
    const release = takeSlots(2, 30);
    try {
      assert.equal(call('echo ok', { TDD_DRY_RUN: '1', TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 0);
    } finally {
      release();
    }
  });

  test(`codes (${name}): a 13 from the command becomes 1 and the slot is released`, () => {
    assert.equal(call('exit 13', { TDD_REVIEW_SLOTS: '1' }).status, 1);
    assert.equal(call('echo ok', { TDD_REVIEW_SLOTS: '1', TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 0);
  });
}

// FIFO queue and lease: each test has its own runtime directory, under the test's work directory.
const sleepSync = (seconds: number) => spawnSync('sleep', [String(seconds)]);
function waitFor(condition: () => boolean, seconds = 15) {
  for (let n = 0; n < seconds * 10 && !condition(); n++) sleepSync(0.1);
  assert.ok(condition(), 'condition not met in time');
}
function runtime() {
  const dir = mkdtempSync(join(work, 'rt-'));
  return {
    dir,
    tickets: () => (existsSync(join(dir, 'openspec-tdd-review-queue')) ? spawnSync('bash', ['-c', `ls "${join(dir, 'openspec-tdd-review-queue')}"/*.ticket 2>/dev/null | wc -l`], { encoding: 'utf8' }).stdout.trim() : '0'),
    env: (extra: Record<string, string> = {}) => ({ XDG_RUNTIME_DIR: dir, TDD_REVIEW_SLOTS: '1', TDD_REVIEW_SLOT_STEP: '0.2', ...extra }),
  };
}
// Fake slot holder for `seconds`; kill() releases it at once.
function holdSlot(dir: string, i: number, seconds: number) {
  const lock = join(dir, `openspec-tdd-review-slot-${i}.lock`);
  const holder = spawn('bash', ['-c', `exec 9>"${lock}"; flock -n 9 && exec sleep ${seconds}`], { stdio: 'ignore' });
  waitFor(() => existsSync(lock) && spawnSync('bash', ['-c', `exec 9>"${lock}"; flock -n 9`]).status !== 0);
  return holder;
}
// Asynchronous `run` whose command writes its id to `log` when it starts.
function runAsync(rt: ReturnType<typeof runtime>, id: string, log: string, extra: Record<string, string> = {}) {
  const child = spawn('bash', [SCRIPT, 'run', '--', ...sh(`echo ${id} >> "${log}"; sleep 0.3`)], {
    cwd: work,
    stdio: 'ignore',
    env: { ...process.env, ...rt.env(extra) },
  });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, done };
}
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);

test('queue: three commands for one slot run in order of arrival', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  const holder = holdSlot(rt.dir, 1, 6);
  const runs = [];
  for (const [n, id] of ['A', 'B', 'C'].entries()) {
    runs.push(runAsync(rt, id, log));
    waitFor(() => rt.tickets() === String(n + 1));
  }
  holder.kill();
  assert.deepEqual(await Promise.all(runs.map((r) => r.done)), [0, 0, 0]);
  assert.deepEqual(lines(log), ['A', 'B', 'C']);
});

test('queue: a smaller priority overtakes an older call', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  const holder = holdSlot(rt.dir, 1, 6);
  const a = runAsync(rt, 'A', log);
  waitFor(() => rt.tickets() === '1');
  const b = runAsync(rt, 'B', log, { TDD_REVIEW_PRIORITY: '-1' });
  waitFor(() => rt.tickets() === '2');
  holder.kill();
  await Promise.all([a.done, b.done]);
  assert.deepEqual(lines(log), ['B', 'A']);
});

test('queue: a non-integer priority is wrong usage (code 2)', () => {
  const rt = runtime();
  const { status, output } = slots(['run', '--', ...sh('echo ok')], rt.env({ TDD_REVIEW_PRIORITY: 'high' }));
  assert.equal(status, 2);
  assert.match(output, /TDD_REVIEW_PRIORITY/);
  assert.equal(rt.tickets(), '0');
});

test('queue: the ticket of a killed call disappears and the next one moves up', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  const holder = holdSlot(rt.dir, 1, 6);
  const a = runAsync(rt, 'A', log);
  waitFor(() => rt.tickets() === '1');
  const b = runAsync(rt, 'B', log);
  waitFor(() => rt.tickets() === '2');
  process.kill(a.child.pid!, 'SIGKILL');
  holder.kill();
  assert.equal(await b.done, 0);
  assert.deepEqual(lines(log), ['B']);
  waitFor(() => rt.tickets() === '0');
});

test('queue: TDD_DRY_RUN drops no ticket', () => {
  const rt = runtime();
  assert.equal(slots(['run', '--', ...sh('echo ok')], rt.env({ TDD_DRY_RUN: '1' })).status, 0);
  assert.equal(existsSync(join(rt.dir, 'openspec-tdd-review-queue')), false);
});

test('queue: the holder\'s death releases the slot, the next call is served', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  const holder = holdSlot(rt.dir, 1, 30);
  const a = runAsync(rt, 'A', log);
  waitFor(() => rt.tickets() === '1');
  holder.kill('SIGKILL');
  assert.equal(await a.done, 0);
});

test('queue: the timeout counts once, the ticket is deleted and the code is 13', () => {
  const rt = runtime();
  const holder = holdSlot(rt.dir, 1, 30);
  try {
    const { status, output } = slots(['run', '--', ...sh('echo ok')], rt.env({ TDD_REVIEW_SLOT_TIMEOUT: '1' }));
    assert.equal(status, 13);
    assert.match(output, /after 1 s/);
    assert.equal(rt.tickets(), '0');
  } finally { holder.kill(); }
});

// Lease: `lease-run` around each tool of a pass, `lease-end` at the last tool or the first failure.
const lease = (rt: ReturnType<typeof runtime>, command: string, extra: Record<string, string> = {}, options: string[] = []) =>
  slots(['lease-run', ...options, '--', ...sh(command)], rt.env({ TDD_REVIEW_LEASE_IDLE: '30', ...extra }));
const leaseEnd = (rt: ReturnType<typeof runtime>) => slots(['lease-end'], rt.env());
const slotHeld = (rt: ReturnType<typeof runtime>) => spawnSync('bash', ['-c', `exec 9>>"${join(rt.dir, 'openspec-tdd-review-slot-1.lock')}"; flock -n 9`]).status !== 0;

test('lease: two consecutive lease-run keep the slot while a call waits, the release comes at lease-end', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  assert.equal(lease(rt, 'echo ok').status, 0);
  const waiter = runAsync(rt, 'W', log);
  waitFor(() => rt.tickets() === '1');
  // the second tool does not wait: a 1 s timeout would fail it if it went through the queue again
  assert.equal(lease(rt, 'echo ok', { TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 0);
  assert.deepEqual(lines(log), []);
  assert.equal(slotHeld(rt), true);
  assert.equal(lease(rt, 'echo ok', { TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 0);
  assert.equal(leaseEnd(rt).status, 0);
  assert.equal(await waiter.done, 0);
  assert.deepEqual(lines(log), ['W']);
});

test('lease: after a failed command, lease-end releases the slot', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  assert.equal(lease(rt, 'echo ok').status, 0);
  const waiter = runAsync(rt, 'W', log);
  waitFor(() => rt.tickets() === '1');
  assert.equal(lease(rt, 'exit 1').status, 1);
  leaseEnd(rt);
  assert.equal(await waiter.done, 0);
});

test('lease: with no new call, the guardian releases the slot on idle fallback', async () => {
  const rt = runtime(); const log = join(rt.dir, 'order.log');
  assert.equal(lease(rt, 'echo ok', { TDD_REVIEW_LEASE_IDLE: '1' }).status, 0);
  const waiter = runAsync(rt, 'W', log);
  assert.equal(await waiter.done, 0);
});

test('queue: empty queue, then held slot and waiting ticket, with nothing modified', async () => {
  const rt = runtime();
  const empty = slots(['queue'], rt.env({ TDD_REVIEW_SLOTS: '2' }));
  assert.equal(empty.status, 0);
  assert.match(empty.output, /1  free/);
  assert.match(empty.output, /empty/);
  const log = join(rt.dir, 'order.log');
  const holders = [holdSlot(rt.dir, 1, 8), holdSlot(rt.dir, 2, 8)];
  const waiter = runAsync(rt, 'W', log, { TDD_REVIEW_SLOTS: '2' });
  waitFor(() => rt.tickets() === '1');
  const busy = slots(['queue'], rt.env({ TDD_REVIEW_SLOTS: '2' }));
  assert.equal(busy.status, 0);
  assert.match(busy.output, /1  held/);
  assert.match(busy.output, /2  held/);
  assert.match(busy.output, /rank 1  priority 0/);
  assert.equal(rt.tickets(), '1');
  holders.forEach((h) => h.kill());
  assert.equal(await waiter.done, 0);
});

// Lease setup and teardown (design D6): --setup and --teardown log their calls, and so does the command.
function leaseLog(setupFails = false) {
  const rt = runtime();
  const log = join(rt.dir, 'calls.log');
  const options = ['--setup', `echo setup >> "${log}"${setupFails ? '; exit 7' : ''}`, '--teardown', `echo teardown >> "${log}"`];
  const tool = (command = 'true', extra: Record<string, string> = {}) => lease(rt, `echo tool >> "${log}"; ${command}`, extra, options);
  return { rt, tool, calls: () => lines(log) };
}
const count = (calls: string[], call: string) => calls.filter((c) => c === call).length;

test('lease setup: one for five tools, one teardown at lease-end, before the slot release', () => {
  const { rt, calls, tool } = leaseLog();
  for (let n = 0; n < 4; n++) assert.equal(tool().status, 0);
  assert.equal(count(calls(), 'setup'), 1);
  assert.equal(count(calls(), 'teardown'), 0);
  assert.equal(tool().status, 0);
  assert.equal(leaseEnd(rt).status, 0);
  assert.deepEqual(calls(), ['setup', 'tool', 'tool', 'tool', 'tool', 'tool', 'teardown']);
  assert.equal(slotHeld(rt), false);
});

test('lease setup: the first failure, followed by lease-end, runs the teardown', () => {
  const { rt, calls, tool } = leaseLog();
  assert.equal(tool('exit 1').status, 1);
  assert.equal(leaseEnd(rt).status, 0);
  assert.deepEqual(calls(), ['setup', 'tool', 'teardown']);
});

test('lease setup: with no new call, the teardown comes after TDD_REVIEW_LEASE_IDLE', () => {
  const { rt, calls, tool } = leaseLog();
  assert.equal(tool('true', { TDD_REVIEW_LEASE_IDLE: '1' }).status, 0);
  waitFor(() => count(calls(), 'teardown') === 1);
  waitFor(() => !slotHeld(rt));
});

test('lease setup: slot not obtained, code 13 and no setup', () => {
  const { rt, calls, tool } = leaseLog();
  const holder = holdSlot(rt.dir, 1, 8);
  try {
    assert.equal(tool('true', { TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 13);
    assert.deepEqual(calls(), []);
  } finally { holder.kill(); }
});

test('lease setup: on failure, slot released, code 50, no command, no guardian', () => {
  const { rt, calls, tool } = leaseLog(true);
  assert.equal(tool('true', { TDD_REVIEW_LEASE_IDLE: '1' }).status, 50);
  assert.equal(slotHeld(rt), false);
  sleepSync(2.5); // a guardian would have run the teardown after 1 s of idleness
  assert.deepEqual(calls(), ['setup']);
});

test('codes: a 50 from the lease-run command becomes 1, run passes it through', () => {
  const rt = runtime();
  assert.equal(lease(rt, 'exit 50').status, 1);
  leaseEnd(rt);
  assert.equal(slots(['run', '--', ...sh('exit 50')], rt.env()).status, 50);
});

// Reported wait (portes-preuves-et-perimetre, design D1): the file that TDD_REVIEW_WAIT_FILE names.
const waitFile = (rt: ReturnType<typeof runtime>) => join(rt.dir, 'wait');
const waited = (rt: ReturnType<typeof runtime>) => readFileSync(waitFile(rt), 'utf8').trim();

test('wait: free slot, run writes less than one second before running the command', () => {
  const rt = runtime();
  const { status, output } = slots(['run', '--', ...sh('cat "$TDD_REVIEW_WAIT_FILE"')], rt.env({ TDD_REVIEW_WAIT_FILE: waitFile(rt) }));
  assert.equal(status, 0);
  assert.match(output, /^0\.\d\d$/m); // the command already reads the duration
  assert.match(waited(rt), /^0\.\d\d$/);
});

test('wait: lease-run writes the duration before --setup, then 0 for the reused lease', () => {
  const rt = runtime(); const seen = join(rt.dir, 'seen');
  const env = { TDD_REVIEW_WAIT_FILE: waitFile(rt) };
  assert.equal(lease(rt, 'true', env, ['--setup', `cp "${waitFile(rt)}" "${seen}"`]).status, 0);
  assert.match(readFileSync(seen, 'utf8').trim(), /^0\.\d\d$/);
  assert.equal(lease(rt, 'true', env).status, 0);
  assert.equal(waited(rt), '0');
  leaseEnd(rt);
});

for (const sub of ['run', 'lease-run']) {
  test(`wait (${sub}): timeout exceeded, the file holds the wait duration and the code is 13`, () => {
    const rt = runtime();
    const holder = holdSlot(rt.dir, 1, 30);
    try {
      // the timeout counts in whole clock seconds: 2 s guarantee at least 1 s of actual wait
      const { status } = slots([sub, '--', ...sh('echo ok')], rt.env({ TDD_REVIEW_SLOT_TIMEOUT: '2', TDD_REVIEW_WAIT_FILE: waitFile(rt) }));
      assert.equal(status, 13);
      assert.match(waited(rt), /^\d+\.\d\d$/);
      assert.ok(Number(waited(rt)) >= 1, `wait of ${waited(rt)} s`);
    } finally { holder.kill(); }
  });
}

test('wait: without TDD_REVIEW_WAIT_FILE, no extra file', () => {
  const files = (dir: string) => spawnSync('bash', ['-c', `cd "${dir}" && find . | sort`], { encoding: 'utf8' }).stdout;
  const [bare, named] = [runtime(), runtime()];
  for (const rt of [bare, named]) {
    const env = rt === named ? { TDD_REVIEW_WAIT_FILE: waitFile(rt) } : {};
    assert.equal(slots(['run', '--', ...sh('true')], rt.env(env)).status, 0);
    assert.equal(lease(rt, 'true', env).status, 0);
    assert.equal(leaseEnd(rt).status, 0);
  }
  // the runtime directory with the variable differs from the other only by the wait file
  assert.equal(files(named.dir).replace('./wait\n', ''), files(bare.dir));
  assert.equal(existsSync(waitFile(bare)), false);
  assert.equal(existsSync(waitFile(named)), true);
});

test('lease: lease-end with no lease exits 0 with no marker, and the next lease stays held', () => {
  const rt = runtime();
  const marker = () => spawnSync('bash', ['-c', `ls "${rt.dir}"/openspec-tdd-review-end-* 2>/dev/null | wc -l`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(leaseEnd(rt).status, 0);
  assert.equal(marker(), '0');
  assert.equal(lease(rt, 'echo ok').status, 0);
  sleepSync(1); // several guardian rounds (TDD_REVIEW_LEASE_POLL at 0.2 s)
  assert.equal(slotHeld(rt), true);
  assert.equal(leaseEnd(rt).status, 0);
  assert.equal(slotHeld(rt), false);
});
