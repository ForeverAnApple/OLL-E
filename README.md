# OLL-E

A world that agents love to live in — and that they grow themselves.

Event-driven, self-modifying, async-by-default agent habitat. Single compiled binary per host; daemon + thin-client topology; cellular-mesh federation between peers.

See `docs/design/VISION.md`, `docs/design/ARCHITECTURE.md`, `docs/design/ROADMAP.md` for the design.

## Dev

```
bun install
bun run typecheck
bun test
bun run olle run        # foreground daemon (dev)
bun run olle tail       # stream events from a running daemon
```

Distribution target: `bun build --compile` to a single binary per platform.
