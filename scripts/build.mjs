import { cp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import coreJsCompat from "core-js-compat";
import postcssGlobalData from "@csstools/postcss-global-data";
import postcss from "postcss";
import cssnano from "cssnano";
import autoprefixer from "autoprefixer";
import { readAppMetadata, syncVersionFiles } from "./appMetadata.mjs";
import { compatibilityPolicy } from "./compatibilityPolicy.mjs";
import { writeRuntimeEnvScriptFile } from "./envProperties.mjs";
import { buildI18nBundles } from "./buildI18nBundles.mjs";
import { assSubtitleRuntimeSource } from "./assSubtitleRuntime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const requireConfiguredRuntimeEnv = /^(1|true|yes|on)$/i.test(
  String(process.env.NUVIO_REQUIRE_LOCAL_PROPERTIES || "")
);
const debugBundle = /^(1|true|yes|on)$/i.test(String(process.env.NUVIO_DEBUG_BUNDLE || ""));
const legacyViewport = {
  width: 1920,
  height: 1080,
  remPx: 20
};
const rgbVariableFallbacks = {
  "--bg-color-rgb": "13 13 13",
  "--bg-elevated-rgb": "26 26 26",
  "--card-bg-rgb": "34 34 34",
  "--secondary-color-rgb": "245 245 245",
  "--focus-color-rgb": "255 255 255"
};

