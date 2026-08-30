"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdtemp, realpath, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const execute = promisify(execFile);

async function repository(context, { version = "1.2.3", tagged = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tonies-release-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args) => (await execute("git", args, { cwd: directory })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Release Test");
  await git("config", "user.email", "release@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify({ name: "test", version, repository: { url: "git+https://github.com/kamilio/tonies-homey.git" }, dependencies: { preserved: "1.0.0" } })),
    writeFile(join(directory, "package-lock.json"), JSON.stringify({ version, lockfileVersion: 3, packages: { "": { version }, "node_modules/preserved": { version: "1.0.0" } } })),
    writeFile(join(directory, "app.json"), JSON.stringify({ version, id: "com.kjopek.tonies" })),
    writeFile(join(directory, ".homeychangelog.json"), JSON.stringify({ [version]: { en: "Existing release" } })),
    writeFile(join(directory, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n\nExisting release\n`)
  ]);
  await git("add", ".");
  await git("commit", "-m", "chore: initial fixture");
  if (tagged) await git("tag", `v${version}`);
  const commit = async (subject, body) => {
    await writeFile(join(directory, "change.txt"), subject);
    await git("add", "change.txt");
    await git("commit", "-m", subject, ...(body ? ["-m", body] : []));
  };
  const { release } = await import("../scripts/release.mjs");
  return { directory, git, commit, release: options => release({ directory, log: () => {}, ...options }) };
}

for (const [subject, body, expected, bump] of [
  ["fix(auth): renew credentials", undefined, "1.2.4", "patch"],
  ["perf: reduce state writes", undefined, "1.2.4", "patch"],
  ["feat(night): add bedtime Flow", undefined, "1.3.0", "minor"],
  ["feat!: remove obsolete controls", undefined, "2.0.0", "major"],
  ["fix(auth): change credentials", "BREAKING CHANGE: a new account format is required", "2.0.0", "major"]
]) test(`release derives ${bump} from ${subject}`, async context => {
  const setup = await repository(context);
  await setup.commit(subject, body);
  const result = await setup.release({ "dry-run": true });
  assert.equal(result.version, expected);
  assert.equal(result.bump, bump);
  assert.equal(await setup.git("status", "--porcelain"), "");
});

test("release synchronizes all versions, preserves previous notes, and never commits or tags", async context => {
  const setup = await repository(context);
  await setup.commit("fix(auth): refresh tokens");
  await setup.commit("feat: clearer account login");
  const before = await setup.git("rev-parse", "HEAD");
  await setup.release();
  for (const path of ["package.json", "package-lock.json", "app.json"]) assert.equal(JSON.parse(await readFile(join(setup.directory, path), "utf8")).version, "1.3.0");
  const lock = JSON.parse(await readFile(join(setup.directory, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].version, "1.3.0");
  assert.equal(lock.packages["node_modules/preserved"].version, "1.0.0");
  const homey = JSON.parse(await readFile(join(setup.directory, ".homeychangelog.json"), "utf8"));
  assert.equal(homey["1.2.3"].en, "Existing release");
  assert.match(homey["1.3.0"].en, /clearer account login/);
  assert.match(homey["1.3.0"].en, /refresh tokens/);
  const changelog = await readFile(join(setup.directory, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /compare\/v1\.2\.3\.\.\.v1\.3\.0/);
  assert.match(changelog, /### Added/);
  assert.match(changelog, /### Fixed/);
  assert.match(changelog, /Existing release/);
  assert.doesNotMatch(changelog, /initial fixture/);
  assert.equal(await setup.git("rev-parse", "HEAD"), before);
  assert.equal(await setup.git("tag", "--list"), "v1.2.3");
  await assert.rejects(setup.release(), /Commit or stash/);
});

test("first release includes legacy history without rewriting it", async context => {
  const setup = await repository(context, { version: "0.1.2", tagged: false });
  await setup.commit("Preserve expired connection state");
  await setup.commit("feat: prepare store listing");
  const before = await setup.git("log", "--format=%H");
  const result = await setup.release();
  assert.equal(result.version, "0.2.0");
  assert.equal(result.previousTag, null);
  assert.match(await readFile(join(setup.directory, "CHANGELOG.md"), "utf8"), /Earlier work/);
  assert.equal(await setup.git("log", "--format=%H"), before);
});

test("release rejects empty ranges, dirty worktrees, and undersized bumps", async context => {
  const setup = await repository(context);
  await assert.rejects(setup.release(), /no unreleased commits/);
  await writeFile(join(setup.directory, "uncommitted.txt"), "keep this");
  await assert.rejects(setup.release(), /Commit or stash/);
  await setup.git("add", "uncommitted.txt");
  await setup.git("commit", "-m", "feat: new feature");
  await assert.rejects(setup.release({ bump: "patch" }), /at least a minor/);
  assert.equal(await readFile(join(setup.directory, "uncommitted.txt"), "utf8"), "keep this");
  assert.equal(JSON.parse(await readFile(join(setup.directory, "package.json"), "utf8")).version, "1.2.3");
});

test("documentation-only changes require an explicit version bump", async context => {
  const setup = await repository(context);
  await setup.commit("docs: clarify bedtime instructions");
  await assert.rejects(setup.release(), /explicit bump/);
  assert.equal((await setup.release({ bump: "patch", "dry-run": true })).version, "1.2.4");
});

test("release rejects inconsistent version files before writing anything", async context => {
  const setup = await repository(context);
  await writeFile(join(setup.directory, "app.json"), JSON.stringify({ version: "9.0.0" }));
  await setup.git("add", "app.json");
  await setup.git("commit", "-m", "fix: incorrect metadata");
  await assert.rejects(setup.release(), /App version differs/);
  assert.equal(JSON.parse(await readFile(join(setup.directory, "package.json"), "utf8")).version, "1.2.3");
});

test("a subsequent release includes only commits after its annotated version tag", async context => {
  const setup = await repository(context);
  await setup.commit("fix: first improvement");
  await setup.release();
  await setup.git("add", ".");
  await setup.git("commit", "-m", "chore(release): 1.2.4");
  await setup.git("-c", "tag.gpgsign=false", "tag", "-a", "v1.2.4", "-m", "Release 1.2.4");
  await setup.commit("feat: second improvement");
  const result = await setup.release();
  assert.equal(result.version, "1.3.0");
  assert.equal(result.commits, 1);
  assert.equal(result.previousTag, "v1.2.4");
  const notes = JSON.parse(await readFile(join(setup.directory, ".homeychangelog.json"), "utf8"));
  assert.match(notes["1.2.4"].en, /first improvement/);
  assert.doesNotMatch(notes["1.3.0"].en, /first improvement/);
  assert.match(notes["1.3.0"].en, /second improvement/);
});

test("release does not overwrite an existing changelog version", async context => {
  const setup = await repository(context);
  await writeFile(join(setup.directory, ".homeychangelog.json"), JSON.stringify({ "1.2.4": { en: "Do not replace" } }));
  await setup.git("add", ".homeychangelog.json");
  await setup.git("commit", "-m", "fix: prepare metadata");
  await assert.rejects(setup.release(), /Changelog for 1.2.4 already exists/);
  assert.equal(JSON.parse(await readFile(join(setup.directory, ".homeychangelog.json"), "utf8"))["1.2.4"].en, "Do not replace");
});
