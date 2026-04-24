import { runMangaSourceBakeoff } from "../src/lib/sources/bakeoff/runner.mjs";

const report = await runMangaSourceBakeoff();
console.log(JSON.stringify(report, null, 2));