function splitTopLevelSpaces(value) {
  const parts = [];
  let current = "";
  let depth = 0;

  for (const char of value) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (/\s/.test(char) && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function splitFunctionArgs(value) {
  const args = [];
  let current = "";
  let depth = 0;

  for (const char of value) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function toLegacyLengthValue(value) {
  let result = value.trim();
  let changed = true;

  while (changed) {
    changed = false;
    result = result.replace(
      /\b(min|max|clamp)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
      (match, fn, argsText) => {
        const args = splitFunctionArgs(argsText).map(toLegacyLengthValue);
        const computed = computeLegacyMathValue(fn, args);
        const replacement =
          computed ||
          (fn === "clamp" ? args[2] || args[1] || args[0] : chooseStaticMathFallback(fn, args));
        changed = true;
        return replacement || match;
      }
    );
  }

  return result;
}

function parseLengthToPx(value) {
  const match = String(value || "")
    .trim()
    .match(/^(-?\d*\.?\d+)(px|vw|vh|rem)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) {
    return null;
  }
  if (unit === "px") {
    return amount;
  }
  if (unit === "vw") {
    return (amount * legacyViewport.width) / 100;
  }
  if (unit === "vh") {
    return (amount * legacyViewport.height) / 100;
  }
  if (unit === "rem") {
    return amount * legacyViewport.remPx;
  }
  return null;
}

function formatPx(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return `${String(rounded)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1")}px`;
}

function computeLegacyMathValue(fn, args) {
  const values = args.map(parseLengthToPx);
  if (values.some((value) => value === null)) {
    return "";
  }

  if (fn === "min") {
    return formatPx(Math.min(...values));
  }
  if (fn === "max") {
    return formatPx(Math.max(...values));
  }
  if (fn === "clamp") {
    const min = values[0];
    const preferred = values[1] ?? min;
    const max = values[2] ?? preferred;
    return formatPx(Math.max(min, Math.min(max, preferred)));
  }
  return "";
}

function chooseStaticMathFallback(fn, args) {
  const parseable = args
    .map((value) => ({ value, px: parseLengthToPx(value) }))
    .filter((entry) => entry.px !== null);
  if (!parseable.length) {
    return args[args.length - 1] || "";
  }
  if (fn === "max") {
    return parseable.reduce((max, entry) => (entry.px > max.px ? entry : max), parseable[0]).value;
  }
  if (fn === "min") {
    return parseable.reduce((min, entry) => (entry.px < min.px ? entry : min), parseable[0]).value;
  }
  return args[2] || args[1] || args[0] || "";
}

function splitRgbChannels(channels) {
  const parts = String(channels || "")
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  return parts.slice(0, 3);
}

function toLegacyColorValue(value) {
  let result = String(value || "");

  result = result.replace(
    /\brgba?\(\s*var\((--[\w-]+)\)\s*\/\s*([^)]+?)\s*\)/g,
    (match, variableName, alpha) => {
      const channels = splitRgbChannels(rgbVariableFallbacks[variableName]);
      if (!channels) {
        return match;
      }
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha.trim()})`;
    }
  );

  result = result.replace(
    /\brgba?\(\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s*\/\s*([^)]+?)\s*\)/g,
    (_match, red, green, blue, alpha) => `rgba(${red}, ${green}, ${blue}, ${alpha.trim()})`
  );

  return result;
}

function insertInsetFallbacks(decl) {
  if (decl.prop.toLowerCase() !== "inset") {
    return;
  }

  const values = splitTopLevelSpaces(decl.value);
  if (!values.length || values.length > 4) {
    return;
  }

  const top = values[0];
  const right = values[1] || top;
  const bottom = values[2] || top;
  const left = values[3] || right;
  const fallbacks = [
    ["top", top],
    ["right", right],
    ["bottom", bottom],
    ["left", left]
  ];

  for (const [prop, value] of fallbacks) {
    decl.cloneBefore({ prop, value });
  }
}

function legacyDeclarationFallbackPlugin(seenSupportsRootBlocks = new Set()) {
  const guardedDeclarations = new WeakSet();
  const lastGuardByRule = new WeakMap();
  return {
    postcssPlugin: "nuvio-legacy-declaration-fallbacks",
    Declaration(decl) {
      if (guardedDeclarations.has(decl)) return;
      insertInsetFallbacks(decl);

      const legacyValue = toLegacyColorValue(toLegacyLengthValue(decl.value));
      if (legacyValue && legacyValue !== decl.value) {
        // Custom properties accept unsupported math as tokens. A later var()
        // substitution then invalidates the consuming property, so duplicate
        // declarations alone cannot provide a legacy fallback.
        if (decl.prop.startsWith("--") && /\b(min|max|clamp)\(/.test(decl.value)) {
          // postcss-global-data injects base.css :root into every processed file,
          // so an identical :root guard would otherwise be emitted for each one.
          if (decl.parent.selector === ":root") {
            const guardKey = `${decl.prop}|${decl.value}`;
            if (seenSupportsRootBlocks.has(guardKey)) {
              decl.value = legacyValue;
              return;
            }
            seenSupportsRootBlocks.add(guardKey);
          }
          const modernDecl = decl.clone();
          guardedDeclarations.add(modernDecl);
          const modernRule = decl.parent.clone({ nodes: [modernDecl] });
          const guard = postcss.atRule({
            name: "supports",
            params:
              "(width: min(1px, 2px)) and (width: max(1px, 2px)) and (width: clamp(1px, 2px, 3px))"
          });
          guard.append(modernRule);
          const previousGuard = lastGuardByRule.get(decl.parent);
          (previousGuard || decl.parent).after(guard);
          lastGuardByRule.set(decl.parent, guard);
          decl.value = legacyValue;
          return;
        }
        const previous = decl.prev();
        if (
          !previous ||
          previous.type !== "decl" ||
          previous.prop !== decl.prop ||
          previous.value !== legacyValue
        ) {
          decl.cloneBefore({ value: legacyValue });
        }
      }
    }
  };
}

legacyDeclarationFallbackPlugin.postcss = true;

function unsupportedSelectorFallbackPlugin() {
  return {
    postcssPlugin: "nuvio-unsupported-selector-fallbacks",
    Rule(rule) {
      if (!rule.selector || !rule.selectors?.length) {
        return;
      }

      const safeSelectors = rule.selectors.filter(
        (selector) =>
          !selector.includes(":focus-visible") &&
          !selector.includes(":has(") &&
          !selector.includes(":focus-within")
      );
      if (!safeSelectors.length || safeSelectors.length === rule.selectors.length) {
        return;
      }

      const fallback = rule.clone({ selectors: safeSelectors });
      rule.before(fallback);
    }
  };
}

unsupportedSelectorFallbackPlugin.postcss = true;

function flexGapFallbackPlugin() {
  return {
    postcssPlugin: "nuvio-flex-gap-fallback",
    Rule(rule) {
      if (
        !rule.selector ||
        (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name))
      ) {
        return;
      }

      let displayFlex = false;
      let rowGap = null;
      let columnGap = null;
      let flexDirection = "row";
      let flexWrap = "nowrap";

      rule.walkDecls((decl) => {
        const prop = decl.prop.toLowerCase();
        if (prop === "display" && /\b(?:inline-)?flex\b/.test(decl.value)) {
          displayFlex = true;
          return;
        }

        if (prop === "flex-direction") {
          flexDirection = decl.value.toLowerCase();
          return;
        }

        if (prop === "flex-wrap") {
          flexWrap = decl.value.toLowerCase();
          return;
        }

        if (prop === "flex-flow") {
          const value = decl.value.toLowerCase();
          if (value.includes("column")) {
            flexDirection = "column";
          }
          // `nowrap` also contains `wrap`; check it first so row-nowrap rules
          // do not inherit the wrap fallback margins.
          if (value.includes("nowrap")) {
            flexWrap = "nowrap";
          } else if (value.includes("wrap")) {
            flexWrap = "wrap";
          }
          return;
        }

        if (prop === "gap") {
          const values = splitTopLevelSpaces(decl.value).map(toLegacyLengthValue);
          rowGap = values[0] || "0";
          columnGap = values[1] || rowGap;
          return;
        }

        if (prop === "row-gap") {
          rowGap = toLegacyLengthValue(decl.value);
          return;
        }

        if (prop === "column-gap") {
          columnGap = toLegacyLengthValue(decl.value);
        }
      });

      if (!displayFlex || (!rowGap && !columnGap)) {
        return;
      }

      rowGap ||= "0";
      columnGap ||= "0";

      const scopedSelectors = rule.selectors.map((selector) =>
        /^html(?=[.#[:\s]|$)/i.test(selector)
          ? selector.replace(/^html\b/i, "html.no-flex-gap")
          : `html.no-flex-gap ${selector}`
      );
      const isColumnDirection = flexDirection.includes("column");
      const wraps = flexWrap.includes("wrap") && !flexWrap.includes("nowrap");
      const childFallback = postcss.rule({
        selectors: scopedSelectors.map((selector) => `${selector} > * + *`)
      });

      if (isColumnDirection) {
        childFallback.append({ prop: "margin-top", value: rowGap });
      } else if (wraps) {
        childFallback.selectors = scopedSelectors.map((selector) => `${selector} > *`);
        childFallback.append({ prop: "margin-right", value: columnGap });
        childFallback.append({ prop: "margin-bottom", value: rowGap });
      } else {
        childFallback.append({ prop: "margin-left", value: columnGap });
      }

      rule.after(childFallback);
    }
  };
}

flexGapFallbackPlugin.postcss = true;

function buildRootVariableMap(allCssTexts) {
  const rawMap = new Map();
  const combinedText = Array.isArray(allCssTexts) ? allCssTexts.join("\n") : String(allCssTexts || "");
  const blockRegex = /(?::root|html[^{]*|body[^{]*|\.modern-sidebar-shell[^{]*|\.home-[^{]*)\{([\s\S]*?)\}/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(combinedText)) !== null) {
    const body = blockMatch[1];
    const declRegex = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
    let match;
    while ((match = declRegex.exec(body)) !== null) {
      const name = match[1].trim();
      const rawValue = match[2].trim();
      const normalized = toLegacyColorValue(toLegacyLengthValue(rawValue));
      if (!rawMap.has(name) || !/\b(min|max|clamp)\(/.test(normalized)) {
        rawMap.set(name, normalized);
      }
    }
  }
  // Fallback sweep for any remaining custom property definitions in any rule
  const anyDeclRegex = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let anyMatch;
  while ((anyMatch = anyDeclRegex.exec(combinedText)) !== null) {
    const name = anyMatch[1].trim();
    if (!rawMap.has(name)) {
      const rawValue = anyMatch[2].trim();
      rawMap.set(name, toLegacyColorValue(toLegacyLengthValue(rawValue)));
    }
  }
  // Resolve nested var(--...) inside definitions
  const resolvedMap = new Map();
  if (!rawMap.has("--primary-color")) {
    rawMap.set("--primary-color", "#f5f5f5");
  }
  for (const [name, value] of rawMap.entries()) {
    resolvedMap.set(name, resolveCssVariables(value, rawMap, new Set([name])));
  }
  return resolvedMap;
}

function resolveCssVariables(value, varMap, visited = new Set()) {
  let result = String(value || "");
  if (!result.includes("var(")) {
    return result;
  }
  let iterations = 0;
  while (result.includes("var(") && iterations < 6) {
    iterations += 1;
    let changed = false;
    let out = "";
    let index = 0;
    while (index < result.length) {
      const start = result.indexOf("var(", index);
      if (start === -1) {
        out += result.slice(index);
        break;
      }
      out += result.slice(index, start);
      let depth = 1;
      let cursor = start + 4;
      while (cursor < result.length && depth > 0) {
        if (result[cursor] === "(") depth += 1;
        else if (result[cursor] === ")") depth -= 1;
        cursor += 1;
      }
      if (depth !== 0) {
        out += result.slice(start);
        break;
      }
      const inner = result.slice(start + 4, cursor - 1);
      const commaIdx = inner.indexOf(",");
      const varName = (commaIdx === -1 ? inner : inner.slice(0, commaIdx)).trim();
      const fallback = commaIdx === -1 ? undefined : inner.slice(commaIdx + 1).trim();
      if (/^--[\w-]+$/.test(varName) && !visited.has(varName)) {
        if (varMap.has(varName)) {
          const nextVisited = new Set(visited);
          nextVisited.add(varName);
          changed = true;
          out += resolveCssVariables(varMap.get(varName), varMap, nextVisited);
          index = cursor;
          continue;
        }
        if (fallback !== undefined) {
          changed = true;
          out += resolveCssVariables(fallback, varMap, visited);
          index = cursor;
          continue;
        }
      }
      out += result.slice(start, cursor);
      index = cursor;
    }
    result = out;
    if (!changed) break;
  }
  return result;
}

function legacyCssVariablesPlugin(varMap) {
  return {
    postcssPlugin: "nuvio-legacy-css-variables",
    Declaration(decl) {
      if (decl.prop.startsWith("--") || !decl.value.includes("var(")) {
        return;
      }
      if (decl.parent?.type === "atrule" || decl.parent?.parent?.name === "supports") {
        return;
      }
      const resolved = toLegacyColorValue(toLegacyLengthValue(resolveCssVariables(decl.value, varMap)));
      if (!resolved || resolved === decl.value || resolved.includes("var(")) {
        return;
      }
      const previous = decl.prev();
      if (
        !previous ||
        previous.type !== "decl" ||
        previous.prop !== decl.prop ||
        previous.value !== resolved
      ) {
        decl.cloneBefore({ value: resolved });
      }
    }
  };
}

legacyCssVariablesPlugin.postcss = true;

function legacyGridFallbackPlugin(varMap = new Map()) {
  return {
    postcssPlugin: "nuvio-legacy-grid-fallback",
    Rule(rule) {
      if (
        !rule.selector ||
        (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name))
      ) {
        return;
      }
      let isGrid = false;
      let isInlineGrid = false;
      let templateColumns = "";
      let gapValue = "";
      let rowGapValue = "";
      let columnGapValue = "";

      rule.walkDecls((decl) => {
        const prop = decl.prop.toLowerCase();
        const resolvedVal = resolveCssVariables(decl.value, varMap);
        if (prop === "display") {
          if (/\binline-grid\b/.test(resolvedVal)) {
            isGrid = true;
            isInlineGrid = true;
          } else if (/\bgrid\b/.test(resolvedVal)) {
            isGrid = true;
          }
        } else if (prop === "grid-template-columns") {
          templateColumns = resolvedVal.trim();
        } else if (prop === "gap") {
          gapValue = toLegacyLengthValue(resolvedVal);
        } else if (prop === "row-gap") {
          rowGapValue = toLegacyLengthValue(resolvedVal);
        } else if (prop === "column-gap") {
          columnGapValue = toLegacyLengthValue(resolvedVal);
        }
      });

      if (!isGrid) return;

      const scopedSelectors = rule.selectors.map((selector) =>
        /^html(?=[.#[:\s]|$)/i.test(selector)
          ? selector.replace(/^html\b/i, "html.no-css-grid")
          : `html.no-css-grid ${selector}`
      );

      const gridFallbackRule = postcss.rule({ selectors: scopedSelectors });
      gridFallbackRule.append({
        prop: "display",
        value: isInlineGrid ? "inline-flex" : "flex"
      });
      gridFallbackRule.append({ prop: "flex-wrap", value: "wrap" });

      const nodesToInsert = [gridFallbackRule];
      const repeatMatch = templateColumns.match(/^repeat\(\s*(\d+)\s*,/i);
      const colGap = columnGapValue || (gapValue ? splitTopLevelSpaces(gapValue)[1] || splitTopLevelSpaces(gapValue)[0] : "0px");
      const rowGap = rowGapValue || (gapValue ? splitTopLevelSpaces(gapValue)[0] : "0px");

      if (repeatMatch) {
        const cols = Number(repeatMatch[1]);
        if (cols > 1 && cols <= 12) {
          const itemRule = postcss.rule({
            selectors: scopedSelectors.map((s) => `${s} > *`)
          });
          const pct = (100 / cols).toFixed(2);
          itemRule.append({ prop: "box-sizing", value: "border-box" });
          itemRule.append({
            prop: "width",
            value: colGap && colGap !== "0" && colGap !== "0px" ? `calc(${pct}% - ${colGap})` : `${pct}%`
          });
          if (colGap && colGap !== "0" && colGap !== "0px") {
            itemRule.append({ prop: "margin-right", value: colGap });
          }
          if (rowGap && rowGap !== "0" && rowGap !== "0px") {
            itemRule.append({ prop: "margin-bottom", value: rowGap });
          }
          nodesToInsert.push(itemRule);
        }
      } else if (/auto-fi(?:ll|t)/i.test(templateColumns)) {
        const minMatch = templateColumns.match(/minmax\(\s*([^,]+)\s*,/i);
        const itemRule = postcss.rule({
          selectors: scopedSelectors.map((s) => `${s} > *`)
        });
        itemRule.append({ prop: "box-sizing", value: "border-box" });
        itemRule.append({ prop: "flex", value: `1 0 ${minMatch ? minMatch[1].trim() : "240px"}` });
        if (colGap && colGap !== "0" && colGap !== "0px") {
          itemRule.append({ prop: "margin-right", value: colGap });
        }
        if (rowGap && rowGap !== "0" && rowGap !== "0px") {
          itemRule.append({ prop: "margin-bottom", value: rowGap });
        }
        nodesToInsert.push(itemRule);
      }

      let anchor = rule;
      for (const node of nodesToInsert) {
        anchor.after(node);
        anchor = node;
      }
    }
  };
}

legacyGridFallbackPlugin.postcss = true;

const BUNDLED_CSS_FILE = "bundle.css";

async function buildCSS() {
  console.log("processing CSS with PostCSS (legacy support)...");
  const cssDir = path.join(rootDir, "css");
  const distCssDir = path.join(distDir, "css");
  const outPath = path.join(distCssDir, BUNDLED_CSS_FILE);
  const files = await readdir(cssDir);

  const componentFiles = files
    .filter((file) => /^components-\d+\.css$/.test(file))
    .sort((a, b) => {
      const numA = Number(a.match(/^components-(\d+)\.css$/)[1]);
      const numB = Number(b.match(/^components-(\d+)\.css$/)[1]);
      return numA - numB;
    });

  // Preserve cascade order: tokens/base first, layout, components, then
  // any future stylesheets, with themes last so overrides win.
  const orderedFiles = ["base.css", "layout.css", ...componentFiles];
  const orderedSet = new Set([...orderedFiles, "components.css", BUNDLED_CSS_FILE]);
  const extraFiles = files
    .filter((file) => file.endsWith(".css") && !orderedSet.has(file) && file !== "themes.css")
    .sort();
  const finalOrder = [...orderedFiles, ...extraFiles, "themes.css"].filter((file) =>
    files.includes(file)
  );

  const remoteImports = [];
  const seenRemoteImports = new Set();
  const seenSupportsRootBlocks = new Set();
  const bodies = [];

  const remoteImportPattern =
    /@import\s+(?:url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)|["'](https?:\/\/[^"']+)["'])\s*[^;]*;/gi;
  const localImportPattern =
    /@import\s+(?:url\(\s*["']?(\.{0,2}\/[^"')]+)["']?\s*\)|["'](\.{0,2}\/[^"']+)["'])\s*[^;]*;/gi;

  const baseCssPath = path.join(cssDir, "base.css");
  const allCssTexts = await Promise.all(
    finalOrder.map((file) => readFile(path.join(cssDir, file), "utf8"))
  );
  const rootVarMap = buildRootVariableMap(allCssTexts);
  for (let fileIndex = 0; fileIndex < finalOrder.length; fileIndex += 1) {
    const file = finalOrder[fileIndex];
    const raw = allCssTexts[fileIndex];

    for (const match of raw.matchAll(remoteImportPattern)) {
      const url = match[1] || match[2];
      if (url && !seenRemoteImports.has(url)) {
        seenRemoteImports.add(url);
        remoteImports.push(`@import url("${url}");`);
      }
    }

    // Strip all @imports: remote ones are hoisted above, local ones are
    // inlined by this concatenation (e.g. components.css manifest).
    const body = raw.replace(remoteImportPattern, "").replace(localImportPattern, "").trim();
    if (body) {
      const needsGlobalData =
        file !== "base.css" && /(?:@media\s*\(\s*--|@custom-selector\b|:-)/.test(body);
      const result = await postcss([
        ...(needsGlobalData ? [postcssGlobalData({ files: [baseCssPath] })] : []),
        autoprefixer({
          overrideBrowserslist: [`Chrome ${compatibilityPolicy.chromiumVersion}`],
          grid: "autoplace"
        }),
        legacyDeclarationFallbackPlugin(seenSupportsRootBlocks),
        legacyCssVariablesPlugin(rootVarMap),
        unsupportedSelectorFallbackPlugin(),
        flexGapFallbackPlugin(),
        legacyGridFallbackPlugin(rootVarMap),
        cssnano()
      ]).process(`/* ${file} */\n${body}`, {
        from: path.join(cssDir, file),
        to: outPath
      });

      bodies.push(result.css);
    }
  }

  const concatenated = [...remoteImports, ...bodies].filter(Boolean).join("\n\n");

  // Only the single bundled file is part of the build output.
  await rm(distCssDir, { recursive: true, force: true });
  await mkdir(distCssDir, { recursive: true });
  await writeFile(outPath, concatenated);
}

async function copyOptionalRootFile(fileName, { fallback = null, defaultContents = "" } = {}) {
  const targetPath = path.join(distDir, fileName);
  try {
    await cp(path.join(rootDir, fileName), targetPath);
    return fileName;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (!fallback) {
    return "";
  }

  try {
    await cp(path.join(rootDir, fallback), targetPath);
    return fallback;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(targetPath, defaultContents, "utf8");
  return "generated-default";
}

let swcModule = null;
async function getSwc() {
  if (!swcModule) {
    if (!process.env.SWC_NATIVE_BINDING_CACHE) {
      const swcCacheDir = path.join(rootDir, ".cache", "swc");
      await mkdir(swcCacheDir, { recursive: true });
      process.env.SWC_NATIVE_BINDING_CACHE = swcCacheDir;
    }
    const imported = await import("@swc/core");
    swcModule = imported.default || imported;
  }
  return swcModule;
}

async function buildCompatScript(esbuildOptions) {
  const { outfile, minify, ...rest } = esbuildOptions;
  const result = await build({
    ...rest,
    target: ["es2020"],
    minify: false,
    write: false
  });
  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild produced no output for ${outfile}`);
  }
  const swc = await getSwc();
  const transformed = await swc.transform(outputFile.text, {
    filename: path.basename(outfile),
    jsc: {
      parser: {
        syntax: "ecmascript"
      },
      target: "es5"
    },
    minify: Boolean(minify),
    sourceMaps: Boolean(esbuildOptions.sourcemap)
  });
  await mkdir(path.dirname(outfile), { recursive: true });
  await writeFile(outfile, transformed.code, "utf8");
  if (transformed.map && esbuildOptions.sourcemap) {
    await writeFile(`${outfile}.map`, transformed.map, "utf8");
  }
  return result;
}

