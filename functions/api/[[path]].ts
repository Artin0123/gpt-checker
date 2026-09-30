import { handleApi } from "../../src/app";
import type { Env } from "../../src/env";

// 所有 /api/* 請求都交給 src/app.ts 的路由表處理（含驗證）
export const onRequest: PagesFunction<Env> = (context) => handleApi(context.request, context.env);
