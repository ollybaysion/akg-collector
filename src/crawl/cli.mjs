// `akg-collector crawl <이름> [옵션]` — 크롤러를 골라 러너로 돌린다. 돌려주는 값은 exit 코드다.

import { CRAWLERS } from "./registry.mjs";
import { runCrawl } from "./runner.mjs";

/**
 * @param {string[]} argv  `crawl` 뒤의 인자
 * @param {{write: (line: string) => (void|Promise<void>), warn: (msg: string) => void, crawlers?: object}} io
 * @returns {Promise<number>}  0 = 마커까지 냄 · 1 = list 실패(마커 없음) · 2 = 사용법 오류
 */
export async function runCrawlCli(argv, { write, warn, crawlers = CRAWLERS }) {
  const [name, ...rest] = argv;
  if (!Object.hasOwn(crawlers, name ?? "")) {
    warn(`사용법: akg-collector crawl <${Object.keys(crawlers).join("|")}> [옵션]`);
    return 2;
  }
  let crawler;
  try {
    crawler = await crawlers[name](rest);
  } catch (err) {
    warn(err.message);
    return 2;
  }
  try {
    await runCrawl(crawler, { write, warn });
    return 0;
  } catch (err) {
    warn(`list 실패 — 완료 마커 없음: ${err.message}`);
    return 1;
  }
}
