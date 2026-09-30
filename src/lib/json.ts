// 解析外部 JSON（上游回應、匯入檔、JWT payload）時共用的小工具

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** 不是物件時回傳空物件，方便連續取欄位 */
export const obj = (v: unknown): Obj => (isObj(v) ? v : {});

/** 非空字串（去掉前後空白），否則 null */
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
