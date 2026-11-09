import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRepoFs, repoFsFromArgs } from "../src/crawl/repo-fs.mjs";
import { runCrawl } from "../src/crawl/runner.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "crawl-repo-fs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(dir, args, date) {
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    env: { PATH: process.env.PATH, HOME: dir, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "ignore",
  });
}

async function crawl(crawler) {
  const lines = [];
  await runCrawl(crawler, { write: (l) => lines.push(JSON.parse(l)) });
  return lines;
}

test("git 폴더: createdAt = 첫 커밋, updatedAt = 마지막 커밋, title = 첫 # 줄", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "docs"));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "docs", "guide.md"), "앞말\n# 센서 가이드\n\n본문\n");
  writeFileSync(join(dir, "docs", "plain.md"), "제목 줄 없음\n");
  git(dir, ["add", "."], "2026-01-02T03:04:05Z");
  git(dir, ["commit", "-q", "-m", "a"], "2026-01-02T03:04:05Z");
  writeFileSync(join(dir, "docs", "guide.md"), "# 센서 가이드\n\n고친 본문\n");
  git(dir, ["commit", "-q", "-am", "b"], "2026-03-04T05:06:07Z");

  const lines = await crawl(createRepoFs({ root: dir, include: ["docs/*.md"] }));
  const name = basename(dir);
  assert.deepEqual(lines[0], {
    ref: `${name}@docs/guide.md`,
    title: "센서 가이드",
    mime: "text/markdown",
    text: "# 센서 가이드\n\n고친 본문\n",
    updatedAt: "2026-03-04T05:06:07.000Z",
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(lines[1].ref, `${name}@docs/plain.md`);
  assert.equal(lines[1].title, "plain");
  assert.equal(lines[1].createdAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(lines[2].done, { listed: 2, emitted: 2, oversize: [], failed: [], duplicate: [] });
});

test("git 이 아닌 폴더: updatedAt = mtime, createdAt 없음, node_modules 는 건너뛴다", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "a.md"), "# A\n");
  writeFileSync(join(dir, "node_modules", "b.md"), "# B\n");
  const mtime = new Date("2026-05-06T07:08:09Z");
  utimesSync(join(dir, "a.md"), mtime, mtime);

  const lines = await crawl(repoFsFromArgs(["--root", dir]));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ref, `${basename(dir)}@a.md`);
  assert.equal(lines[0].updatedAt, mtime.toISOString());
  assert.equal("createdAt" in lines[0], false);
});

test("같은 폴더를 두 번 돌리면 ref 가 같다", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "x", "y"), { recursive: true });
  for (const p of ["b.md", "a.md", "x/y/c.md"]) writeFileSync(join(dir, p), `# ${p}\n`);
  const refs = async () =>
    (await crawl(createRepoFs({ root: dir, include: ["**/*.md", "*.md"] }))).slice(0, -1).map((l) => l.ref);
  const first = await refs();
  assert.equal(first.length, 3);
  assert.deepEqual(await refs(), first);
});

test("--name 을 주면 ref 앞 이름이 폴더 이름 대신 그 값이다", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "a.md"), "# A\n");
  const lines = await crawl(repoFsFromArgs(["--root", dir, "--name", "fdc-app"]));
  assert.equal(lines[0].ref, "fdc-app@a.md");
});

test("없는 root 는 list 실패라 마커가 없다", async (t) => {
  const dir = join(tempDir(t), "none");
  const lines = [];
  await assert.rejects(runCrawl(createRepoFs({ root: dir, include: ["*.md"] }), { write: (l) => lines.push(l) }));
  assert.deepEqual(lines, []);
});

test("root 밖을 가리키는 ref 는 fetch 실패", async (t) => {
  const dir = tempDir(t);
  const crawler = createRepoFs({ root: dir, include: ["*.md"] });
  await assert.rejects(crawler.fetch({ ref: `${basename(dir)}@../x.md` }), /root 밖/);
});

test("--root 없으면 오류", () => {
  assert.throws(() => repoFsFromArgs([]), /--root/);
});
