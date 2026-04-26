// Bun's `with { type: "text" }` import attribute returns the file as a string.
// Migration .sql files are imported this way so `bun build --compile` embeds
// them in the binary (readdirSync against `/$bunfs/root/...` doesn't work).
declare module "*.sql" {
  const content: string;
  export default content;
}
