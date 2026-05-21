// Stub for `react-devtools-core` so bun's bundler can resolve the
// import Ink's compiled `devtools.js` makes at the top of its module,
// without us actually shipping the ~16MB devtools package.
//
// At runtime the devtools subtree is gated by Ink's reconciler on
// `process.env.DEV === 'true'`, so `devtools.js` never executes in
// production and these stubs never run. Tsconfig `paths` redirects the
// import here at compile time.
//
// Use `bunfig.toml`'s install.scopes is not viable for a single missing
// package, and bun honors tsconfig paths during bundling — that's the
// cheapest path to "satisfy the import, ship nothing."

const noop = (): void => { /* never called */ };

const stub = {
  initialize: noop,
  connectToDevTools: noop,
};

export default stub;
