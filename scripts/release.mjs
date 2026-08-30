import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function release({ bump = "auto", "dry-run": dryRun = false, directory = root, log = console.log } = {}) {
  assert(["auto", "patch", "minor", "major"].includes(bump), "Choose auto, patch, minor, or major");
  directory = await realpath(resolve(directory));
  const git = async (...args) => (await execute("git", args, { cwd: directory, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  assert.equal(await git("rev-parse", "--show-toplevel"), directory, "Run releases at the repository root");
  assert.equal(await git("status", "--porcelain"), "", "Commit or stash changes before preparing a release");
  const paths = {
    manifest: join(directory, "package.json"),
    lock: join(directory, "package-lock.json"),
    app: join(directory, "app.json"),
    homey: join(directory, ".homeychangelog.json"),
    changelog: join(directory, "CHANGELOG.md")
  };
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  const lock = JSON.parse(await readFile(paths.lock, "utf8"));
  const app = JSON.parse(await readFile(paths.app, "utf8"));
  assert(stableVersion.test(manifest.version), "Homey requires a stable major.minor.patch version");
  assert.equal(lock.version, manifest.version, "Lockfile version differs from package.json");
  assert.equal(lock.packages[""].version, manifest.version, "Lockfile root version differs from package.json");
  assert.equal(app.version, manifest.version, "App version differs from package.json");
  const tags = (await git("tag", "--merged", "HEAD", "--sort=-version:refname", "--list", "v*")).split("\n");
  const previousTag = tags.find(tag => stableVersion.test(tag.slice(1)));
  if (previousTag) assert.equal(previousTag.slice(1), manifest.version, "Current version must match the latest reachable release tag");
  const history = await git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", previousTag ? `${previousTag}..HEAD` : "HEAD");
  const commits = history.split("\x1e").map(record => record.trim()).filter(Boolean).map(record => {
    const [hash, subject, ...body] = record.split("\x1f");
    assert(/^[a-f0-9]{40}$/.test(hash), "Unexpected Git commit format");
    const conventional = subject.match(/^([a-z]+)(?:\([^()]+\))?(!)?:\s+(.+)$/);
    const type = conventional?.[1] ?? "legacy";
    const breaking = Boolean(conventional?.[2] || /^BREAKING[ -]CHANGE:\s/m.test(body.join("\x1f")));
    return { hash, subject: conventional?.[3] ?? subject, type, breaking };
  }).filter(commit => commit.type !== "chore" || !/^\d+\.\d+\.\d+$/.test(commit.subject));
  assert(commits.length, "There are no unreleased commits");
  const required = commits.some(commit => commit.breaking) ? "major"
    : commits.some(commit => commit.type === "feat") ? "minor"
      : commits.some(commit => ["fix", "perf", "revert", "legacy"].includes(commit.type)) ? "patch" : undefined;
  const chosen = bump === "auto" ? required : bump;
  assert(chosen, "Only documentation or maintenance changed; choose an explicit bump to release it");
  const ranks = ["patch", "minor", "major"];
  assert(!required || ranks.indexOf(chosen) >= ranks.indexOf(required), `These commits require at least a ${required} release`);
  const components = manifest.version.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[chosen];
  components[index]++;
  for (let following = index + 1; following < components.length; following++) components[following] = 0;
  assert(components.every(Number.isSafeInteger), "Version components exceed safe integer precision");
  const version = components.join(".");
  const tag = `v${version}`;
  assert.equal(await git("tag", "--list", tag), "", `Tag ${tag} already exists`);
  const homey = existsSync(paths.homey) ? JSON.parse(await readFile(paths.homey, "utf8")) : {};
  assert(!Object.hasOwn(homey, version), `Changelog for ${version} already exists`);
  const previous = existsSync(paths.changelog) ? await readFile(paths.changelog, "utf8") : "# Changelog\n\n";
  assert(previous.startsWith("# Changelog\n\n"), "CHANGELOG.md must start with its standard heading");
  const repository = (manifest.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
  assert(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository), "Use a public GitHub repository URL");
  const groups = new Map();
  const headings = { feat: "Added", fix: "Fixed", perf: "Performance", revert: "Fixed", docs: "Documentation", legacy: "Earlier work" };
  for (const commit of commits) {
    const heading = commit.breaking ? "Breaking changes" : headings[commit.type] ?? "Maintenance";
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(commit);
  }
  const date = await git("show", "-s", "--format=%cs", "HEAD");
  const comparison = previousTag ? `${repository}/compare/${previousTag}...${tag}` : `${repository}/tree/${tag}`;
  const escape = text => text.replace(/[\\`*_[\]<>]/g, "\\$&");
  const sections = ["Breaking changes", "Added", "Fixed", "Performance", "Documentation", "Maintenance", "Earlier work"]
    .filter(heading => groups.has(heading)).map(heading => `### ${heading}\n\n${groups.get(heading).map(commit => `- ${escape(commit.subject)} ([${commit.hash.slice(0, 7)}](${repository}/commit/${commit.hash}))`).join("\n")}`);
  const entry = `## [${version}](${comparison}) - ${date}\n\n${sections.join("\n\n")}\n\n`;
  const notes = commits.filter(commit => commit.breaking || !["docs", "test", "ci", "style", "chore"].includes(commit.type))
    .map(commit => `- ${commit.breaking ? "Breaking: " : ""}${commit.subject}`).join("\n") || commits.map(commit => `- ${commit.subject}`).join("\n");
  const result = { previousVersion: manifest.version, version, tag, bump: chosen, commits: commits.length, previousTag: previousTag ?? null, dryRun };
  if (!dryRun) {
    manifest.version = lock.version = lock.packages[""].version = app.version = version;
    homey[version] = { en: notes };
    await Promise.all([
      ...[[paths.manifest, manifest], [paths.lock, lock], [paths.app, app], [paths.homey, homey]].map(([path, value]) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)),
      writeFile(paths.changelog, `# Changelog\n\n${entry}${previous.slice("# Changelog\n\n".length)}`.trimEnd() + "\n")
    ]);
  }
  log(JSON.stringify(result));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await release(parseArgs({ options: {
  bump: { type: "string", default: "auto" },
  "dry-run": { type: "boolean", default: false },
  directory: { type: "string", default: root }
} }).values);
