const ANSI_TOKEN = /(?:\u001b)?\[([0-9;]*)m|\u001b\[[0-?]*[ -/]*[@-~]|(?:\u001b\]|\])8;;([^\u001b\\]*)(?:\u001b\\|\\)/g;
const ANSI_COLORS = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
];
const ANSI_BRIGHT_COLORS = [
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];
const ANSI_256_LEVELS = [0, 95, 135, 175, 215, 255];

export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function clampRgb(value) {
  return Math.min(255, Math.max(0, Number.parseInt(value, 10)));
}

function createAnsiState() {
  return {
    color: null,
    backgroundColor: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    reverse: false,
  };
}

function rgbStyle(value) {
  return `rgb(${value[0]}, ${value[1]}, ${value[2]})`;
}

function ansi256Color(value) {
  const color = Math.min(255, Math.max(0, Number.parseInt(value, 10)));
  if (color < 8) return ANSI_COLORS[color];
  if (color < 16) return ANSI_BRIGHT_COLORS[color - 8];
  if (color < 232) {
    const index = color - 16;
    return [
      ANSI_256_LEVELS[Math.floor(index / 36)],
      ANSI_256_LEVELS[Math.floor(index / 6) % 6],
      ANSI_256_LEVELS[index % 6],
    ];
  }

  const level = 8 + (color - 232) * 10;
  return [level, level, level];
}

function stateStyle(state) {
  const styles = [];
  const color = state.reverse ? state.backgroundColor : state.color;
  const backgroundColor = state.reverse ? state.color : state.backgroundColor;
  const decorations = [];

  if (color) styles.push(`color: ${rgbStyle(color)};`);
  if (backgroundColor) styles.push(`background-color: ${rgbStyle(backgroundColor)};`);
  if (state.bold) styles.push("font-weight: 700;");
  if (state.dim) styles.push("opacity: 0.72;");
  if (state.italic) styles.push("font-style: italic;");
  if (state.underline) decorations.push("underline");
  if (state.strike) decorations.push("line-through");
  if (decorations.length > 0) styles.push(`text-decoration: ${decorations.join(" ")};`);

  return styles.join(" ");
}

function safeAnsiHref(value) {
  const href = String(value || "").trim();
  if (!href) return null;
  if (/^(?:https?:|mailto:)/i.test(href)) return href;
  if (/^(?:\/(?!\/)|\.\.?\/|#)/.test(href)) return href;
  return null;
}

function renderAnsiText(value, state, href) {
  if (!value) return "";

  let output = escapeHtml(value);
  const style = stateStyle(state);
  if (style) output = `<span style="${style}">${output}</span>`;
  if (href) output = `<a href="${escapeHtml(href)}">${output}</a>`;
  return output;
}

function applyExtendedColor(params, index, state, key) {
  const mode = params[index + 1];
  if (mode === 2) {
    state[key] = [
      clampRgb(params[index + 2]),
      clampRgb(params[index + 3]),
      clampRgb(params[index + 4]),
    ];
    return index + 4;
  }
  if (mode === 5) {
    state[key] = ansi256Color(params[index + 2]);
    return index + 2;
  }

  return index;
}

function applySgrToken(token, state) {
  const params = token === "" ? [0] : token.split(";").map((value) => value === "" ? 0 : Number.parseInt(value, 10));

  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];

    if (!Number.isFinite(code) || code === 0) {
      Object.assign(state, createAnsiState());
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 7) {
      state.reverse = true;
    } else if (code === 9) {
      state.strike = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 27) {
      state.reverse = false;
    } else if (code === 29) {
      state.strike = false;
    } else if (code >= 30 && code <= 37) {
      state.color = ANSI_COLORS[code - 30];
    } else if (code === 39) {
      state.color = null;
    } else if (code >= 40 && code <= 47) {
      state.backgroundColor = ANSI_COLORS[code - 40];
    } else if (code === 49) {
      state.backgroundColor = null;
    } else if (code >= 90 && code <= 97) {
      state.color = ANSI_BRIGHT_COLORS[code - 90];
    } else if (code >= 100 && code <= 107) {
      state.backgroundColor = ANSI_BRIGHT_COLORS[code - 100];
    } else if (code === 38) {
      index = applyExtendedColor(params, index, state, "color");
    } else if (code === 48) {
      index = applyExtendedColor(params, index, state, "backgroundColor");
    }
  }
}

export function renderAsciiContent(value) {
  let output = "";
  const state = createAnsiState();
  let href = null;
  let index = 0;

  for (const match of value.matchAll(ANSI_TOKEN)) {
    output += renderAnsiText(value.slice(index, match.index), state, href);

    if (match[1] !== undefined) {
      applySgrToken(match[1], state);
    } else if (match[2] !== undefined) {
      href = safeAnsiHref(match[2]);
    }

    index = match.index + match[0].length;
  }

  output += renderAnsiText(value.slice(index), state, href);

  return output;
}

export function renderAscii(value) {
  return `<div class="content-block content-block--ascii ascii-block ascii-block--center"><pre class="ascii" data-content-block="ascii">${renderAsciiContent(value)}</pre></div>`;
}

export function safeScriptJson(value) {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

export function splitAsciiAnimationFrames(value) {
  return value
    .split(/\r?\n---\r?\n/)
    .map((frame) => frame.replace(/\s+$/g, ""))
    .filter(Boolean);
}

export function renderAsciiAnimation(value, options = {}) {
  const frames = splitAsciiAnimationFrames(value);
  const renderedFrames = (frames.length > 0 ? frames : [value]).map(renderAsciiContent);
  const interval = Number.isFinite(options.interval) && options.interval > 0 ? options.interval : 180;
  const frameData = safeScriptJson(renderedFrames);

  return `<div class="content-block content-block--ascii ascii-block ascii-block--left"><pre class="ascii ascii-animation" data-content-block="ascii-animation" data-ascii-interval="${interval}">${renderedFrames[0]}</pre></div><script type="application/json" data-ascii-animation-frames>${frameData}</script>`;
}
