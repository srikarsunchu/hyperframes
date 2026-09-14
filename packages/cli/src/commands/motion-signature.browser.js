// Shared "what counts as motion" classifier for the two seek-time samplers.
// Injected via page.addScriptTag BEFORE layout-audit.browser.js and
// motion-sample.browser.js (see checkBrowser.ts injectAuditScripts and
// layout.ts); both consume it through window.__hyperframesMotionSignature.
//
// Two Node-side decisions compare per-sample signatures of the composition:
//   - the frozen-sweep guard (#U10, checkPipeline.ts detectSweepStatic) reads
//     window.__hyperframesLayoutGeometry once per layout-grid seek and fails
//     the run with sweep_static when every sample is byte-identical;
//   - keepsMoving liveness (motionAudit.ts) reads motion-sample's liveness
//     signature per motion sample and reports motion_frozen on long runs of
//     identical signatures.
// They meet in one decision (a motion_frozen finding suppresses sweep_static),
// so the set of channels that count as motion MUST be identical for both —
// otherwise a composition one sampler accepts as live is rejected as frozen
// by the other. This module is that single owner. The only sanctioned
// difference is quantization: liveness buckets position to 2px and opacity to
// 0.08 so the motion RFC's "moves ≥2px / opacity ≥0.08" thresholds fall out of
// bucketing, while the sweep guard wants exact (0.01) rounding because it asks
// whether the seek moved anything at all.
//
// Adding a channel (e.g. SVG fill-opacity): append one reader
// `(element, ctx) => string` to ELEMENT_CHANNELS. `ctx` carries the element's
// computed style, its ::before/::after styles, its inherited opacity, and the
// quantize flag. A reader returns a string that is equal between two samples
// iff that channel did not visibly change; return "" for elements the channel
// does not apply to so ordinary compositions gain no payload.
//
// Signatures are a single opaque string per sample (not a structured array):
// Node only ever needs equality, never per-element diffing. Textual channels
// are hashed (FNV-1a, length-delimited fields) so raw composition text never
// leaves the page and per-sample payloads stay compact.
(function () {
  const IGNORE_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "META", "LINK"]);
  const MEDIA_TAGS = new Set(["CANVAS", "VIDEO", "IMG"]);
  // SVG containers whose direct content is never painted: <defs> and
  // <clipPath> only lend geometry to a referencing element, and <symbol>
  // renders only as <use> instances, whose shadow trees querySelectorAll
  // cannot reach. Blink happens to report an empty box for their descendants,
  // but a never-painted subtree should be excluded by rule, not by one
  // engine's bbox behaviour. SVG tag names are case-preserved (`clipPath`),
  // hence the lower-cased match.
  const UNPAINTED_SVG_CONTAINERS = new Set(["defs", "clippath", "symbol"]);
  // A computed stroke that paints nothing: `none`, or a fully transparent
  // colour (`transparent` computes to rgba(0, 0, 0, 0)).
  const TRANSPARENT_COLOR = /^(?:transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/;
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  const LIVENESS_POSITION_BUCKET_PX = 2;
  const LIVENESS_OPACITY_BUCKET = 0.08;
  const IGNORE_SELECTOR = "[data-layout-ignore], [data-layout-check='ignore']";
  // counter(name) / counters(name, sep) in generated content. A list-item box
  // whose ::marker content is `normal` paints counter(list-item) implicitly.
  const COUNTER_FUNCTION = /counters?\(\s*([^\s,)]+)/g;
  const IMPLICIT_MARKER_CONTENT = "counter(list-item)";
  const LIST_ITEM_DISPLAY = /\blist-item\b/;

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function opacityChain(element) {
    let opacity = 1;
    for (let current = element; current; current = current.parentElement) {
      const parsed = Number.parseFloat(getComputedStyle(current).opacity || "1");
      if (Number.isFinite(parsed)) opacity *= parsed;
    }
    return opacity;
  }

  function compositionRoot() {
    return (
      document.querySelector("[data-composition-id][data-width][data-height]") ||
      document.querySelector("[data-composition-id]") ||
      document.body
    );
  }

  function isHiddenStyle(style) {
    return (
      style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
    );
  }

  // `display` is not inherited: a child of a display:none parent still
  // computes display:block, and a shape inside <defs> computes as painted. A
  // subtree starts here when nothing under it can generate a box.
  function startsHiddenSubtree(element, style) {
    return style.display === "none" || UNPAINTED_SVG_CONTAINERS.has(element.tagName.toLowerCase());
  }

  function paintsStroke(style) {
    const stroke = cssValue(style.stroke);
    return (
      stroke !== "" &&
      !TRANSPARENT_COLOR.test(stroke) &&
      Number.parseFloat(style.strokeWidth) > 0 &&
      Number.parseFloat(style.strokeOpacity) > 0
    );
  }

  // An SVG geometry element (path/circle/ellipse/rect/line/polyline/polygon)
  // with a painted stroke. Chromium's getBoundingClientRect for SVG shapes is
  // the object bounding box WITHOUT the stroke, so a straight horizontal or
  // vertical connector reports 0 height or 0 width regardless of stroke-width
  // even though it is plainly on screen.
  function isStrokedShape(element, style) {
    return element instanceof SVGGeometryElement && paintsStroke(style);
  }

  // layout-audit.browser.js isVisibleElement's default floor, widened by one
  // case: a stroked SVG shape whose geometry bbox is degenerate along one axis
  // (see isStrokedShape) is on screen even though that floor rejects it.
  // The author opt-out (data-layout-ignore / data-layout-check=ignore) is NOT
  // applied here: motion-sample reports this bit for explicitly asserted
  // selectors, and an assertion naming an element outranks a layout-audit
  // opt-out. compositionSignature applies the opt-out itself (see there).
  // clip-path is not probed either; it is a channel, so a clip-path wipe over a
  // static box counts as motion directly.
  // fallow-ignore-next-line complexity
  function isVisibleElement(element, style, opacity) {
    if (IGNORE_TAGS.has(element.tagName)) return false;
    const computed = style || getComputedStyle(element);
    if (isHiddenStyle(computed)) return false;
    if ((opacity === undefined ? opacityChain(element) : opacity) < 0.2) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0.5 && rect.height > 0.5) return true;
    // A stroked shape paints along its one non-degenerate axis.
    return isStrokedShape(element, computed) && (rect.width > 0.5 || rect.height > 0.5);
  }

  function foldField(hash, value) {
    hash ^= value.length;
    hash = Math.imul(hash, FNV_PRIME);
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME);
    }
    return hash;
  }

  function hashFields(fields) {
    let hash = FNV_OFFSET_BASIS;
    for (const field of fields) hash = foldField(hash, field);
    return (hash >>> 0).toString(36);
  }

  // `none` / `normal` are the computed initial values of content, counter-*,
  // clip-path, and font-variation-settings; collapse them so unused channels
  // stay "".
  function cssValue(value) {
    return value === "none" || value === "normal" ? "" : value || "";
  }

  // --- Per-element channels: (element, ctx) => string --------------------------

  function boxChannel(element, ctx) {
    const rect = element.getBoundingClientRect();
    const box = [rect.left, rect.top, rect.width, rect.height];
    if (ctx.quantize) {
      return box.map((value) => Math.round(value / LIVENESS_POSITION_BUCKET_PX)).join(",");
    }
    return box.map(round).join(",");
  }

  function opacityChannel(element, ctx) {
    return String(
      ctx.quantize ? Math.round(ctx.opacity / LIVENESS_OPACITY_BUCKET) : round(ctx.opacity),
    );
  }

  // Variable-font axis animation moves no geometry and no opacity; in a
  // DUPLEXED face (Recursive holds one advance width at every weight) not even
  // the line width shifts, so without this channel the whole run reads frozen.
  function fontAxesChannel(element, ctx) {
    const axes = cssValue(ctx.style.fontVariationSettings);
    return axes ? hashFields([axes]) : "";
  }

  // A clip-path wipe (inset(0 100% 0 0) → inset(0)) reveals a box that never
  // moves; the computed clip-path string is the only thing that changes.
  function clipPathChannel(element, ctx) {
    const clip = cssValue(ctx.style.clipPath);
    return clip ? hashFields([clip]) : "";
  }

  // `none` and an all-zero list (`0`, `0px 0px`) both render a solid stroke,
  // on which the offset has no visible effect.
  function dashPattern(style) {
    const dashes = cssValue(style.strokeDasharray);
    if (!dashes) return "";
    return dashes.split(/[\s,]+/).some((dash) => Number.parseFloat(dash) > 0) ? dashes : "";
  }

  // A "draw the line in" SVG entrance animates stroke-dasharray /
  // stroke-dashoffset on a shape whose geometry never changes: no box, no
  // opacity, only how much of the stroke is currently dash-visible. Without a
  // dash pattern the offset has no visible effect, and without a painted
  // stroke neither does, so ordinary shapes stay "".
  function strokeDashChannel(element, ctx) {
    if (!isStrokedShape(element, ctx.style)) return "";
    const dashes = dashPattern(ctx.style);
    return dashes ? hashFields([dashes, ctx.style.strokeDashoffset || ""]) : "";
  }

  // Direct text nodes only: descendants are signed separately, and a hidden
  // descendant's text mutation must not masquerade as visible motion.
  function textChannel(element) {
    const text = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join("");
    return text && hashFields([text]);
  }

  function flag(value) {
    return value ? "1" : "0";
  }

  function inputState(element) {
    return [
      element.type || "",
      element.value || "",
      flag(element.checked),
      flag(element.indeterminate),
    ];
  }

  function selectState(element) {
    const fields = [String(element.selectedIndex), element.value || ""];
    for (const option of element.options) fields.push(flag(option.selected));
    return fields;
  }

  const CONTROL_STATE = {
    INPUT: inputState,
    TEXTAREA: (element) => [element.value || ""],
    SELECT: selectState,
  };

  // Form controls paint their value/checked state without changing the box.
  function controlChannel(element) {
    const read = CONTROL_STATE[element.tagName];
    return read ? hashFields(read(element)) : "";
  }

  // Chromium substitutes attr() in computed pseudo content, so this is the
  // platform-owned rendered string rather than a CSS expression to reparse.
  // counter() is NOT substituted — that is what the counter channel is for.
  function generatedContentChannel(element, ctx) {
    const before = cssValue(ctx.pseudo.before.content);
    const after = cssValue(ctx.pseudo.after.content);
    return before || after ? hashFields([before, after]) : "";
  }

  // Pixel-only media motion (a 2D/WebGL canvas repainting, a playing video, or
  // an equal-size opaque <img> src swap) moves no geometry and no opacity, so
  // it is invisible to every DOM-state channel. Downsample each visible media
  // element to 8x8 and fold its pixels in. Tainted, zero-sized, or unreadable
  // media hashes to a constant — no worse than DOM-state-only detection and
  // never a new false negative for DOM-motion compositions. Media inside
  // iframes is intentionally outside this signature: it lives in a separate
  // document, and cross-origin frames are inaccessible under SOP.
  // fallow-ignore-next-line complexity
  function mediaPixelChannel(element) {
    if (!MEDIA_TAGS.has(element.tagName)) return "";
    try {
      const rect = element.getBoundingClientRect();
      const sourceWidth = element.videoWidth || element.width || rect.width;
      const sourceHeight = element.videoHeight || element.height || rect.height;
      if (!sourceWidth || !sourceHeight) return "x";
      const off = document.createElement("canvas");
      off.width = 8;
      off.height = 8;
      const ctx2d = off.getContext("2d");
      if (!ctx2d) return "x";
      ctx2d.drawImage(element, 0, 0, 8, 8);
      const data = ctx2d.getImageData(0, 0, 8, 8).data;
      let hash = 0;
      for (let i = 0; i < data.length; i++) hash = (hash * 31 + data[i]) >>> 0;
      return String(hash);
    } catch {
      return "x";
    }
  }

  const ELEMENT_CHANNELS = [
    boxChannel,
    opacityChannel,
    fontAxesChannel,
    clipPathChannel,
    strokeDashChannel,
    textChannel,
    controlChannel,
    generatedContentChannel,
    mediaPixelChannel,
  ];

  // --- Composition-level counter channel ------------------------------------
  //
  // Counter declarations often live on zero-box owners (or on ancestors of the
  // composition root) while some pseudo-element paints the value, so counter
  // state is a composition-level channel over every element that generates a
  // box — not just the visible ones. Two guards keep a decoy counter from
  // making a frozen composition read as live: a display:none subtree generates
  // no boxes and therefore cannot feed any painted counter(), and only
  // declarations that NAME a counter some generated content actually paints
  // are folded in — a varying counter nobody renders is not motion. The gate
  // is name-level, not scope-level: a same-named owner that cannot reach the
  // consumer in the box tree still counts, which is accepted for a guard whose
  // job is catching frozen timelines, not defeating deliberate authors.
  // visibility:hidden and zero-box owners stay in as owners: they generate
  // boxes, their counters propagate to visible descendants/siblings, and their
  // own absolutely-positioned pseudo-elements can paint. <ol start> / <li
  // value> are not surfaced in computed counter-* and stay invisible here.

  // Generated content of one box owner that reaches the screen: the host is
  // not under an author opt-out, has a paintable inherited opacity, and the
  // pseudo box itself is not hidden. A list-item box also paints its ::marker
  // (counter(list-item) when the marker content is `normal`).
  function markerContent(element, style) {
    if (isHiddenStyle(style) || !LIST_ITEM_DISPLAY.test(style.display)) return "";
    return cssValue(getComputedStyle(element, "::marker").content) || IMPLICIT_MARKER_CONTENT;
  }

  function paintedContent(element, style, pseudo, opacity) {
    if (opacity < 0.2 || element.closest(IGNORE_SELECTOR)) return [];
    const boxes = [pseudo.before, pseudo.after].filter((box) => !isHiddenStyle(box));
    return [...boxes.map((box) => cssValue(box.content)), markerContent(element, style)];
  }

  function consumedCounterNames(owners) {
    const names = new Set();
    for (const owner of owners) {
      for (const content of owner.painted) {
        for (const match of content.matchAll(COUNTER_FUNCTION)) names.add(match[1]);
      }
    }
    return names;
  }

  // `counter-reset: a 10 b 3` → does any named counter get painted?
  function namesConsumedCounter(declaration, consumed) {
    return declaration.split(/\s+/).some((token) => consumed.has(token));
  }

  function counterState(style, consumed) {
    const fields = [style.counterReset, style.counterIncrement, style.counterSet]
      .map(cssValue)
      .filter((declaration) => declaration && namesConsumedCounter(declaration, consumed));
    return fields.length > 0 ? "c:" + hashFields(fields) : "";
  }

  function counterParts(root, owners) {
    const consumed = consumedCounterNames(owners);
    if (consumed.size === 0) return [];
    const parts = [];
    function push(style) {
      const state = counterState(style, consumed);
      if (state) parts.push(state);
    }
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      push(getComputedStyle(ancestor));
    }
    for (const owner of owners) {
      push(owner.style);
      push(owner.pseudo.before);
      push(owner.pseudo.after);
    }
    return parts;
  }

  // One signature of everything under `root` (root included — a composition
  // whose only textual motion is a direct text node of the root still moves)
  // that a viewer could see change between two seeks. `options.quantize`
  // selects liveness bucketing (see header). Elements under an author opt-out
  // (data-layout-ignore / data-layout-check=ignore) — typically a decorative
  // layer that may animate off the seeked timeline — are neither signed nor
  // allowed to consume counters: they must not prove that the timeline
  // advanced. They remain counter owners, since their boxes still propagate.
  // fallow-ignore-next-line complexity
  function compositionSignature(root, options) {
    if (!root) return "";
    const quantize = !!(options && options.quantize);
    const parts = [];
    const boxOwners = [];
    const hiddenSubtree = new Set();
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (IGNORE_TAGS.has(element.tagName)) continue;
      const style = getComputedStyle(element);
      if (startsHiddenSubtree(element, style) || hiddenSubtree.has(element.parentElement)) {
        hiddenSubtree.add(element);
        continue;
      }
      const pseudo = {
        before: getComputedStyle(element, "::before"),
        after: getComputedStyle(element, "::after"),
      };
      const opacity = opacityChain(element);
      boxOwners.push({ style, pseudo, painted: paintedContent(element, style, pseudo, opacity) });
      if (element.closest(IGNORE_SELECTOR)) continue;
      if (!isVisibleElement(element, style, opacity)) continue;
      const ctx = { style, pseudo, opacity, quantize };
      parts.push(ELEMENT_CHANNELS.map((channel) => channel(element, ctx)).join(","));
    }
    parts.push(...counterParts(root, boxOwners));
    return parts.join("|");
  }

  window.__hyperframesMotionSignature = {
    compositionRoot,
    isVisibleElement,
    opacityChain,
    compositionSignature,
  };

  // Frozen-sweep guard entry point (checkBrowser.ts collectLayoutGeometry).
  // The name predates the textual/media channels and is kept for driver
  // compatibility.
  window.__hyperframesLayoutGeometry = function collectLayoutGeometry() {
    return compositionSignature(compositionRoot(), { quantize: false });
  };
})();
