// Hybrid Logical Clock — physical ms + logical counter.
// Stamps carry (l, c): events from the same host sort by l then c; cross-host
// events preserve causality when we reconcile via recv().
//
// Serialized form: `<l-hex-12>-<c-hex-4>` — 17 chars, lex-sortable.

export interface HlcStamp {
  readonly l: number;
  readonly c: number;
}

export interface HlcClock {
  now(): HlcStamp;
  recv(remote: HlcStamp): HlcStamp;
  peek(): HlcStamp;
}

export function createClock(physical: () => number = Date.now): HlcClock {
  let l = 0;
  let c = 0;

  return {
    peek: () => ({ l, c }),
    now: () => {
      const pt = physical();
      if (pt > l) {
        l = pt;
        c = 0;
      } else {
        c += 1;
      }
      return { l, c };
    },
    recv: (remote) => {
      const pt = physical();
      const lOld = l;
      l = Math.max(lOld, remote.l, pt);
      if (l === lOld && l === remote.l) c = Math.max(c, remote.c) + 1;
      else if (l === lOld) c = c + 1;
      else if (l === remote.l) c = remote.c + 1;
      else c = 0;
      return { l, c };
    },
  };
}

export function encodeStamp(stamp: HlcStamp): string {
  const lHex = stamp.l.toString(16).padStart(12, "0");
  const cHex = stamp.c.toString(16).padStart(4, "0");
  return `${lHex}-${cHex}`;
}

export function decodeStamp(s: string): HlcStamp {
  const m = /^([0-9a-f]{12})-([0-9a-f]{4})$/.exec(s);
  if (!m) throw new Error(`hlc: invalid stamp ${s}`);
  return { l: parseInt(m[1]!, 16), c: parseInt(m[2]!, 16) };
}

export function compareStamp(a: HlcStamp, b: HlcStamp): number {
  return a.l !== b.l ? a.l - b.l : a.c - b.c;
}
