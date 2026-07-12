// Bun's `with { type: "text" }` import attribute returns the file as a string.
// The extension API reference .md is imported this way so `bun build --compile`
// embeds it in the binary (readdirSync against `/$bunfs/root/...` doesn't work).
// Same mechanism as migration .sql files (see src/store/migrations/sql.d.ts).
declare module "*.md" {
  const content: string;
  export default content;
}
