// fallow-ignore-file code-duplication
// Real-Chromium pins for motion-signature.browser.js. The happy-dom suite
// (motion-signature.browser.test.ts) mocks getComputedStyle, so it asserts the
// classifier's control flow against a fake; this suite asserts the same
// branches against the platform — Blink's attr() substitution in computed
// pseudo content, unsubstituted counter(), display:none subtrees, clip-path,
// and form control state — using the exact scripts `hyperframes check` injects.
// Skipped when no Chrome/Chromium binary is available without downloading.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSystemBrowser } from "../browser/manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const signatureScript = readFileSync(join(__dirname, "motion-signature.browser.js"), "utf-8");
const motionSampleScript = readFileSync(join(__dirname, "motion-sample.browser.js"), "utf-8");

function resolveExecutable(): string | undefined {
  for (const name of ["HYPERFRAMES_BROWSER_PATH", "PUPPETEER_EXECUTABLE_PATH"]) {
    const candidate = process.env[name];
    if (candidate && existsSync(candidate)) return candidate;
  }
  return findSystemBrowser()?.executablePath;
}

const executablePath = resolveExecutable();

interface Samples {
  sweep: string;
  liveness: string;
}

declare global {
  interface Window {
    __hyperframesLayoutGeometry: () => string;
    __hyperframesMotionSample: (options: { livenessScopes: string[] }) => {
      liveness: Record<string, string>;
    };
  }
}

