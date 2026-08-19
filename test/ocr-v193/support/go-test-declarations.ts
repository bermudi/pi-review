// SPDX-License-Identifier: GPL-3.0-or-later

export interface GoTestDeclaration {
  readonly name: string;
  readonly line: number;
}

/**
 * Extract top-level Go test functions without being fooled by declarations
 * embedded in comments or string literals.
 */
export function extractGoTestDeclarations(source: string): readonly GoTestDeclaration[] {
  const code = maskCommentsAndLiterals(source);
  const declarations: GoTestDeclaration[] = [];
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
    if (name !== undefined) declarations.push({ name, line });
  }

  return declarations;
}

function maskCommentsAndLiterals(source: string): string {
  const output = [...source];
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