async function buildCoreJsBundle() {
  console.log("building core-js bundle...");
  const { list: requiredModules } = coreJsCompat({
    modules: ["core-js/stable"],
    targets: { chrome: String(compatibilityPolicy.chromiumVersion) }
  });
  if (requiredModules.length === 0) {
    throw new Error("Core-js compatibility query returned no required modules.");
  }
  await buildCompatScript({
    stdin: {
      contents: [
        'import "regenerator-runtime/runtime.js";',
        ...requiredModules.map((moduleName) => `import "core-js/modules/${moduleName}.js";`)
      ].join("\n"),
      resolveDir: rootDir,
      sourcefile: "core-js-entry.js"
    },
    outfile: path.join(distDir, "core-js.bundle.js"),
    bundle: true,
    format: "iife",
    minify: !debugBundle,
    legalComments: "none"
  });
}

async function buildAssSubtitleLibrary() {
  await buildCompatScript({
    stdin: {
      contents: await assSubtitleRuntimeSource(rootDir),
      resolveDir: rootDir,
      sourcefile: "ass-runtime.js"
    },
    bundle: true,
    format: "iife",
    outfile: path.join(distDir, "assets", "libs", "ass.min.js"),
    minify: !debugBundle,
    legalComments: "none"
  });
}

async function buildPluginRuntimeAssets() {
  console.log("building isolated JavaScript plugin runtime...");
  await mkdir(path.join(distDir, "assets", "libs"), { recursive: true });
  await mkdir(path.join(distDir, "assets", "runtime"), { recursive: true });
  const cryptoJsSource = await readFile(
    path.join(rootDir, "node_modules", "crypto-js", "crypto-js.js"),
    "utf8"
  );
  await buildCompatScript({
    entryPoints: [
      path.join(rootDir, "node_modules", "quickjs-emscripten", "dist", "index.global.js")
    ],
    outfile: path.join(distDir, "assets", "libs", "quickjs-emscripten.global.js"),
    bundle: false,
    minify: !debugBundle,
    legalComments: "none"
  });
  await buildCompatScript({
    entryPoints: [path.join(rootDir, "js", "core", "player", "pluginWorker.js")],
    outfile: path.join(distDir, "assets", "runtime", "plugin-worker.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: !debugBundle,
    legalComments: "none",
    define: {
      __NUVIO_CRYPTO_JS_SOURCE__: JSON.stringify(cryptoJsSource)
    }
  });
  await cp(
    path.join(rootDir, "node_modules", "quickjs-emscripten", "LICENSE"),
    path.join(distDir, "assets", "libs", "quickjs-emscripten.LICENSE")
  );
  await cp(
    path.join(rootDir, "node_modules", "crypto-js", "LICENSE"),
    path.join(distDir, "assets", "libs", "crypto-js.LICENSE")
  );
  await buildQuickJsMvpWasm();
}

// The QuickJS WASM embedded in quickjs-emscripten needs sign-ext, non-trapping
// float-to-int and bulk memory (Chrome 74/75), and passes i64 to its imports,
// which needs wasm BigInt integration (Chrome 85). Older engines (Tizen 5.0-6.0,
// webOS 5/6) get this lowered copy with f64 imports instead.
async function buildQuickJsMvpWasm() {
  const { default: binaryen } = await import("binaryen");
  const source = await readFile(
    path.join(
      rootDir,
      "node_modules",
      "@jitl",
      "quickjs-wasmfile-release-sync",
      "dist",
      "emscripten-module.wasm"
    )
  );
  await assertSameAsEmbeddedQuickJsWasm(source);
  const module = binaryen.readBinary(source);
  const F = binaryen.Features;
  module.setFeatures(
    F.MVP | F.MutableGlobals | F.SignExt | F.NontrappingFPToInt | F.BulkMemory | F.BulkMemoryOpt
  );
  module.runPasses([
    "signext-lowering",
    "llvm-nontrapping-fptoint-lowering",
    "llvm-memory-copy-fill-lowering"
  ]);
  passI64ImportsAsF64(binaryen, module);
  module.setFeatures(F.MVP);
  if (!module.validate()) throw new Error("QuickJS MVP WASM lowering failed validation");
  const output = module.emitBinary();
  module.dispose();
  await writeFile(path.join(distDir, "assets", "libs", "quickjs-mvp.wasm"), output);
}

// Engines before wasm BigInt integration (Chrome 85) throw when an import takes
// an i64. The glue reads those arguments (localtime's time_t, fd_seek's offset)
// with Number(), so each import gets an f64 instead behind a converting stub.
function passI64ImportsAsF64(binaryen, module) {
  const imports = [];
  for (let i = 0; i < module.getNumFunctions(); i++) {
    const info = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
    if (info.module && binaryen.expandType(info.params).includes(binaryen.i64)) imports.push(info);
  }
  for (const info of imports) {
    if (info.results === binaryen.i64) throw new Error(`QuickJS import ${info.base} returns i64`);
    const params = binaryen.expandType(info.params);
    const target = `${info.name}$f64`;
    module.addFunctionImport(
      target,
      info.module,
      info.base,
      binaryen.createType(params.map((type) => (type === binaryen.i64 ? binaryen.f64 : type))),
      info.results
    );
    module.removeFunction(info.name);
    const args = params.map((type, index) =>
      type === binaryen.i64
        ? module.f64.convert_s.i64(module.local.get(index, type))
        : module.local.get(index, type)
    );
    module.addFunction(
      info.name,
      info.params,
      info.results,
      [],
      module.call(target, args, info.results)
    );
  }
}

// The worker hands the lowered file to the embedded glue as wasmModule, so its
// imports must match: fail the build if the two packages ever drift apart.
async function assertSameAsEmbeddedQuickJsWasm(expected) {
  const { execFileSync } = await import("node:child_process");
  // A CommonJS child runs the browser bundle as-is and reports the bytes it
  // instantiates, without touching this build's globals.
  const script = `
    const fs = require("fs");
    globalThis.self = globalThis;
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = (b, ...r) => {
      if (ArrayBuffer.isView(b)) process.stdout.write(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64"));
      return instantiate.call(WebAssembly, b, ...r);
    };
    require("vm").runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
    QJS.newQuickJSWASMModule(QJS.RELEASE_SYNC);
  `;
  const embedded = Buffer.from(
    execFileSync(
      process.execPath,
      [
        "-e",
        script,
        path.join(rootDir, "node_modules", "quickjs-emscripten", "dist", "index.global.js")
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      }
    ),
    "base64"
  );
  if (!embedded.equals(expected)) {
    throw new Error(
      "quickjs-emscripten embedded WASM differs from @jitl/quickjs-wasmfile-release-sync"
    );
  }
}

async function buildSubtitleAutoSyncWorker() {
  console.log("building subtitle AutoSync worker...");
  await mkdir(path.join(distDir, "assets", "runtime"), { recursive: true });
  await buildCompatScript({
    entryPoints: [path.join(rootDir, "js", "core", "player", "subtitleAutoSyncWorker.js")],
    outfile: path.join(distDir, "assets", "runtime", "subtitle-autosync-worker.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: !debugBundle,
    legalComments: "none"
  });
}

async function buildBundle() {
  const { version } = await readAppMetadata();

  console.log("starting bundle build...");
  const result = await buildCompatScript({
    entryPoints: [path.join(rootDir, "js/app.js")],
    outfile: path.join(distDir, "app.bundle.js"),
    bundle: true,
    minify: !debugBundle,
    format: "iife",
    sourcemap: debugBundle,
    metafile: true,
    define: {
      "process.env.NODE_ENV": '"production"',
      __NUVIO_APP_VERSION__: JSON.stringify(version)
    }
  });
  if (
    Object.keys(result.metafile.inputs).some((input) => input.includes("node_modules/core-js/"))
  ) {
    throw new Error("Application bundle must not contain core-js modules.");
  }
  console.log("bundle build complete");
}
async function runBuild() {
  try {
    console.log("cleaning dist directory...");
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });

    console.log("building version files...");
    await syncVersionFiles();
    await buildCSS();

    console.log("copying static assets...");
    const copiedAppInfoSource = await copyOptionalRootFile("appinfo.json");
    await Promise.all([
      cp(path.join(rootDir, "assets"), path.join(distDir, "assets"), { recursive: true }),
      cp(path.join(rootDir, "res"), path.join(distDir, "res"), { recursive: true }),
      cp(path.join(rootDir, "boot-guard.js"), path.join(distDir, "boot-guard.js")),
      cp(path.join(rootDir, "docs", "youtube-proxy.html"), path.join(distDir, "youtube-proxy.html"))
    ]);
    await buildI18nBundles({ rootDir, distDir });
    await buildCoreJsBundle();
    await Promise.all([
      cp(
        path.join(rootDir, "node_modules", "hls.js", "dist", "hls.min.js"),
        path.join(distDir, "assets", "libs", "hls.min.js")
      ),
      cp(
        path.join(rootDir, "node_modules", "hls.js", "LICENSE"),
        path.join(distDir, "assets", "libs", "hls.js.LICENSE")
      ),
      cp(
        path.join(rootDir, "node_modules", "dashjs", "dist", "legacy", "umd", "dash.all.min.js"),
        path.join(distDir, "assets", "libs", "dash.all.min.js")
      ),
      cp(
        path.join(rootDir, "node_modules", "dashjs", "LICENSE.md"),
        path.join(distDir, "assets", "libs", "dashjs.LICENSE.md")
      ),
      cp(
        path.join(rootDir, "node_modules", "assjs", "LICENSE"),
        path.join(distDir, "assets", "libs", "assjs.LICENSE")
      )
    ]);
    await buildAssSubtitleLibrary();
    await buildPluginRuntimeAssets();
    await buildSubtitleAutoSyncWorker();
    await cp(
      path.join(rootDir, "node_modules", "libbitsub", "pkg", "libbitsub_bg.wasm"),
      path.join(distDir, "assets", "libs", "libbitsub_bg.wasm")
    );
    await cp(
      path.join(rootDir, "node_modules", "libbitsub", "LICENSE"),
      path.join(distDir, "assets", "libs", "libbitsub.LICENSE")
    );

    if (!copiedAppInfoSource) {
      console.warn("WARNING: skipping appinfo.json because it is not present in the repo root.");
    }

    // js bundle processing (final step to ensure all transformations are applied correctly and we end up with a single, minified bundle file)
    await buildBundle();

    const sourceIndex = await readFile(path.join(rootDir, "index.html"), "utf8");
    // The build ships a single concatenated stylesheet. Rewrite any legacy
    // per-file css/<name>.css references to the bundled output so dist
    // always points at the one file, even if the source still lists several.
    let injectedBundledCss = false;
    const bundledIndex = sourceIndex.replace(
      /[ \t]*<link\s+rel="stylesheet"\s+href="css\/[^"]*"(?:\s*\/?)>[ \t]*\r?\n?/gi,
      () => {
        if (!injectedBundledCss) {
          injectedBundledCss = true;
          return `    <link rel="stylesheet" href="css/${BUNDLED_CSS_FILE}" />\n`;
        }
        return "";
      }
    );
    await writeFile(path.join(distDir, "index.html"), bundledIndex);

    console.log("configuring runtime env from local.properties...");
    const envResult = await writeRuntimeEnvScriptFile(path.join(distDir, "nuvio.env.js"), {
      rootDir
    });
    const envSourceBaseName = path.basename(envResult.sourcePath || "");
    const usingFallbackEnv =
      !envResult.sourcePath || envSourceBaseName === "local.example.properties";
    if (requireConfiguredRuntimeEnv && usingFallbackEnv) {
      throw new Error(
        "Configured runtime env is required for this build. Provide local.properties."
      );
    }
    if (!envResult.sourcePath) {
      console.warn("WARNING: generated default runtime env (unconfigured).");
    } else if (envSourceBaseName === "local.example.properties") {
      console.warn("WARNING: using local.example.properties as fallback.");
    }

    console.log(`\nbuild finished successfully in: ${distDir}`);
  } catch (error) {
    console.error("\nbuild failed:");
    console.error(error);
    process.exit(1);
  }
}

runBuild();
