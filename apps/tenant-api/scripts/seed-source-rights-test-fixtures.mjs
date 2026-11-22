import { spawnSync } from "node:child_process";
import { sourceRightsFixtureSql } from "./source-rights-test-fixtures.mjs";

const args = [
  "--yes", "wrangler@4.13.2", "d1", "execute", "DB", "--local",
  "--config", "wrangler.d1-test.toml", "--persist-to", "./.wrangler-d1-test",
  "--command",
];
for (const sourceId of ["source-http-a", "source-http-grant", "source-http-grant-asset"]) {
  const result = spawnSync("npx", [...args, sourceRightsFixtureSql(sourceId)], { encoding: "utf8" });
  const output = (result.stdout || "") + "\n" + (result.stderr || "");
  if (result.status !== 0) throw new Error("Failed to seed synthetic rights fixture for " + sourceId + "\n" + output);
  console.log("Seeded synthetic evidence + approved measurement/storage rights for " + sourceId);
}
