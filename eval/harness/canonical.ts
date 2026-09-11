// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 pi-review Contributors

import { createHash } from "node:crypto";

import { EvalContractError } from "./errors.js";

/**
 * Deterministic JSON serialization and hashing for eval evidence.
 *
 * Object keys are sorted recursively, arrays keep their order, and the
 * serializer refuses non-JSON values (undefined, functions, symbols, bigint)
 * instead of silently dropping them — a missing optional field must be an
 * absent property, not a silent `undefined`. Same input bytes in, same hash
 * out is the whole point: corpus manifests and run summaries must be
 * reproducible and comparable by run ID.
 */

export function canonicalJson(value: unknown): string {
	return serialize(value);
}

/** Two-space, sorted-key serialization for human-readable committed artifacts. */
export function stableJson(value: unknown): string {
	return serializePretty(value, 0);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertSerializable(value: unknown): void {
	if (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	) {
		throw new EvalContractError(
			`eval JSON must contain only JSON values; found ${value === undefined ? "undefined" : typeof value}`,
		);
	}
}

function serialize(value: unknown): string {
	assertSerializable(value);
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new EvalContractError("eval JSON numbers must be finite");
		}
		return JSON.stringify(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) {
		return `[${value.map((item) => serialize(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		const body = keys
			.map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key])}`)
			.join(",");
		return `{${body}}`;
	}
	throw new EvalContractError(`eval JSON cannot serialize value of type ${typeof value}`);
}

function serializePretty(value: unknown, depth: number): string {
	assertSerializable(value);
	const pad = "  ".repeat(depth);
	const padInner = "  ".repeat(depth + 1);
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return serialize(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map((item) => `${padInner}${serializePretty(item, depth + 1)}`).join(",\n");
		return `[\n${items}\n${pad}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (keys.length === 0) return "{}";
		const entries = keys
			.map((key) => `${padInner}${JSON.stringify(key)}: ${serializePretty(record[key], depth + 1)}`)
			.join(",\n");
		return `{\n${entries}\n${pad}}`;
	}
	throw new EvalContractError(`eval JSON cannot serialize value of type ${typeof value}`);
}
