// 腳本只用到 process.env / exitCode；避免引入 @types/node 與 workers-types 衝突
declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};
