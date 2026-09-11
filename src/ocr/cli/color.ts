// SPDX-License-Identifier: Apache-2.0
// Ported from cmd/opencodereview/color.go at OCR v1.9.8 commit
// 756203c; maintained through v1.9.9.

export const COLOR_MODES = ["auto", "always", "never"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const ColorModeAuto: ColorMode = "auto";
export const ColorModeAlways: ColorMode = "always";
export const ColorModeNever: ColorMode = "never";
export const AnsiReset = "\u001b[0m";

export function validateColorMode(mode: string): mode is ColorMode {
  return (COLOR_MODES as readonly string[]).includes(mode);
}

export function colorModeError(mode: string): Error {
  return new Error(`invalid --color value "${mode}": must be one of auto, always, never`);
}

export function resolveColor(mode: ColorMode, term: string | undefined, stdoutIsTTY: boolean): boolean {
  if (mode === ColorModeNever) return false;
  if (mode === ColorModeAlways) return true;
  if (term?.toLowerCase() === "dumb") return false;
  return stdoutIsTTY;
}

export function colorize(enabled: boolean, sequence: string, text: string): string {
  return enabled ? `${sequence}${text}${AnsiReset}` : text;
}
