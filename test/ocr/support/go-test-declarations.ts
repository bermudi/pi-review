// SPDX-License-Identifier: GPL-3.0-or-later

export interface GoTestDeclaration {
  readonly name: string;
  readonly line: number;
}

export interface GoTestFunction extends GoTestDeclaration {
  /** Exact source bytes for the top-level test function declaration and body. */
  readonly source: string;
}

/**
 * Extract top-level Go test functions without being fooled by declarations
 * embedded in comments or string literals.
 */
export function extractGoTestDeclarations(source: string): readonly GoTestDeclaration[] {
  return extractGoTestFunctions(source).map(({ name, line }) => ({ name, line }));
}

/**
 * Extract top-level Go test functions with their exact declaration/body bytes.
 * The source is deliberately not normalized: a delta must catch edits inside
 * table-driven tests even when their declaration names do not change.
 */
export function extractGoTestFunctions(source: string): readonly GoTestFunction[] {
  const code = maskCommentsAndLiterals(source);
  const declarations: GoTestFunction[] = [];
  let braceDepth = 0;
  let line = 1;

  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (char === "\n") {
      line++;
      continue;
    }
    if (char === "{") {
      braceDepth++;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || !code.startsWith("func", index)) continue;

    const before = index === 0 ? "\n" : code[index - 1];
    if (before !== "\n" && before !== "\r" && before !== " " && before !== "\t") continue;

    const match = code.slice(index).match(
      /^func\s+(Test[A-Za-z0-9_]+)\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s+\*\s*testing\s*\.\s*T\s*\)/,
    );
    const name = match?.[1];
    if (name === undefined || match === null) continue;

    const bodyStart = index + match[0].length;
    const openingBrace = code.indexOf("{", bodyStart);
    if (openingBrace === -1) throw new Error(`test ${name} has no body`);
    const end = matchingBrace(source, openingBrace);
    if (end === -1) throw new Error(`test ${name} has an unclosed body`);
    declarations.push({ name, line, source: source.slice(index, end + 1) });
  }

  return declarations;
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let state: "code" | "line-comment" | "block-comment" | "string" | "raw-string" | "rune" = "code";
  for (let index = openingBrace; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        index++;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        index++;
        state = "block-comment";
      } else if (char === '"') {
        state = "string";
      } else if (char === "`") {
        state = "raw-string";
      } else if (char === "'") {
        state = "rune";
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) return index;
      }
      continue;
    }
    if (state === "line-comment" && char === "\n") {
      state = "code";
    } else if (state === "block-comment" && char === "*" && next === "/") {
      index++;
      state = "code";
    } else if (state === "raw-string" && char === "`") {
      state = "code";
    } else if ((state === "string" || state === "rune") && char === "\\") {
      index++;
    } else if (state === "string" && char === '"') {
      state = "code";
    } else if (state === "rune" && char === "'") {
      state = "code";
    }
  }
  return -1;
}

function maskCommentsAndLiterals(source: string): string {
  // split("") preserves UTF-16 code-unit indexes used by scanner offsets and
  // String#slice; spread would collapse a non-BMP character into one element.
  const output = source.split("");
  let state: "code" | "line-comment" | "block-comment" | "string" | "raw-string" | "rune" = "code";

  const mask = (index: number): void => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        mask(index);
        mask(index + 1);
        index++;
        state = "line-comment";
      } else if (char === "/" && next === "*") {
        mask(index);
        mask(index + 1);
        index++;
        state = "block-comment";
      } else if (char === '"') {
        mask(index);
        state = "string";
      } else if (char === "`") {
        mask(index);
        state = "raw-string";
      } else if (char === "'") {
        mask(index);
        state = "rune";
      }
      continue;
    }

    mask(index);
    if (state === "line-comment" && char === "\n") {
      state = "code";
    } else if (state === "block-comment" && char === "*" && next === "/") {
      mask(index + 1);
      index++;
      state = "code";
    } else if (state === "raw-string" && char === "`") {
      state = "code";
    } else if ((state === "string" || state === "rune") && char === "\\") {
      mask(index + 1);
      index++;
    } else if (state === "string" && char === '"') {
      state = "code";
    } else if (state === "rune" && char === "'") {
      state = "code";
    }
  }

  return output.join("");
}
