// Vite 的 `?raw` 匯入：以字串讀入檔案內容（不引入 @types/node，避免與 workers-types 衝突）
declare module "*?raw" {
  const content: string;
  export default content;
}