function composition(css: string, body: string): string {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; }
    #root { position: relative; width: 640px; height: 360px; }
    .fixed { display: inline-block; width: 80px; height: 48px; font: 32px/48px monospace; text-align: center; }
    ${css}
  </style></head><body>
    <div id="root" data-composition-id="main" data-width="640" data-height="360">${body}</div>
  </body></html>`;
}

describe.skipIf(!executablePath)("motion-signature.browser in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function load(html: string): Promise<void> {
    await page.setContent(html);
    await page.addScriptTag({ content: signatureScript });
    await page.addScriptTag({ content: motionSampleScript });
  }

  async function sample(): Promise<Samples> {
    return page.evaluate(() => ({
      sweep: window.__hyperframesLayoutGeometry(),
      liveness: window.__hyperframesMotionSample({ livenessScopes: ["*"] }).liveness["*"] ?? "",
    }));
  }

  async function mutate(script: string): Promise<void> {
    await page.evaluate(script);
  }

  it("treats an attr()-backed fixed-width countdown as motion in both samplers", async () => {
    await load(
      composition(
        "#countdown::after { content: attr(data-txt); }",
        '<span id="countdown" class="fixed" data-txt="10"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("countdown").setAttribute("data-txt", "09")');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
    expect(after.liveness).not.toBe(before.liveness);
  });

  it("keeps both signatures identical when a countdown with every textual channel is frozen", async () => {
    await load(
      composition(
        "body { counter-reset: countdown 10; } #countdown::after { content: attr(data-txt) counter(countdown); }",
        '<span id="countdown" class="fixed" data-txt="10">10</span><textarea id="note">10</textarea>',
      ),
    );
    const first = await sample();
    const second = await sample();

    expect(second).toEqual(first);
  });

  it("ignores a display:none decoy counter owner in a frozen composition", async () => {
    await load(
      composition(
        "#decoy { display: none; counter-reset: countdown 10; } #countdown::after { content: counter(countdown); }",
        '<div id="decoy"></div><span id="countdown" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("decoy").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores a decoy counter owner nested inside a display:none subtree", async () => {
    await load(
      composition(
        "#hidden-parent { display: none; } #decoy { display: block; counter-reset: countdown 10; } #countdown::after { content: counter(countdown); }",
        '<div id="hidden-parent"><div id="decoy"></div></div><span id="countdown" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("decoy").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores counter state when nothing paints a counter", async () => {
    await load(
      composition(
        "#owner { height: 0; counter-reset: countdown 10; }",
        '<div id="owner"></div><span id="countdown" class="fixed">10</span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores a zero-box decoy whose counter name nothing paints even when a list marker exists", async () => {
    await load(
      composition(
        "li { width: 80px; height: 48px; } #decoy { height: 0; counter-reset: decoy 10; }",
        '<ul><li>item</li></ul><div id="decoy"></div>',
      ),
    );
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("li")!).display)).toBe(
      "list-item",
    );
    const before = await sample();
    await mutate('document.getElementById("decoy").style.counterReset = "decoy 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores a counter consumed only by a pseudo-element under a data-layout-ignore layer", async () => {
    await load(
      composition(
        "#owner { height: 0; counter-reset: countdown 10; } #a::after { content: counter(countdown); }",
        '<div id="owner"></div><div data-layout-ignore><span id="a" class="fixed"></span></div>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores a counter consumed only by a pseudo-element that inherits visibility:hidden", async () => {
    await load(
      composition(
        "#owner { height: 0; counter-reset: countdown 10; } #a { visibility: hidden; } #a::after { content: counter(countdown); }",
        '<div id="owner"></div><span id="a" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("sees a counter painted by a visible pseudo-element on a visibility:hidden host", async () => {
    await load(
      composition(
        "body { counter-reset: countdown 10; } #a { visibility: hidden; } #a::after { visibility: visible; content: counter(countdown); }",
        '<span id="a" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.body.style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
  });

  it("sees a counter painted only through a ::marker", async () => {
    await load(
      composition(
        "#owner { height: 0; counter-reset: countdown 10; } li { width: 80px; height: 48px; } li::marker { content: counter(countdown); }",
        '<div id="owner"></div><ul><li>item</li></ul>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
  });

  it("sees counters(), styled counter(), and counter-set owners", async () => {
    await load(
      composition(
        "#owner { height: 0; counter-reset: outer 1 inner 5; counter-set: styled 10; } #a::after { content: counters(outer, '.') ' ' counter(styled, upper-roman); }",
        '<div id="owner"></div><span id="a" class="fixed"></span>',
      ),
    );
    const start = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "outer 2 inner 5"');
    const afterCounters = await sample();
    await mutate('document.getElementById("owner").style.counterSet = "styled 9"');
    const afterSet = await sample();

    expect(afterCounters.sweep).not.toBe(start.sweep);
    expect(afterSet.sweep).not.toBe(afterCounters.sweep);
  });

  it("sees a zero-box owner's counter change when a visible pseudo-element paints it", async () => {
    await load(
      composition(
        "#owner { counter-reset: countdown 10; } #countdown::after { content: counter(countdown); }",
        '<div id="owner"><span id="countdown" class="fixed"></span></div>',
      ),
    );
    // Blink leaves counter() unsubstituted in computed content, so the only
    // signal is the owner's counter state.
    expect(
      await page.evaluate(
        () => getComputedStyle(document.getElementById("countdown")!, "::after").content,
      ),
    ).toBe("counter(countdown)");
    const before = await sample();
    await mutate('document.getElementById("owner").style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
    expect(after.liveness).not.toBe(before.liveness);
  });

  it("sees a counter painted by a zero-box host's absolutely positioned pseudo-element", async () => {
    await load(
      composition(
        "body { counter-reset: countdown 10; } #host { width: 0; height: 0; } #host::after { position: absolute; left: 100px; top: 100px; content: counter(countdown); }",
        '<div id="host"></div>',
      ),
    );
    const before = await sample();
    await mutate('document.body.style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
  });

  it("sees a counter owned above the composition root change", async () => {
    await load(
      composition(
        "body { counter-reset: countdown 10; } #countdown::after { content: counter(countdown); }",
        '<span id="countdown" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.body.style.counterReset = "countdown 9"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
  });

  it("sees a pseudo-element's own counter-increment change", async () => {
    await load(
      composition(
        "#countdown::after { counter-increment: countdown 10; content: counter(countdown); } #countdown.next::after { counter-increment: countdown 9; }",
        '<span id="countdown" class="fixed"></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("countdown").classList.add("next")');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
  });

  it("sees a clip-path wipe over a box that never moves", async () => {
    await load(
      composition(
        "#panel { width: 200px; height: 100px; background: #f00; clip-path: inset(0 100% 0 0); }",
        '<div id="panel"></div>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("panel").style.clipPath = "inset(0 50% 0 0)"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
    expect(after.liveness).not.toBe(before.liveness);
  });

  // Blink reports a 290x0 box for this path (object bounding box, no stroke),
  // so this also pins that a stroked straight connector counts as visible.
  it("sees a stroke-dashoffset draw-in on a straight connector", async () => {
    await load(
      composition(
        "#wire { stroke: #000; stroke-width: 4; fill: none; stroke-dasharray: 290; stroke-dashoffset: 290; }",
        '<svg width="640" height="360"><path id="wire" d="M 10 10 L 300 10"/></svg>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("wire").style.strokeDashoffset = "145"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
    expect(after.liveness).not.toBe(before.liveness);
  });

  // Blink already reports an empty box inside <defs> / <clipPath>; this pins
  // that the platform and the classifier agree, not the container rule alone.
  it("ignores stroke-dash motion under display:none and inside <defs> / <clipPath>", async () => {
    await load(
      composition(
        "path { stroke: #000; stroke-width: 4; fill: none; stroke-dasharray: 290; stroke-dashoffset: 290; } #offstage { display: none; }",
        `<svg width="640" height="360">
          <g id="offstage"><path id="hidden" d="M 10 10 L 300 10"/></g>
          <defs><path id="template" d="M 10 20 L 300 20"/></defs>
          <clipPath id="reveal"><path id="clip" d="M 10 30 L 300 30"/></clipPath>
          <rect id="anchor" x="10" y="100" width="200" height="50" fill="#f00"/>
        </svg>`,
      ),
    );
    const before = await sample();
    await mutate(
      'for (const id of ["hidden", "template", "clip"]) document.getElementById(id).style.strokeDashoffset = "0"',
    );
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("sees textarea value and checkbox indeterminate changes", async () => {
    await load(
      composition(
        "",
        '<textarea id="note" class="fixed">10</textarea><input id="toggle" type="checkbox" />',
      ),
    );
    const start = await sample();
    await mutate('document.getElementById("note").value = "09"');
    const afterText = await sample();
    await mutate('document.getElementById("toggle").indeterminate = true');
    const afterIndeterminate = await sample();

    expect(afterText.sweep).not.toBe(start.sweep);
    expect(afterIndeterminate.sweep).not.toBe(afterText.sweep);
  });

  it("sees the composition root's own text change", async () => {
    await load(composition("", "10"));
    const before = await sample();
    await mutate('document.getElementById("root").firstChild.textContent = "09"');
    const after = await sample();

    expect(after.sweep).not.toBe(before.sweep);
    expect(after.liveness).not.toBe(before.liveness);
  });

  it("ignores text mutations inside a display:none descendant", async () => {
    await load(
      composition(
        "#hidden { display: none; }",
        '<span id="countdown" class="fixed">10<span id="hidden">10</span></span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("hidden").textContent = "09"');
    const after = await sample();

    expect(after).toEqual(before);
  });

  it("ignores motion on a data-layout-ignore layer", async () => {
    await load(
      composition(
        "#glow { position: absolute; width: 100px; height: 100px; background: #0f0; }",
        '<div id="glow" data-layout-ignore></div><span id="countdown" class="fixed">10</span>',
      ),
    );
    const before = await sample();
    await mutate('document.getElementById("glow").style.left = "200px"');
    const after = await sample();

    expect(after).toEqual(before);
  });
});
