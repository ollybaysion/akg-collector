// 크롤러 이름 → 만드는 함수(`crawl <이름>` 뒤의 인자 → 크롤러).
// 새 구현은 src/crawl/ 에 파일 하나를 두고 여기에 한 줄을 더한다.

import { repoFsFromArgs } from "./repo-fs.mjs";

export const CRAWLERS = {
  "repo-fs": repoFsFromArgs,
};
