import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installStarter } from "../src/starters/index.ts";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { createExtensionHost } from "../src/extensions/index.ts";
import { ulid } from "../src/id/index.ts";
import { openStore, tables } from "../src/store/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "olle-web-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Install the starter to tmp, then direct-import the staged index.ts so the
// pure helpers can be unit-tested without going through the extension host
// (and without any network).
async function importStaged(): Promise<{
  htmlToMarkdown: (html: string) => string;
  isPrivateAddress: (ip: string) => boolean;
  assertPublicUrl: (url: string) => Promise<URL>;
}> {
  installStarter({ name: "web", extensionsDir: tmp, authorName: "t" });
  const url = pathToFileURL(join(tmp, "web", "index.ts")).href;
  return import(url);
}

describe("web starter — pure helpers", () => {
  it("htmlToMarkdown: headings, links, entity decode, script strip", async () => {
    const { htmlToMarkdown } = await importStaged();
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
    expect(htmlToMarkdown("<h3>Sub</h3>")).toContain("### Sub");
    expect(htmlToMarkdown('<a href="https://example.com/x">link</a>')).toContain(
      "[link](https://example.com/x)",
    );
    // Entity decode, including &amp; not over-decoding &amp;lt;.
    expect(htmlToMarkdown("<p>a &amp; b &lt;c&gt; &#39;q&#39;</p>")).toContain("a & b <c> 'q'");
    expect(htmlToMarkdown("<p>x &amp;lt; y</p>")).toContain("x &lt; y");
    // Script/style content is removed entirely.
    const stripped = htmlToMarkdown("<script>alert(1)</script><style>.a{}</style><p>ok</p>");
    expect(stripped).not.toContain("alert(1)");
    expect(stripped).not.toContain(".a{}");
    expect(stripped).toContain("ok");
    // Lists render with markers.
    expect(htmlToMarkdown("<ul><li>one</li><li>two</li></ul>")).toContain("- one");
    expect(htmlToMarkdown("<ol><li>one</li><li>two</li></ol>")).toContain("1. one");
  });

  it("isPrivateAddress: every locked range is private", async () => {
    const { isPrivateAddress } = await importStaged();
    const priv = [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "0.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:7f00:1", // hex form of ::ffff:127.0.0.1 — the SSRF bypass this closes
      "::ffff:a00:1", // hex form of ::ffff:10.0.0.1
      "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    ];
    for (const ip of priv) {
      expect(isPrivateAddress(ip), `${ip} should be private`).toBe(true);
    }
  });

  it("isPrivateAddress: public addresses are not private", async () => {
    const { isPrivateAddress } = await importStaged();
    const pub = [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1", // just outside 172.16/12
      "100.63.255.255", // just below 100.64/10
      "100.128.0.1", // just above 100.64/10
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:8.8.8.8",
      "::ffff:5db8:d822", // hex form of ::ffff:93.184.216.34 (public)
    ];
    for (const ip of pub) {
      expect(isPrivateAddress(ip), `${ip} should be public`).toBe(false);
    }
  });
});

describe("web starter — web_fetch via extension host", () => {
  async function loadTool() {
    installStarter({ name: "web", extensionsDir: tmp, authorName: "t" });
    const store = openStore({ path: ":memory:" });
    const hostId = ulid();
    store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
    const bus = createBus({ hostId, persist: persistToStore(store) });
    const host = createExtensionHost({ bus, store, hostId, extensionsDir: tmp });
    await host.load("web");
    const entry = host.tools().find((t) => t.tool.name === "web_fetch");
    const teardown = async () => {
      await host.unload("web");
      bus.close();
      store.close();
    };
    return { entry, hostId, teardown };
  }

  it("rejects private / loopback targets before connecting", async () => {
    const { entry, hostId, teardown } = await loadTool();
    try {
      expect(entry).toBeDefined();
      const tool = entry!.tool;
      const ctx = {
        hostId,
        extensionId: "web",
        actorId: "a",
        abort: new AbortController().signal,
        secrets: {},
      };
      for (const url of [
        "http://127.0.0.1:1/",
        "http://localhost/x",
        "http://10.0.0.1/",
        "http://[::ffff:7f00:1]/", // hex IPv4-mapped loopback — the closed bypass
      ]) {
        await expect(tool.execute({ url }, ctx as never), url).rejects.toThrow(/SSRF/);
      }
    } finally {
      await teardown();
    }
  });

  it("web_fetch is operational tier with a 32KB result cap", async () => {
    const { entry, teardown } = await loadTool();
    try {
      expect(entry).toBeDefined();
      expect(entry!.tool.tier).toBe("operational");
      expect(entry!.tool.maxResultBytes).toBe(32768);
    } finally {
      await teardown();
    }
  });
});
