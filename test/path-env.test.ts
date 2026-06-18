import { describe, expect, it } from "bun:test";
import {
  enrichPathFromLoginShell,
  mergeLoginPath,
  parseProbeOutput,
} from "../src/daemon/path-env.ts";

const MINIMAL = "/usr/bin:/bin:/usr/sbin:/sbin";
// The reported failure: nix-darwin installs into per-user/system profile dirs
// that launchd's stripped PATH omits.
const NIX_LOGIN =
  "/etc/profiles/per-user/daaaa/bin:/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin";

describe("mergeLoginPath", () => {
  it("adds the nix profile dirs the daemon was missing, login order first", () => {
    const { path, added } = mergeLoginPath(MINIMAL, NIX_LOGIN);
    expect(added).toEqual([
      "/etc/profiles/per-user/daaaa/bin",
      "/run/current-system/sw/bin",
    ]);
    expect(path).toBe(NIX_LOGIN); // login is a superset in login order, deduped
    expect(path.split(":")[0]).toBe("/etc/profiles/per-user/daaaa/bin");
  });

  it("is a no-op when the login shell adds nothing new", () => {
    const { path, added } = mergeLoginPath(NIX_LOGIN, MINIMAL);
    expect(added).toEqual([]);
    expect(path).toBe(NIX_LOGIN);
  });

  it("dedupes without dropping daemon-only dirs", () => {
    const { path } = mergeLoginPath("/usr/bin:/special/daemon/bin", "/nix/bin:/usr/bin");
    expect(path).toBe("/nix/bin:/usr/bin:/special/daemon/bin");
  });

  it("handles an empty current PATH", () => {
    expect(mergeLoginPath("", "/nix/bin").path).toBe("/nix/bin");
  });
});

describe("enrichPathFromLoginShell", () => {
  it("mutates env.PATH in place and reports the added dirs", () => {
    const env = { PATH: MINIMAL, SHELL: "/bin/zsh" } as NodeJS.ProcessEnv;
    const r = enrichPathFromLoginShell({ env, probe: () => NIX_LOGIN });
    expect(r.changed).toBe(true);
    expect(r.added).toContain("/etc/profiles/per-user/daaaa/bin");
    expect(env.PATH).toBe(NIX_LOGIN);
  });

  it("leaves env untouched and reports probed:false when the probe fails", () => {
    const env = { PATH: MINIMAL, SHELL: "/bin/zsh" } as NodeJS.ProcessEnv;
    const r = enrichPathFromLoginShell({ env, probe: () => null });
    expect(r.changed).toBe(false);
    expect(r.probed).toBe(false);
    expect(env.PATH).toBe(MINIMAL);
  });

  it("reports no change but probed:true when login PATH adds nothing", () => {
    // Distinguishes a genuine no-op from a defeated probe — only the latter
    // warrants a warning at the call site.
    const env = { PATH: NIX_LOGIN, SHELL: "/bin/zsh" } as NodeJS.ProcessEnv;
    const r = enrichPathFromLoginShell({ env, probe: () => MINIMAL });
    expect(r.changed).toBe(false);
    expect(r.probed).toBe(true);
    expect(env.PATH).toBe(NIX_LOGIN);
  });

  it("falls back to /bin/zsh on darwin when SHELL is unset (launchd case)", () => {
    let usedShell = "";
    const env = { PATH: MINIMAL } as NodeJS.ProcessEnv;
    enrichPathFromLoginShell({
      env,
      platform: "darwin",
      probe: (shell) => {
        usedShell = shell;
        return NIX_LOGIN;
      },
    });
    expect(usedShell).toBe("/bin/zsh");
  });

  it("falls back to /bin/sh off darwin when SHELL is unset", () => {
    let usedShell = "";
    const env = { PATH: MINIMAL } as NodeJS.ProcessEnv;
    enrichPathFromLoginShell({
      env,
      platform: "linux",
      probe: (shell) => {
        usedShell = shell;
        return NIX_LOGIN;
      },
    });
    expect(usedShell).toBe("/bin/sh");
  });
});

describe("parseProbeOutput", () => {
  const SENTINEL = "@@OLLE_PATH@@";

  it("extracts the PATH following the sentinel", () => {
    expect(parseProbeOutput(`${SENTINEL}/usr/bin:/bin`)).toBe("/usr/bin:/bin");
  });

  it("discards profile noise printed before the sentinel", () => {
    // The real-world failure: .zshrc/nvm/oh-my-zsh print to stdout before the
    // probe's printf runs. Without the sentinel that noise corrupts PATH.
    const polluted = `Now using node v20\nwelcome\n${SENTINEL}/opt/homebrew/bin:/usr/bin`;
    expect(parseProbeOutput(polluted)).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("uses the last sentinel if profile output somehow echoes one earlier", () => {
    expect(parseProbeOutput(`${SENTINEL}junk\n${SENTINEL}/real/bin`)).toBe("/real/bin");
  });

  it("returns null when the sentinel is absent (fail closed, no splicing noise)", () => {
    expect(parseProbeOutput("/usr/bin:/bin")).toBeNull();
    expect(parseProbeOutput("")).toBeNull();
  });

  it("returns null when the PATH after the sentinel is empty", () => {
    expect(parseProbeOutput(`noise${SENTINEL}   `)).toBeNull();
  });
});
