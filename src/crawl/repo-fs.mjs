// repo-fs 크롤러: 폴더의 md 파일을 글롭으로 골라 낸다(AKG 설계 C1 의 내장 어댑터).

import { glob, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";

const execFileP = promisify(execFile);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules"]);
const DEFAULT_INCLUDE = ["**/*.md"];

/** `crawl repo-fs` 뒤의 인자 → 크롤러. */
export function repoFsFromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      include: { type: "string", multiple: true },
      name: { type: "string" },
    },
  });
  if (!values.root) throw new Error("repo-fs: --root 가 필요하다");
  return createRepoFs({ root: values.root, include: values.include ?? DEFAULT_INCLUDE, name: values.name });
}

/**
 * @param {{root: string, include: string[], name?: string}} opts
 *   include = root 기준 글롭 · name = ref 앞 이름(없으면 root 폴더 이름)
 */
export function createRepoFs({ root, include, name }) {
  const absRoot = resolve(root);
  const prefix = `${name || basename(absRoot)}@`;

  return {
    name: "repo-fs",

    async *list() {
      if (!(await stat(absRoot)).isDirectory()) throw new Error(`repo-fs: 폴더가 아니다: ${absRoot}`);
      const paths = new Set();
      const entries = glob(include, {
        cwd: absRoot,
        withFileTypes: true,
        exclude: (e) => SKIP_DIRS.has(typeof e === "string" ? basename(e) : e.name),
      });
      for await (const entry of entries)
        if (entry.isFile()) paths.add(toPosix(relative(absRoot, join(entry.parentPath, entry.name))));

      const times = await gitTimes(absRoot);
      for (const rel of [...paths].sort()) {
        const git = times.get(rel);
        const mtime = git ? undefined : (await stat(join(absRoot, rel)).catch(() => undefined))?.mtime;
        yield {
          ref: prefix + rel,
          title: basename(rel, extname(rel)),
          updatedAt: git?.updatedAt ?? mtime?.toISOString(),
          createdAt: git?.createdAt,
        };
      }
    },

    async fetch(listed) {
      const abs = resolve(absRoot, listed.ref.slice(prefix.length));
      if (!listed.ref.startsWith(prefix) || !abs.startsWith(absRoot + sep))
        throw new Error(`repo-fs: root 밖 ref: ${listed.ref}`);
      const text = await readFile(abs, "utf8");
      return { ...listed, title: firstHeading(text) ?? listed.title, text };
    },
  };
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function firstHeading(text) {
  return text.match(/^# (.+)$/m)?.[1].trim() || undefined;
}

/** 경로(dir 기준) → 첫 · 마지막 커밋의 author 시각. git 폴더가 아니면 빈 표. */
async function gitTimes(dir) {
  const times = new Map();
  let stdout;
  try {
    ({ stdout } = await execFileP(
      "git",
      ["-C", dir, "log", "--format=%x01%aI", "--name-only", "-z", "--no-renames", "--relative"],
      { maxBuffer: GIT_MAX_BUFFER },
    ));
  } catch {
    return times;
  }
  let at;
  for (const token of stdout.split("\0")) {
    const part = token.replace(/^\n/, "");
    if (part.startsWith("\x01")) at = part.slice(1);
    else if (part && at) {
      const seen = times.get(part);
      if (seen) seen.createdAt = at;
      else times.set(part, { updatedAt: at, createdAt: at });
    }
  }
  return times;
}
