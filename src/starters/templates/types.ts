// Shared shape for starter templates. Kept in its own module so each
// per-starter file imports the type without a cycle through the barrel.

export interface StarterTemplate {
  name: string;
  description: string;
  files: Record<string, string>;
}
