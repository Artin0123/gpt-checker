// GHA 入口：npx tsx scripts/gha-run.ts
// env: PANEL_URL, PANEL_PASSWORD, TRIGGER=schedule|manual, HI_MODEL, HI_EFFORT, RUN_URL
// 手動執行的模式與 Discord webhook 都從面板讀取（面板設定頁）
import { DEFAULT_HI_MODEL } from "../src/lib/openai";
import { buildDiscordMessages, panelClient, postDiscord, resolveMode, runAll, shouldNotify, type Job } from "./runner";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main() {
  const trigger = process.env.TRIGGER === "schedule" ? "schedule" : "manual";
  const runUrl = process.env.RUN_URL;
  const model = process.env.HI_MODEL?.trim() || DEFAULT_HI_MODEL;
  const effort = process.env.HI_EFFORT === undefined ? "none" : process.env.HI_EFFORT.trim() || null;

  const panel = panelClient(requireEnv("PANEL_URL"), requireEnv("PANEL_PASSWORD"));
  let job: Job;
  try {
    job = await panel.fetchJob();
  } catch (err) {
    // 讀不到面板就拿不到 webhook，只能讓 run 失敗（GHA 頁面會顯示紅色）
    console.error(`無法從面板取得帳號與設定：${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const mode = resolveMode(trigger, job);
  console.log(`trigger=${trigger} mode=${mode} accounts=${job.accounts.length}`);
  const results = await runAll(panel, job, { mode, model, effort });
  // log 只印狀態，不印 token
  for (const r of results) {
    // 失敗時 reason 本身就是第一個異常，不重複印
    const extra = r.anomalies.filter((m) => m !== r.reason);
    console.log(`[${r.status}] ${r.label}: ${r.reason}${extra.length ? ` | anomalies: ${extra.join("; ")}` : ""}`);
  }

  if (shouldNotify(mode)) {
    if (!job.discordWebhook) console.log("面板未設定 Discord webhook，略過通知");
    else {
      try {
        for (const m of buildDiscordMessages(results, { runUrl })) await postDiscord(job.discordWebhook, m);
      } catch (err) {
        console.error(`Discord 通知失敗：${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
  }
  // 有異常時讓 run 顯示失敗，只查額度模式也能從 GHA 頁面看出來
  if (results.some((r) => r.anomalies.length > 0)) process.exitCode = 1;
}

main();
