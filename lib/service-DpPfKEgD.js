import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
// node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.6/node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
// node_modules/.pnpm/@deepseek-ai+schemastery@3.18.5/node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
// node_modules/.pnpm/@deepseek-ai+dsh-scope@file_570cabf27357ea20b36cc0002b06fe24/node_modules/@deepseek-ai/dsh-scope/lib/index.js
/**
* Shared insertion-ordered storage and effect ownership for scope-aware registries.
*
* @module @deepseek-ai/dsh-scope
*/
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name) {
		return this.data.get(name);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name) {
		return this.data.has(name);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
/**
* Scoped-context primitive: mint a Cordis context that tags registrations with
* an opaque identity and build routing-only event carriers for that identity.
*
* @module @deepseek-ai/dsh-scope
*/
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = /* @__PURE__ */ new WeakMap();
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
// node_modules/.pnpm/@deepseek-ai+dsh-timeout@fi_90ae6b77a1e527896fa2e8e6de5bc673/node_modules/@deepseek-ai/dsh-timeout/lib/index.js
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
// node_modules/.pnpm/@deepseek-ai+dsh-llm@file+._84ff3804bd6e38f8ce67e485383de710/node_modules/@deepseek-ai/dsh-llm/lib/index.js
/**
* Brand a string as a {@link CallId}.
* @param id - the provider-issued (or synthesized) call id.
* @returns the same string, branded; no validation is performed.
*/
function CallId(id) {
	return id;
}
/**
* Deep-freeze a value in place with an iterative traversal, guarding cycles,
* so later mutation throws without imposing a JavaScript call-stack depth cap.
* {@link AbortSignal} objects are deliberately skipped because they are the
* request's live cancellation channel and freezing them breaks abort.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = Schema.object({
	initialDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = Schema.object({
	mode: Schema.const("normal").required(),
	maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = Schema.object({
	mode: Schema.const("always").required(),
	backoff: backoffSchema
});
Schema.union([normalPolicySchema, alwaysPolicySchema]);
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
/**
* Exhaustiveness helper for closed core unions. Use {@link assertNever} at the default branch so a
* new variant fails compilation at every required handler. Do not use it for declaration-merged
* unions such as session events or content blocks: handle known variants and explicitly fall
* through because plugins may add valid unknown cases.
* @module @deepseek-ai/dsh-llm/never
*/
/**
* Mark an unreachable closed-union branch. A newly unhandled typed variant fails at the call site;
* a value that escaped its type throws with diagnostics at runtime.
* @param value - the impossible value; typed `never` so an unhandled variant fails compilation at the call site.
* @param context - optional label (e.g. the switch site) prefixed into the throw message.
* @returns never — it always throws, with the offending value JSON-rendered in the message.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
// node_modules/.pnpm/@deepseek-ai+dsh-session@fi_c6ec4018e1c07897034cf88b0043980f/node_modules/@deepseek-ai/dsh-session/lib/index.js
/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype$1(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target = detach ? [] : void 0;
			if (target !== void 0) assign(task.destination, target);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target === void 0 ? {} : { target }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property, so a stateful
* getter cannot change between validation and copying. Traversal is iterative,
* so valid nesting is bounded by available memory rather than the JavaScript
* call stack. Accepts ordinary arrays, plain or null-prototype objects, and JSON
* scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
* Getter throws propagate.
*
* @param value - the candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not
*   losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON boundary as {@link snapshotJsonValue} without
* detaching it. Only own enumerable string properties participate; `toJSON`
* is ignored and getters run, so persistence boundaries use the snapshotter.
* @param value - the candidate event data to test.
* @returns whether `value` survives JSON round-trip losslessly.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
// node_modules/.pnpm/@deepseek-ai+dsh-tools@file_9d78c929f908752253b9d9806188a265/node_modules/@deepseek-ai/dsh-tools/lib/index.js
/**
* Enforced JSON Schema subset shared by tool outputs, generated Code Mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = /* @__PURE__ */ new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = /* @__PURE__ */ new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of": destination.target[destination.index] = node;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* Code Mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/code-mode
*/
/** The model-facing name of the Code Mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Write the BODY of an async function (erasable syntax only; top-level `await` and `return` work) and call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return comes back — curate it.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Write the BODY of an async function (top-level `await` and `return` work) and call tools as `await tools.name(args)` per the declarations in the system prompt. Answer with `print(...)` and/or `return <value>` — only that comes back, so curate it.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift.
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requireCodeRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requireCodeRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name) => JSON.stringify(name)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* Build the `run_code` {@link ToolDefinition}: required `code` and
* `description` parameters, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" }
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (name) => async (rawArgs) => {
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = CallId(`${String(exec.callId)}:code:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_REGISTRY_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/code-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged,
								isError: result.isError,
								content: logged
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/code-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(schema.name)
				});
			}
			try {
				let result;
				try {
					result = await runtime.run({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal
					});
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
				}
				return {
					logs: result.logs,
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.description,
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => resolveFlavor(peekRuntime).description
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		})
	});
	return definition;
}
/**
* Code Mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
* text the model programs against (the `tools:sdk` prompt section). Sibling of
* `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
* `declare const tools` surface) are two projections of the same store.
* @module @deepseek-ai/dsh-tools/src/ts-types
*/
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
	return IDENTIFIER$1.test(name) ? name : JSON.stringify(name);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts.push(child);
				}
				finish(typeDocumentFrom(parts));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name)}${required.has(name) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			/* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the Code Mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

Pass \`run_code\` the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped). Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. ONLY what you print or return comes back to you — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	return `${SDK_INSTRUCTIONS$1}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${[
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n")}\n\`\`\``;
}
/**
* Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
* runtime's language}.
*
* Under `mode: 'code'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
* alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module @deepseek-ai/dsh-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
*
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'code'` is this generated text.
*
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
*
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
*
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
*
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch Agent Note records the deferral.
*
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name) {
	return IDENTIFIER.test(name) && name.normalize("NFKC") === name;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = /* @__PURE__ */ new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'code'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
*
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
*
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
*
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — Code Mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
*
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
*
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
*
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
*
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name = capped;
	if (state.usedClassNames.has(name)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name);
	return name;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
*
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
*
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
*
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
*
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema, className, listDepth) => ({
		schema,
		className,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node = frame.node;
				const name = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node === void 0 || name === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node.required);
				const lines = [`class ${name}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith("__") && !name.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				/* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

Pass \`run_code\` the body of an async Python function (top-level \`await\` and \`return\` both work). At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: /* @__PURE__ */ new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
/**
* Tool registry, model presentation modes, and pre/guard/around/post/result
* execution pipeline.
* @module @deepseek-ai/dsh-tools
*/
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link CodeSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-code-runtime` README pair, its
* `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_REGISTRY_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	constructor(toolName) {
		super(`unknown tool "${toolName}"`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits an inherited tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
/**
* Tool registry and execution pipeline. Scoped registrations shadow globals;
* one visibility resolver feeds presentation, lookup, and dispatch.
*/
var ToolRegistry = class extends Service {
	static inject = ["systemPrompt"];
	static Config = Schema.object({
		mode: Schema.union([
			"native",
			"code",
			"both"
		]).default("native"),
		maxParallelSubCalls: Schema.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_REGISTRY_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for agents that declare none; {@link presentAs} shadows it per agent. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a code mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	codeTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") ctx.systemPrompt.section(this.sdkSection());
	}
	/**
	* The generated-SDK prompt section, registered globally by a code-mode
	* deployment and per agent by {@link presentAs}.
	*
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a code-mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: 150,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requireCodeRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	*
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requireCodeTransport() {
		this.codeTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
			peekRuntime: () => this.ctx.get("codeRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.codeTransport;
	}
	/**
	* Present this agent's tools in `mode` instead of the deployment default.
	*
	* Scoped only, and one declaration per agent: this is how an agent preset
	* composes a Code Mode agent beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation this agent's model sees.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this agent; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") yield ctx.systemPrompt.section(this.sdkSection());
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
			knownNames: [...view.knownNames]
		};
		this.requireCodeRuntime(mode);
		const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition, false));
		if (mode === "code") return {
			schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
		return {
			schemas,
			knownNames: [...view.knownNames, RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the code runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a code runtime existing even under `mode:
	* 'native'` (the loop's optional-backend idiom, same as
	* `sessionPersistence`).
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable); rationale in the
	* [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
	*/
	requireCodeRuntime(mode) {
		const runtime = this.ctx.get("codeRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name) => JSON.stringify(name)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-surface mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown inherited tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; a restriction filters what this scope inherits, never what it registers itself. Restrictable tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	*
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's reporting and structured-output
	* tools into the child's own layer, and a filter naming the capabilities the
	* child may use must not strip the machinery it answers through.
	*
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, definition] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
		}
		if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope) {
		return this.view(scope).visible.get(name);
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
	}
	/** Project visible callable tools onto the generated Code Mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition, true),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name, description, parameters } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.get(exec.name, exec.agent);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/code-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/code-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const definition = this.get(name, agent);
		const finalizeContent = definition?.finalizeContent?.bind(definition);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizeContent);
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizeContent);
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.get(exec.name, exec.agent);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const postResult = await this.postExecute(exec, result);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.get(exec.name, exec.agent);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.get(exec.name, exec.agent);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
};
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
// lib/types/actions.js
/**
* The action-catalog contract between the pets and the driver: a pet
* ADVERTISES what it can perform (`capabilities.actions` — its own menu,
* derived from its own media), and the driver validates requests against
* that menu instead of hardcoding one. Pure functions only — the seam where
* catalog drift between pet implementations must die.
* @module dsh-agentic-pet/actions
*/
/** Defensive extraction from a raw /capabilities payload: implementations
* may omit or mistype anything. */
function normalizeCapabilities(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const actions = Array.isArray(record.actions) ? record.actions.filter((entry) => typeof entry === "string") : [];
	return {
		contractVersion: typeof record.contractVersion === "number" ? record.contractVersion : null,
		actions: actions.length > 0 ? actions : null
	};
}
/**
* Resolve a pet_do request against a pet's advertised catalog.
* - `celebrate` is the universal alias every pet must honor regardless of
*   its catalog (driver.ts's ledger milestones depend on it).
* - `random` means "you pick": one draw from the pet's own menu (the
*   draw lives here, driver-side, so pets that validate /action against
*   their vocabulary — pure does — never see a sentinel they must reject).
* - Anything else must be IN the catalog; `null` catalog admits only
*   celebrate.
*/
function resolveActionRequest(requested, catalog) {
	if (requested === "celebrate") return {
		kind: "ok",
		action: "celebrate"
	};
	if (requested === "random") {
		const pool = catalog === null ? [] : catalog.filter((entry) => entry !== "celebrate");
		const menu = pool.length > 0 ? pool : ["celebrate"];
		const pick = menu[Math.floor(Math.random() * menu.length)];
		return pick === void 0 ? {
			kind: "ok",
			action: "celebrate"
		} : {
			kind: "ok",
			action: pick
		};
	}
	if (catalog !== null && catalog.includes(requested)) return {
		kind: "ok",
		action: requested
	};
	return {
		kind: "unknown",
		available: catalog ?? ["celebrate"]
	};
}
/** The error-message menu: long catalogs are previewed, with a pointer to
* pet_state {actions:true} for the full list. */
function formatAvailableActions(available, cap = 24) {
	const shown = available.slice(0, cap).join("、");
	const rest = available.length - Math.min(cap, available.length);
	return rest > 0 ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)` : shown;
}
// lib/types/petdata.js
/**
* The per-pet data store: everything the DRIVER persists about a pet lives
* under `~/.dsh/whale598/<petId>/` — affection ledger, display name, event
* history, tool-call history. One directory per pet, small files, single
* writer (the driver), JSONL for append-only streams with bounded retention.
*
* Legacy layouts (`pet-affection.d/<id>.json`, the single legacy electron
* book, names inside pet-settings.json) are READ as fallbacks and migrate to
* the new layout on the next write — lazy migration, no data-loss window.
* @module dsh-agentic-pet/petdata
*/
/** The consolidated per-pet data root under the dsh home. */
const WHALE_DIR = "whale598";
function petDataDir(home, petId) {
	return join(home, WHALE_DIR, petId);
}
/** New-layout path first; legacy layouts as read fallbacks (per-pet legacy
* dir → the single legacy electron book). The ledger SHAPE is the driver's
* (TouchLedger); this module only owns paths and raw IO. */
function affectionPaths(home, petId) {
	return {
		current: join(petDataDir(home, petId), "pet-affection.json"),
		legacy: [join(home, "pet-affection.d", `${petId}.json`), ...petId === "electron" ? [join(home, "pet-affection.json")] : []]
	};
}
/** Read the affection ledger raw: the current file wins; legacy files answer
* only while the current one is absent (first write migrates the full
* ledger). Returns null when no layout holds data. */
async function readAffectionRaw(home, petId) {
	const { current, legacy } = affectionPaths(home, petId);
	for (const file of [current, ...legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0) return parsed;
	} catch {}
	return null;
}
async function writeAffectionRaw(home, petId, ledger) {
	const dir = petDataDir(home, petId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "pet-affection.json"), `${JSON.stringify(ledger)}\n`, "utf8");
}
function petNameFile(home, petId) {
	return join(petDataDir(home, petId), "pet-name.json");
}
/** The user's custom display name: new-layout file → legacy
* pet-settings.json `names` map → undefined (caller applies the built-in
* default). */
async function readPetName(home, petId) {
	try {
		const parsed = JSON.parse(await readFile(petNameFile(home, petId), "utf8"));
		if (typeof parsed.name === "string" && parsed.name.trim() !== "") return parsed.name.trim();
	} catch {}
	try {
		const settings = JSON.parse(await readFile(join(home, "pet-settings.json"), "utf8"));
		const label = (typeof settings.names === "object" && settings.names !== null ? settings.names : {})[petId];
		if (typeof label === "string" && label.trim() !== "") return label.trim();
	} catch {}
}
/** Persist a custom name; `null` reverts to the built-in default (drops the
* override file). Also strips the petId key from the legacy pet-settings
* names map so the old layout cannot resurrect a cleared name. */
async function writePetName(home, petId, name) {
	const dir = petDataDir(home, petId);
	await mkdir(dir, { recursive: true });
	const file = petNameFile(home, petId);
	if (name === null || name.trim() === "") await rm(file, { force: true });
	else await writeFile(file, `${JSON.stringify({ name: name.trim() })}\n`, "utf8");
	try {
		const settingsPath = join(home, "pet-settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		if (typeof settings.names === "object" && settings.names !== null && petId in settings.names) {
			Reflect.deleteProperty(settings.names, petId);
			if (Object.keys(settings.names).length === 0) delete settings.names;
			await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		}
	} catch {}
}
const JSONL_MAX_LINES = 600;
const JSONL_KEEP_LINES = 500;
function eventsFile(home, petId) {
	return join(petDataDir(home, petId), "events.jsonl");
}
/** Append one record; bounded retention trims the file when it outgrows the
* cap (best-effort — a failed trim never loses the append). */
async function appendJsonl(file, entry) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
	try {
		const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
		if (lines.length > JSONL_MAX_LINES) await writeFile(file, `${lines.slice(lines.length - JSONL_KEEP_LINES).join("\n")}\n`, "utf8");
	} catch {}
}
/** The last `limit` records (oldest last); malformed lines degrade to
* `{raw}` instead of dropping the file. */
async function readJsonl(file, limit) {
	try {
		return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "").slice(-limit).map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { raw: line };
			}
		});
	} catch {
		return [];
	}
}
const GLOBAL_STATE_FILES = [
	"pet-settings.json",
	"pet-inner-voice.json",
	"pet-wake-plans.json",
	"pet-interactions.json",
	"pet-world.json",
	"pet-window.json"
];
function globalPaths(home, name) {
	return {
		current: join(home, WHALE_DIR, name),
		legacy: join(home, name)
	};
}
function globalFilePath(home, name) {
	return globalPaths(home, name).current;
}
/** Rename legacy → current for every global file that hasn't moved yet.
* Best-effort: a failed rename leaves the legacy copy in place and the read
* fallback still answers. Called once at driver install. */
async function migrateGlobals(home) {
	await mkdir(join(home, WHALE_DIR), { recursive: true });
	for (const name of GLOBAL_STATE_FILES) {
		const { current, legacy } = globalPaths(home, name);
		try {
			if (existsSync(current) || !existsSync(legacy)) continue;
			await rename(legacy, current);
		} catch {}
	}
}
/** Read a global state file: current → legacy → {} (callers' defensive
* field checks treat {} exactly like a missing file). */
async function readGlobalJson(home, name) {
	const { current, legacy } = globalPaths(home, name);
	for (const file of [current, legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch {}
	return {};
}
/** Write a global state file (current location only; pretty-printed — these
* files are user-inspectable and hand-editable). */
async function writeGlobalJson(home, name, obj) {
	const { current } = globalPaths(home, name);
	await mkdir(dirname(current), { recursive: true });
	await writeFile(current, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
// lib/types/inner-voice.js
const VOICE_SESSION_PREFIX = "whale598-";
/**
* Saved-setting migration for preset id renames: pet-settings.json holds the
* user's 会话模式 choice by id, and a rename orphans that saved value (every
* ensure would first try a dead id and fall back). Map the legacy ids onto
* their successors; unknown ids pass through untouched.
*/
const LEGACY_PRESET_IDS = {
	"pet-inner-voice": "whale598",
	"pet": "whale598-standard"
};
function migratePreset(preset) {
	return LEGACY_PRESET_IDS[preset] ?? preset;
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite01 = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
/** Read `innerVoice` from pet-settings.json; anything missing or mistyped
* folds to its default (defensive parse, `readAutonomy` precedent). */
async function readInnerVoiceConfig(home) {
	try {
		const raw = await readGlobalJson(home, "pet-settings.json");
		const v = typeof raw.innerVoice === "object" && raw.innerVoice !== null ? raw.innerVoice : {};
		const legacyMinutes = typeof v.touchReplyCooldownMinutes === "number" && Number.isFinite(v.touchReplyCooldownMinutes) ? v.touchReplyCooldownMinutes : void 0;
		const secondsRaw = typeof v.touchReplyCooldownSeconds === "number" && Number.isFinite(v.touchReplyCooldownSeconds) ? v.touchReplyCooldownSeconds : legacyMinutes !== void 0 ? legacyMinutes * 60 : void 0;
		const boundSessions = {};
		if (typeof v.boundSessions === "object" && v.boundSessions !== null) {
			for (const [petId, sessionId] of Object.entries(v.boundSessions)) if (petId !== "" && typeof sessionId === "string" && sessionId !== "") boundSessions[petId] = sessionId;
		}
		return {
			enabled: v.enabled !== false,
			preset: migratePreset(typeof v.preset === "string" && v.preset !== "" ? v.preset : "whale598"),
			wakeIntervalMinutes: typeof v.wakeIntervalMinutes === "number" && Number.isFinite(v.wakeIntervalMinutes) ? clamp(Math.round(v.wakeIntervalMinutes), 1, 60) : 2,
			speakProbability: finite01(v.speakProbability, .5),
			touchReplyProbability: finite01(v.touchReplyProbability, .3),
			touchReplyCooldownSeconds: secondsRaw === void 0 ? 30 : clamp(Math.round(secondsRaw), 0, 600),
			selfWakeBusyPolicy: v.selfWakeBusyPolicy === "defer" ? "defer" : "fire",
			boundSessions
		};
	} catch {
		return {
			enabled: true,
			preset: "whale598",
			wakeIntervalMinutes: 2,
			speakProbability: .5,
			touchReplyProbability: .3,
			touchReplyCooldownSeconds: 30,
			selfWakeBusyPolicy: "fire",
			boundSessions: {}
		};
	}
}
/** Defensive extraction of one pet's plan list: only well-formed plans
* survive (id/intent non-empty strings, at/createdAt finite numbers). */
function plansOf(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item;
		if (typeof rec.id !== "string" || rec.id === "" || typeof rec.at !== "number" || !Number.isFinite(rec.at) || typeof rec.intent !== "string" || rec.intent === "" || typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) continue;
		out.push({
			id: rec.id,
			at: rec.at,
			intent: rec.intent,
			createdAt: rec.createdAt
		});
	}
	return out;
}
/** Load every pet's pending wake plans: current → legacy → {} (callers'
* defensive checks treat {} exactly like a missing file). */
async function loadWakePlans(home) {
	try {
		const raw = await readGlobalJson(home, "pet-wake-plans.json");
		const byPet = typeof raw.plans === "object" && raw.plans !== null ? raw.plans : {};
		const out = {};
		for (const [petId, list] of Object.entries(byPet)) {
			if (petId === "") continue;
			const plans = plansOf(list);
			if (plans.length > 0) out[petId] = plans;
		}
		return out;
	} catch {
		return {};
	}
}
async function saveWakePlans(home, plans) {
	try {
		await writeGlobalJson(home, "pet-wake-plans.json", { plans });
	} catch (error) {
		console.error(`pet-surface inner-voice: could not write the wake plans: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/** Remove one plan by id (or ALL when id is undefined). Returns the removed
* plans so the caller can report them; an empty removal is the unknown-id
* case the caller turns into a self-correcting error. */
function cancelPlans(list, id) {
	if (id === void 0) return {
		next: [],
		removed: [...list]
	};
	return {
		next: list.filter((entry) => entry.id !== id),
		removed: list.filter((entry) => entry.id === id)
	};
}
/** Consume every DUE plan (at <= now): they leave the pending set for good —
* a consumed plan must produce a wake, never a silent drop. Future plans
* survive untouched (被打断不碰 plans). */
function takeDuePlans(list, now) {
	return {
		next: list.filter((entry) => entry.at > now),
		due: list.filter((entry) => entry.at <= now)
	};
}
/** The ±60s merge window: a plan due around NOW folds into a user-initiated
* turn instead of firing its own wake a minute later (同一分钟不醒两次). */
function takeNearDuePlan(list, now, windowMs = 6e4) {
	const plan = list.find((entry) => Math.abs(entry.at - now) <= windowMs);
	if (plan === void 0) return {
		next: list,
		plan: void 0
	};
	return {
		next: list.filter((entry) => entry !== plan),
		plan
	};
}
/** Plans among `due` that went stale BEFORE the driver came up (at < bootAt):
* the catch-up wake says 「错过了 N 个计划」 and lists them together instead
* of bombing one wake per missed plan. */
function missedPlans(due, bootAt) {
	return due.filter((entry) => entry.at < bootAt);
}
/** Defensive extraction of the persisted generation counters (petId → n). */
function generationsOf(raw) {
	const out = {};
	if (typeof raw.generations === "object" && raw.generations !== null) {
		for (const [petId, n] of Object.entries(raw.generations)) if (petId !== "" && typeof n === "number" && Number.isFinite(n) && n >= 0) out[petId] = Math.floor(n);
	}
	return out;
}
async function loadInnerVoiceStore(home) {
	try {
		const raw = await readGlobalJson(home, "pet-inner-voice.json");
		const sessions = {};
		for (const [petId, entry] of Object.entries(typeof raw.sessions === "object" && raw.sessions !== null ? raw.sessions : {})) {
			const record = entry;
			if (typeof record?.sessionId === "string" && record.sessionId !== "") sessions[petId] = {
				sessionId: record.sessionId,
				createdAt: typeof record.createdAt === "number" ? record.createdAt : 0
			};
		}
		return {
			sessions,
			generations: generationsOf(raw)
		};
	} catch {
		return {
			sessions: {},
			generations: {}
		};
	}
}
async function saveInnerVoiceStore(home, store) {
	try {
		await writeGlobalJson(home, "pet-inner-voice.json", store);
	} catch (error) {
		console.error(`pet-surface inner-voice: could not write the store: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function voiceSessionIdFor(petId) {
	return `${VOICE_SESSION_PREFIX}${petId}`;
}
/** Mint the next voice session id: the bare base for generation 0, `-gN`
* after any retire. The generation counter lives in memory only — a desktop
* restart resets it to zero while the archive set still holds every retired
* id, so a naive mint lands on an ARCHIVED ancestor: the platform accepts
* the prompt (bare `accepted` receipt) but its gate silently blocks every
* turn of an archived session — born dead, retired by the 25s window, and
* the replacement collides again (field spiral 2026-10-31, g1→g3 dead on
* arrival). The mint therefore SKIPS any id the archive authority still
* holds; with the counter reset this walks past g1..g16 to the first free
* slot. The hop cap keeps a pathological archive set from spinning forever.
* Returns the (possibly advanced) generation so callers persist it — a
* later mint must not reuse a skipped id either — plus the hop count for
* the skip log line. */
function mintVoiceSessionId(petId, generation, isArchived) {
	const MINT_HOP_CAP = 500;
	let g = Math.max(0, Math.floor(generation));
	let sessionId = `${voiceSessionIdFor(petId)}-g${String(g)}`;
	let hops = 0;
	while (isArchived(sessionId) && hops < MINT_HOP_CAP) {
		g += 1;
		sessionId = `${voiceSessionIdFor(petId)}-g${String(g)}`;
		hops += 1;
	}
	return {
		sessionId,
		generation: g,
		hops
	};
}
/** The boot-greeting prompt: fired once per dsh start when the pet first
* comes online — before the random-wake cadence takes over. Always speaks
* (no probability gate on this one); the time context rides the preset. */
function buildGreetPrompt(facts) {
	return [
		"[启动问好]",
		`用户刚打开 DeepSeek，你的世界刚亮起来（好感 ${String(facts.affection)}，${moodOf(facts.affection)}；羁绊 ${facts.bondTier}，一起过了 ${String(facts.bondDays)} 天）。`,
		"主动打个招呼（pet_say）——按当下的时辰自然问好，一两句就好，别问问题等回答。"
	].join(" ");
}
/** B 层 · 羁绊档位：days-with-interaction → tier name. Only grows, never
* decays; the names are the display contract (settings page keeps its own
* copy of the thresholds). */
const BOND_TIERS = [
	{
		since: 0,
		name: "陌生"
	},
	{
		since: 5,
		name: "认识"
	},
	{
		since: 15,
		name: "熟了"
	},
	{
		since: 40,
		name: "亲近"
	},
	{
		since: 90,
		name: "离不开"
	},
	{
		since: 180,
		name: "只有你"
	}
];
function bondTier(days) {
	let tier = BOND_TIERS[0]?.name ?? "陌生";
	for (const t of BOND_TIERS) if (days >= t.since) tier = t.name;
	return tier;
}
/** Shared mood vocabulary (pet_state computes the same from the ledger). */
function moodOf(affection) {
	return affection >= 80 ? "happy" : affection >= 40 ? "content" : "neutral";
}
/** Touch part → spoken wording; `unknown` never earns a reply turn (the
* driver filters it before building a prompt). */
function touchPartWording(part) {
	if (part === "head") return "头";
	if (part === "body") return "身体";
}
/** Local HH:mm for plan times: the model's clock talk is the USER's wall
* clock (logStamp precedent), and plans are compared against it. */
const wakePlanClock = (at) => {
	const d = new Date(at);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** The wake prompt. Time context is injected by the preset's time-context
* row; the leading tag doubles as the durable trigger marker in the log —
* and now names the SOURCE: [世界时钟] (the environment's tick), [自主唤醒]
* (the model's own schedule, with the original intent), or the merged form. */
function buildWakePrompt(facts) {
	const lastSpoke = facts.minutesSinceLastSpoke === void 0 ? "这是你今天第一次醒来" : `你上次开口是 ${String(facts.minutesSinceLastSpoke)} 分钟前`;
	const user = facts.userActive ? `用户最近正在会话中工作（${String(facts.minutesSinceUserActivity ?? 0)} 分钟内有动静）` : "用户最近没有活动";
	const ledgerLine = `好感 ${String(facts.affection)}（${moodOf(facts.affection)}）；羁绊 ${facts.bondTier}（一起过了 ${String(facts.bondDays)} 天）；${lastSpoke}；${user}。`;
	const source = facts.source ?? "world";
	const lines = [];
	if (source === "world") lines.push("[世界时钟]", `环境节拍到了。${ledgerLine}`);
	else {
		const due = facts.dueIntents ?? [];
		const reason = source === "self" ? "这是你自己定下的唤醒计划到点了" : "世界时钟与你定下的计划同时到点，合并成这一次醒来";
		const missed = facts.missedCount ?? 0;
		const missedLine = missed > 0 ? `你离线期间错过了 ${String(missed)} 个已到期计划，和这次的一并处理；` : "";
		const overdueLine = facts.overdue === true ? "（注意：这个计划定下时时间就已过了，现在是补醒）" : "";
		lines.push(source === "self" ? "[自主唤醒]" : "[世界时钟+自主唤醒]", `${reason}${overdueLine}。${missedLine}你当初的打算：${due.map((intent) => `「${intent}」`).join("、")}。${ledgerLine}`);
	}
	const pending = facts.pendingPlans ?? [];
	if (pending.length > 0) lines.push(`你还有 ${String(pending.length)} 个待执行计划：${pending.map((plan) => `${wakePlanClock(plan.at)}「${plan.intent}」`).join("；")}。继续等待、改时间或取消由你决定（pet_schedule_wake 同名覆盖即改期，pet_cancel_wake 撤销）。`);
	lines.push("醒来想到什么就说一句（pet_say），想配动作就 pet_do；也可以只是安静待着（两者都不调，正文写「…」）。");
	return lines.join(" ");
}
function buildTouchPrompt(facts) {
	const wording = touchPartWording(facts.part) ?? "身体";
	const merged = facts.mergedPlan === void 0 ? "" : `你定的计划「${facts.mergedPlan.intent}」也正好到点，这次一并处理；`;
	return [
		facts.mergedPlan === void 0 ? "[被触摸]" : "[用户+自主唤醒]",
		`用户刚摸了你的${wording}（今天第 ${String(facts.touchesToday)} 次，好感 ${String(facts.affection)}，${moodOf(facts.affection)}）。${merged}`,
		"回应一句（pet_say）或做个反应（pet_do）。"
	].join(" ");
}
/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
* pet's surface. The text rides verbatim — the pet answers through pet_say
* (and may pet_do); it is a conversation turn, not a touch reaction. Length
* clamps to the contract's 2000-character ceiling. A plan inside the ±60s
* merge window folds in: the tag becomes the union and the intent rides. */
function buildChatPrompt(text, mergedPlan) {
	return `${mergedPlan === void 0 ? "" : `[用户+自主唤醒] 用户正在跟你说话，恰好也到了你定的计划点（${wakePlanClock(mergedPlan.at)}「${mergedPlan.intent}」），合并成这一次醒来。\n`}[用户对你说] ${text.slice(0, 2e3)}`;
}
// lib/types/registry.js
/**
* The pet registry: a directory of per-pet control manifests. Each pet
* implementation owns its own file under whale598/pet-http.d/ (named by its
* pet id) and re-asserts it on a cadence; entries whose publisher pid is dead
* expire by omission. The driver reads the whole table and routes per the
* multi-pet design: a session's state rides its bound pet when that pet is
* alive and broadcasts to every live pet otherwise; interactions broadcast to
* all; the default pet (earliest-booted) resolves unnamed expression targets.
* @module dsh-agentic-pet/registry
*/
const REGISTRY_DIR = `${WHALE_DIR}/pet-http.d`;
/**
* A live pet is one whose control plane ANSWERS, not merely one whose pid
* exists — and not merely one whose port accepts TCP: a frozen pet (stuck
* Qt/Electron event loop) keeps its listening socket open in the kernel, so
* TCP connect succeeds while HTTP never responds. Two layers, each with its
* own budget: a 200ms TCP pre-check fails fast on unreachable ports (a
* firewall dropping SYN would otherwise eat the whole HTTP budget), then the
* HTTP probe catches the frozen-but-listening zombies.
*/
async function probeControlPlane(port) {
	const { createConnection } = await import("node:net");
	if (!await new Promise((resolve) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port
		});
		const done = (ok) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(200, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	})) return false;
	try {
		return (await fetch(`http://127.0.0.1:${String(port)}/status`, { signal: AbortSignal.timeout(800) })).ok;
	} catch {
		return false;
	}
}
/**
* The default-pet order: earliest booted first (`since` ascending). A missing
* or mistyped `since` (0) reads as "unknown boot time" and sorts LAST — it
* must never outrank a publisher that stated its boot time. This turns the
* multi-pet design's de-facto rule ("the default pet is the first STARTED")
* into an actual guarantee: discovery output IS boot order, so every
* `pets[0]` consumer (the driver's unnamed-target fallback) reads the
* same pet. Stable sort: equal `since` values keep registry listing order.
*/
function bootOrder(pets) {
	return [...pets].sort((a, b) => (a.since > 0 ? a.since : Number.POSITIVE_INFINITY) - (b.since > 0 ? b.since : Number.POSITIVE_INFINITY));
}
/** Every live pet in boot order. Dead-pid entries are skipped — they expire
* by omission the next time their file is rewritten — and so are silent
* entries (pid alive, control plane unresponsive). Probes run CONCURRENTLY:
* wall time per pass is the slowest pet (≤800ms frozen budget), not the
* serial sum. */
async function readAllPets(home) {
	let names = [];
	try {
		names = (await readdir(join(home, REGISTRY_DIR))).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return bootOrder((await Promise.all(names.map(async (name) => {
		const id = name.slice(0, -5);
		if (id === "") return null;
		try {
			const raw = JSON.parse(await readFile(join(home, REGISTRY_DIR, name), "utf8"));
			const port = typeof raw.port === "number" ? raw.port : NaN;
			const pid = typeof raw.pid === "number" ? raw.pid : NaN;
			if (!Number.isFinite(port) || !Number.isFinite(pid)) return null;
			try {
				process.kill(pid, 0);
			} catch {
				return null;
			}
			if (!await probeControlPlane(port)) return null;
			return {
				id,
				port,
				pid,
				since: typeof raw.since === "number" ? raw.since : 0
			};
		} catch {
			return null;
		}
	}))).filter((entry) => entry !== null));
}
/**
* The default pet for UNNAMED targets: the earliest-booted live entry
* (`pets[0]` — discovery's bootOrder guarantees start order, not listing
* accident). State routing does NOT go through here anymore: an unbound
* (or bound-but-offline) session broadcasts its state to every live pet —
* the driver computes that audience itself. Used by the tools'
* resolveTarget when neither a named pet nor the owning session resolves.
* @returns the entry, or undefined when no pet is alive.
*/
function defaultPet(pets) {
	return pets[0];
}
/** The pets that receive an INTERACTION (all-notify mode): every live pet,
* the session-bound one included. The binding routes STATE — it must never
* mute interactions: excluding the bound pet would silence the only body
* whose bubble the user just proved they answer through, and a single-pet
* deployment would fall back to the web card alone for the rest of the
* session. */
function notifyPets(pets) {
	return [...pets];
}
// lib/types/driver.js
/**
* The pet driver: converges in-process DSH events into pet control
* operations. This is the DSH-knowledge half of the §7.2 split — the pet
* surface keeps shrinking toward a dumb display while everything that
* understands the runtime's vocabulary lives here. v1 drives semantic state;
* interaction waterfalls move over with the WS path's retirement.
* @module dsh-agentic-pet/driver
*/
const EMPTY_LEDGER = {
	affection: 0,
	total: 0,
	byPart: {},
	lastTouchAt: void 0,
	recent: []
};
const ADJUST_MAX_DELTA = 3;
const ADJUST_COOLDOWN_MS = 3e5;
const ADJUST_DAILY_LIMIT = 8;
const ADJUST_DAILY_SUM = 10;
const WAKE_PLAN_ID_MAX = 64;
const WAKE_PLAN_INTENT_MAX = 200;
const WAKE_PLAN_MAX_PER_PET = 32;
async function readLedger(home, petId) {
	try {
		const raw = await readAffectionRaw(home, petId);
		if (raw === null) return {
			...EMPTY_LEDGER,
			byPart: {},
			recent: []
		};
		return {
			affection: typeof raw.affection === "number" ? raw.affection : 0,
			total: typeof raw.total === "number" ? raw.total : 0,
			byPart: raw.byPart ?? {},
			lastTouchAt: raw.lastTouchAt,
			recent: raw.recent ?? [],
			adjustments: Array.isArray(raw.adjustments) ? raw.adjustments.filter((a) => typeof a === "object" && a !== null && typeof a.delta === "number" && typeof a.reason === "string" && typeof a.at === "number") : void 0,
			quota: typeof raw.quota === "object" && raw.quota !== null ? raw.quota : void 0,
			bond: typeof raw.bond === "object" && raw.bond !== null && typeof raw.bond.lastCountedDate === "string" ? {
				value: typeof raw.bond.value === "number" ? raw.bond.value : 0,
				days: typeof raw.bond.days === "number" ? raw.bond.days : 0,
				lastCountedDate: raw.bond.lastCountedDate
			} : void 0,
			bondAdjustments: Array.isArray(raw.bondAdjustments) ? raw.bondAdjustments.filter((a) => typeof a === "object" && a !== null && typeof a.delta === "number" && typeof a.reason === "string" && typeof a.at === "number") : void 0
		};
	} catch {
		return {
			...EMPTY_LEDGER,
			byPart: {},
			recent: []
		};
	}
}
/** Local-time log stamp: the driver log is the user's primary debugging
* tool, so timestamps show the USER's wall clock, not UTC (toISOString's Z
* form read 8h off and cost a confusion round). Sortable, zero-padded. */
const logStamp = () => {
	const d = /* @__PURE__ */ new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const driverLog = (home, line) => {
	appendFile(join(home, WHALE_DIR, "pet-driver.log"), `${logStamp()} ${line}
`, "utf8").catch(() => {});
};
/** The one /events read both consumers share (§6 v4): the ledger loop
* holds (`hold` seconds — the server clamps to ≤30s), the digest reads
* immediately. Wire shapes normalize here; the digest's independent
* cursor and the ledger loop's cursor stay per-consumer by design. */
async function readEvents(pet, entry, since, holdSeconds) {
	const hold = holdSeconds > 0 ? `&hold=${String(holdSeconds)}` : "";
	const payload = await pet.call(entry, `/events?since=${String(since)}${hold}`);
	return {
		events: (Array.isArray(payload.events) ? payload.events : []).map((event) => ({
			seq: typeof event.seq === "number" ? event.seq : 0,
			type: typeof event.type === "string" ? event.type : "touch",
			...typeof event.part === "string" ? { part: event.part } : {},
			...typeof event.text === "string" ? { text: event.text } : {},
			at: typeof event.at === "number" ? event.at : Date.now()
		})),
		latest: typeof payload.latest === "number" ? payload.latest : since
	};
}
/** The archived Session id set carried by one follow frame; undefined for
* frames that say nothing about archives (upsert/remove/order/pinned). */
function archivedIdsOf(frame) {
	if (typeof frame !== "object" || frame === null) return void 0;
	const record = frame;
	const ids = record.type === "baseline" || record.type === "replace" ? typeof record.value === "object" && record.value !== null ? record.value.archivedSessionIds : void 0 : record.type === "archived" ? record.archivedSessionIds : void 0;
	return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : void 0;
}
/**
* Inner-voice runtime state (docs/inner-voice.md). Module-level because TWO
* registration seams share it: installPetDriver fills and drives it, while
* registerPetTools (the pet preset's own row, a different fiber) reads the
* owner map in resolveTarget and reports pet_say arrivals. installPetDriver
* resets everything on entry, so a re-install re-initializes cleanly.
*/
const voiceOwners = /* @__PURE__ */ new Map();
const voicePendingUntil = /* @__PURE__ */ new Map();
const voiceLastSpokeAt = /* @__PURE__ */ new Map();
const voiceLastTouchReplyAt = /* @__PURE__ */ new Map();
const voiceNextWakeAt = /* @__PURE__ */ new Map();
const voiceWakePlans = /* @__PURE__ */ new Map();
let selfWakeSender;
/** Write-through the in-memory plan map to disk (empty lists dropped — the
* absence of a pet key IS an empty schedule). */
const persistWakePlans = (home) => {
	const snapshot = {};
	for (const [petId, list] of voiceWakePlans) if (list.length > 0) snapshot[petId] = list;
	saveWakePlans(home, snapshot);
};
const voiceGreetedOnce = /* @__PURE__ */ new Set();
const voiceNames = /* @__PURE__ */ new Map();
const DEFAULT_PET_NAME = { electron: "鲸鱼娘" };
/** B-layer bond day counting: the FIRST interaction of a calendar day
* (touch / user chat / model adjustment) marks that day as shared. Called
* at the interaction points, never on reads — reading the ledger does not
* make a day meaningful. Mutates in place; the caller persists. Module-level
* because both the driver closures AND the model tools (registerPetTools)
* count bond days. */
const countBondDay = (ledger) => {
	const today = (/* @__PURE__ */ new Date()).toDateString();
	if (ledger.bond?.lastCountedDate === today) return;
	ledger.bond = {
		value: ledger.bond?.value ?? 0,
		days: (ledger.bond?.days ?? 0) + 1,
		lastCountedDate: today
	};
};
const voiceLastPrompt = /* @__PURE__ */ new Map();
const voiceBoundSessions = /* @__PURE__ */ new Map();
const voiceWakeTimer = { timer: void 0 };
let voiceStore = {
	sessions: {},
	generations: {}
};
let voiceController;
let voiceUserActivityAt;
const isVoiceSession = (sessionId) => voiceOwners.has(sessionId);
/** pet_say arrival hook: a spoken bubble is both the pending-lock release and
* the truth of "when the pet last spoke" (a prompt being accepted is not).
* Returns whether a pending inner-voice turn was actually released (the
* caller logs it — the user-session says stay out of the log). */
function markVoiceSpoke(petId) {
	const hadPending = (voicePendingUntil.get(petId) ?? 0) > Date.now();
	voicePendingUntil.delete(petId);
	voiceLastPrompt.delete(petId);
	voiceLastSpokeAt.set(petId, Date.now());
	return hadPending;
}
function installPetDriver(ctx, home, pet) {
	driverLog(home, "installPetDriver entered");
	migrateGlobals(home);
	voiceOwners.clear();
	voicePendingUntil.clear();
	voiceLastSpokeAt.clear();
	voiceLastTouchReplyAt.clear();
	voiceNextWakeAt.clear();
	voiceWakePlans.clear();
	selfWakeSender = void 0;
	voiceGreetedOnce.clear();
	voiceNames.clear();
	voiceLastPrompt.clear();
	voiceBoundSessions.clear();
	if (voiceWakeTimer.timer !== void 0) clearTimeout(voiceWakeTimer.timer);
	voiceWakeTimer.timer = void 0;
	voiceUserActivityAt = void 0;
	voiceController = ctx.get("sessionController");
	if (voiceController === void 0) console.error("pet-surface driver: sessionController absent — the inner voice stays off");
	let latestArchived = /* @__PURE__ */ new Set();
	const lastRetired = /* @__PURE__ */ new Map();
	/** Re-submit the unanswered prompt text of petId (if any) into whatever
	* session the next ensure mints — a retire must not swallow the user's
	* words. Fire-and-forget; retried=true so the re-submission never hangs
	* its own re-submit timer. */
	const resubmitUnanswered = (petId) => {
		const last = voiceLastPrompt.get(petId);
		if (last === void 0) return;
		voiceLastPrompt.delete(petId);
		driverLog(home, `VOICE re-submitting the unanswered prompt into a fresh session pet=${petId}`);
		promptVoice(petId, last.text, {
			retried: true,
			userDriven: last.userDriven
		});
	};
	/** One reconciliation pass over the CURRENT store and the CURRENT archive
	* set: retire sessions the archive authority says are archived (each such
	* retire re-submits the lost prompt), and rebind a just-retired session
	* the user un-archived (撤销) before any replacement exists. */
	const reconcileArchivedVoiceSessions = () => {
		for (const [petId, entry] of Object.entries(voiceStore.sessions)) {
			if (!latestArchived.has(entry.sessionId)) continue;
			const generation = (voiceStore.generations[petId] ?? 0) + 1;
			voiceStore.generations[petId] = generation;
			Reflect.deleteProperty(voiceStore.sessions, petId);
			const ownerEntry = [...voiceOwners.entries()].find(([, owner]) => owner === petId);
			if (ownerEntry !== void 0) voiceOwners.delete(ownerEntry[0]);
			voicePendingUntil.delete(petId);
			lastRetired.set(petId, {
				sessionId: entry.sessionId,
				createdAt: entry.createdAt
			});
			saveInnerVoiceStore(home, voiceStore);
			driverLog(home, `VOICE session retired pet=${petId} (${entry.sessionId} was archived by the user — starting fresh as -g${String(generation)} on the next trigger)`);
			resubmitUnanswered(petId);
		}
		for (const [petId, retired] of [...lastRetired]) {
			if (latestArchived.has(retired.sessionId)) continue;
			lastRetired.delete(petId);
			if (voiceStore.sessions[petId] !== void 0) continue;
			voiceStore.sessions[petId] = {
				sessionId: retired.sessionId,
				createdAt: retired.createdAt
			};
			voiceOwners.set(retired.sessionId, petId);
			saveInnerVoiceStore(home, voiceStore);
			driverLog(home, `VOICE session restore-by-undo pet=${petId} (${retired.sessionId} left the archive set before any replacement — rebinding, memories intact)`);
		}
	};
	const attachedSessions = /* @__PURE__ */ new Set();
	const petWorkspaceDir = () => join(homedir(), "whale598");
	const attachVoiceSession = async (sessionId) => {
		if (attachedSessions.has(sessionId)) return;
		attachedSessions.add(sessionId);
		try {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return;
			await mkdir(petWorkspaceDir(), { recursive: true });
			await (await registry.create(petWorkspaceDir()))?.attachSession?.(sessionId);
			driverLog(home, `VOICE session attached to workspace (${sessionId})`);
		} catch (error) {
			attachedSessions.delete(sessionId);
			driverLog(home, `VOICE workspace attach skipped (${error instanceof Error ? error.message : String(error)})`);
		}
	};
	const workspaceFace = ctx.get("workspaceController");
	if (workspaceFace !== void 0) {
		const followAbort = new AbortController();
		(async () => {
			try {
				for await (const frame of workspaceFace.follow(followAbort.signal)) {
					const ids = archivedIdsOf(frame);
					if (ids === void 0) continue;
					latestArchived = new Set(ids);
					reconcileArchivedVoiceSessions();
				}
			} catch {
				driverLog(home, "VOICE workspace follow ended — behavioral stall detection remains the dead-session backstop");
			}
		})();
		ctx.effect(() => () => followAbort.abort(), "pet-surface: workspace archive watch");
	}
	loadInnerVoiceStore(home).then((store) => {
		voiceStore = store;
		for (const [petId, entry] of Object.entries(store.sessions)) {
			voiceOwners.set(entry.sessionId, petId);
			attachVoiceSession(entry.sessionId);
		}
		driverLog(home, `VOICE store loaded: ${String(Object.keys(store.sessions).length)} session(s)`);
		reconcileArchivedVoiceSessions();
	});
	loadWakePlans(home).then((plans) => {
		for (const [petId, list] of Object.entries(plans)) if (!voiceWakePlans.has(petId)) voiceWakePlans.set(petId, list);
		const count = Object.values(plans).reduce((sum, list) => sum + list.length, 0);
		driverLog(home, `VOICE wake plans loaded: ${String(count)} plan(s) for ${String(Object.keys(plans).length)} pet(s)`);
	});
	const events = ctx.root;
	driverLog(home, "listeners registering on root");
	let boundSessionId;
	let boundPetId;
	let currentState;
	const lastPushedByPet = /* @__PURE__ */ new Map();
	/**
	* The autonomy half of the /state payload: the idle-theater switches the
	* renderer consumes locally. Read fresh on every push (a settings-page
	* change reaches the pet on the next push without any cache) and folded
	* into the dedup key so a changed payload re-pushes.
	*/
	const readAutonomy = async () => {
		try {
			const p = (await readGlobalJson(home, "pet-settings.json")).proactivity;
			const gap = typeof p?.idleAnimationGapMinutes === "number" && Number.isFinite(p.idleAnimationGapMinutes) ? Math.min(120, Math.max(1, Math.round(p.idleAnimationGapMinutes))) : 10;
			return {
				idleAnimation: p?.idleAnimation !== false,
				gapMinutes: gap
			};
		} catch {
			return {
				idleAnimation: true,
				gapMinutes: 10
			};
		}
	};
	const stateQueues = /* @__PURE__ */ new Map();
	const sendState = async (target, state, autonomy, autonomyKey) => {
		const last = lastPushedByPet.get(target.id);
		if (last !== void 0 && last.state === state && last.since === target.since && last.autonomy === autonomyKey) return;
		lastPushedByPet.set(target.id, {
			state,
			since: target.since,
			autonomy: autonomyKey
		});
		try {
			const response = await fetch(`http://127.0.0.1:${String(target.port)}/state`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					state,
					autonomy
				}),
				signal: AbortSignal.timeout(5e3)
			});
			if (!response.ok) {
				console.error(`pet-surface driver: /state answered HTTP ${String(response.status)}`);
				lastPushedByPet.delete(target.id);
			} else if (state === "error") lastPushedByPet.delete(target.id);
		} catch {
			console.error(`pet-surface driver: /state to ${target.id} failed`);
			lastPushedByPet.delete(target.id);
		}
	};
	const pushState = async (state) => {
		currentState = state;
		const pets = await pet.list();
		const bound = pets.filter((pet) => pet.id === boundPetId);
		const audience = bound.length > 0 ? bound : pets;
		if (audience.length === 0) return;
		const autonomy = await readAutonomy();
		const autonomyKey = JSON.stringify(autonomy);
		await Promise.all(audience.map((target) => {
			const next = (stateQueues.get(target.id) ?? Promise.resolve()).then(() => sendState(target, state, autonomy, autonomyKey));
			stateQueues.set(target.id, next);
			return next;
		}));
	};
	events.on("api-session/status", (sessionId, running) => {
		if (isVoiceSession(sessionId)) return;
		driverLog(home, `status ${String(sessionId).slice(0, 12)} running=${String(running)}`);
		if (running || boundSessionId === void 0) {
			if (sessionId !== boundSessionId) boundPetId = void 0;
			boundSessionId = sessionId;
		}
		if (sessionId !== boundSessionId) return;
		pushState(running ? "working" : "idle");
	});
	events.on("api-session/activity", (sessionId, _updatedAt) => {
		if (isVoiceSession(sessionId)) return;
		voiceUserActivityAt = Date.now();
		if (sessionId !== boundSessionId) boundPetId = void 0;
		boundSessionId = sessionId;
		if (currentState === void 0 || currentState === "idle") pushState("thinking");
	});
	events.on("api-session/error", (sessionId, _message) => {
		if (isVoiceSession(sessionId)) {
			const petId = voiceOwners.get(sessionId);
			if (petId !== void 0) voicePendingUntil.delete(petId);
			return;
		}
		if (sessionId !== boundSessionId) return;
		pushState("error");
	});
	events.on("api-session/removed", (sessionId) => {
		if (isVoiceSession(sessionId)) {
			const petId = voiceOwners.get(sessionId);
			voiceOwners.delete(sessionId);
			if (petId !== void 0) {
				Reflect.deleteProperty(voiceStore.sessions, petId);
				voicePendingUntil.delete(petId);
				saveInnerVoiceStore(home, voiceStore);
				driverLog(home, `VOICE session removed by user; pet=${petId} will re-create on next wake`);
			}
			return;
		}
		if (sessionId !== boundSessionId) return;
		boundSessionId = void 0;
		boundPetId = void 0;
		pushState("idle");
	});
	const refreshNames = async () => {
		voiceNames.clear();
		try {
			for (const petId of await readdir(join(home, WHALE_DIR))) {
				const name = await readPetName(home, petId);
				if (name !== void 0) voiceNames.set(petId, name);
			}
		} catch {}
		try {
			const raw = await readGlobalJson(home, "pet-settings.json");
			if (typeof raw.names === "object" && raw.names !== null) {
				for (const [petId, label] of Object.entries(raw.names)) if (petId !== "" && typeof label === "string" && label.trim() !== "" && !voiceNames.has(petId)) voiceNames.set(petId, label.trim());
			}
		} catch {}
	};
	refreshNames();
	const refreshBoundSessions = async () => {
		const config = await readInnerVoiceConfig(home);
		voiceBoundSessions.clear();
		for (const [petId, sessionId] of Object.entries(config.boundSessions)) voiceBoundSessions.set(petId, sessionId);
	};
	refreshBoundSessions();
	events.on("pet-settings/changed", () => {
		const prevNames = new Map(voiceNames);
		(async () => {
			await refreshNames();
			refreshBoundSessions();
			const changedPets = /* @__PURE__ */ new Set([...prevNames.keys(), ...voiceNames.keys()]);
			for (const petId of changedPets) {
				if (prevNames.get(petId) === voiceNames.get(petId)) continue;
				const nextName = voiceNames.get(petId);
				const label = nextName ?? DEFAULT_PET_NAME[petId] ?? petId;
				const entry = voiceStore.sessions[petId];
				if (entry !== void 0) {
					const title = `${label}的内心戏`;
					try {
						await voiceController?.rename({
							sessionId: entry.sessionId,
							title
						});
						driverLog(home, `VOICE session retitled pet=${petId} → ${title}`);
					} catch (error) {
						driverLog(home, `VOICE retitle skipped pet=${petId}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				triggerRenameNotice(petId, nextName, label);
			}
		})();
		if (currentState !== void 0) pushState(currentState);
	});
	const startAskPet = (pet, body, signal) => {
		const controller = new AbortController();
		const abort = () => {
			controller.abort();
		};
		signal?.addEventListener("abort", abort);
		return {
			promise: (async () => {
				try {
					const response = await fetch(`http://127.0.0.1:${String(pet.port)}/interaction`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: controller.signal
					});
					if (!response.ok) return void 0;
					return JSON.parse(await response.text());
				} catch {
					return;
				} finally {
					signal?.removeEventListener("abort", abort);
				}
			})(),
			abort
		};
	};
	const interactionLedgerFile = globalFilePath(home, "pet-interactions.json");
	const recordInteraction = (entry) => {
		const at = Date.now();
		(async () => {
			try {
				const list = JSON.parse(await readFile(interactionLedgerFile, "utf8"));
				const next = Array.isArray(list) ? list : [];
				next.unshift({
					...entry,
					decision: entry.decision ?? null,
					detail: entry.detail ?? null,
					session: entry.session ?? null,
					pet: entry.pet ?? null,
					at
				});
				await writeFile(interactionLedgerFile, `${JSON.stringify(next.slice(0, 50))}\n`, "utf8");
			} catch {
				try {
					await writeFile(interactionLedgerFile, `${JSON.stringify([{
						...entry,
						at
					}])}\n`, "utf8");
				} catch (writeError) {
					console.error(`pet-surface driver: could not write the interaction ledger: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
				}
			}
		})();
	};
	const raceInteraction = async (body, request, next, accept) => {
		const kind = typeof body.kind === "string" ? body.kind : "interaction";
		const iid = `ap_${randomUUID().slice(0, 8)}`;
		const agentId = request.agent?.id;
		const session = typeof agentId === "string" ? agentId : null;
		const original = request.signal;
		const decision = new AbortController();
		request.signal = original === void 0 ? decision.signal : AbortSignal.any([original, decision.signal]);
		const arms = notifyPets(await pet.list()).map((pet) => ({
			pet,
			ask: startAskPet(pet, body, original)
		}));
		let recorded = false;
		const record = (endedBy, decision, detail, petId) => {
			if (recorded) return;
			recorded = true;
			driverLog(home, `INTERACTION ${iid} ${kind} session=${session ?? "-"} pet=${petId ?? "-"} endedBy=${endedBy}${detail !== void 0 ? ` (${detail})` : ""}`);
			recordInteraction({
				id: iid,
				kind,
				endedBy,
				decision,
				detail,
				session,
				pet: petId ?? null
			});
		};
		try {
			const chain = next();
			chain.catch(() => {});
			const armPromises = arms.map(({ pet, ask }) => ask.promise.then((answer) => ({
				from: "pet",
				pet,
				answer
			})));
			const winner = await Promise.race([...armPromises, chain.then((value) => ({
				from: "web",
				value,
				error: void 0
			}), (error) => ({
				from: "web",
				value: void 0,
				error
			}))]);
			if (winner.from === "web") {
				if (winner.error !== void 0) {
					record("web", void 0, winner.error instanceof Error ? winner.error.message : String(winner.error));
					throw winner.error;
				}
				record("web", winner.value);
				return winner.value;
			}
			if (winner.answer === void 0 || !accept(winner.answer.answer)) {
				const chainValue = await chain;
				record("chain", chainValue, winner.answer === void 0 ? "pet_offline_or_no_pet" : "pet_answer_invalid");
				return chainValue;
			}
			decision.abort();
			boundPetId = winner.pet.id;
			record("pet", winner.answer.answer, void 0, winner.pet.id);
			if (currentState !== void 0) pushState(currentState);
			return winner.answer.answer;
		} catch (error) {
			record("cancelled", void 0, error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			for (const { ask } of arms) ask.abort();
		}
	};
	events.on("approval/request", async (request, next) => {
		driverLog(home, `WATERFALL approval for ${String(request.toolName)}`);
		console.log("pet-surface driver: approval/request received for", String(request.toolName));
		return raceInteraction({
			kind: "approval",
			...request.toolName === void 0 ? {} : { toolName: request.toolName },
			...request.reason === void 0 ? {} : { reason: request.reason },
			...request.displayReason === void 0 ? {} : { displayReason: request.displayReason }
		}, request, next, (answer) => typeof answer === "string");
	}, { prepend: true });
	events.on("user-questions/request", async (request, next) => {
		driverLog(home, "WATERFALL question");
		return raceInteraction({
			kind: "question",
			questions: request.questions
		}, request, next, (answer) => typeof answer === "object" && answer !== null);
	}, { prepend: true });
	/** The pet's durable inner-voice session id, creating (and titling) it on
	* first use. A config preset that fails to resolve falls back to the
	* trimmed default once; a session the user deleted re-creates cleanly.
	* Serialized per pet: two concurrent callers (a stall-timer resubmission
	* racing a pre-flight reconcile's own resubmission) both saw an empty
	* store and minted the SAME id — the field double-create of 2026-10-31.
	* The second caller now awaits the first and lands on its store entry. */
	const ensureInFlight = /* @__PURE__ */ new Map();
	const ensureVoiceSession = (petId) => {
		const pending = ensureInFlight.get(petId);
		if (pending !== void 0) return pending;
		const run = ensureVoiceSessionUnlocked(petId).finally(() => {
			ensureInFlight.delete(petId);
		});
		ensureInFlight.set(petId, run);
		return run;
	};
	const ensureVoiceSessionUnlocked = async (petId) => {
		const bound = voiceBoundSessions.get(petId);
		if (bound !== void 0) {
			voiceOwners.set(bound, petId);
			attachVoiceSession(bound);
			return bound;
		}
		const known = voiceStore.sessions[petId];
		if (known !== void 0) {
			attachVoiceSession(known.sessionId);
			return known.sessionId;
		}
		if (voiceController === void 0) return void 0;
		const config = await readInnerVoiceConfig(home);
		const minted = mintVoiceSessionId(petId, voiceStore.generations[petId] ?? 0, (id) => latestArchived.has(id));
		voiceStore.generations[petId] = minted.generation;
		saveInnerVoiceStore(home, voiceStore);
		if (minted.hops > 0) driverLog(home, `VOICE mint skipped ${String(minted.hops)} archived id(s) pet=${petId} → ${minted.sessionId}`);
		const sessionId = minted.sessionId;
		try {
			await mkdir(petWorkspaceDir(), { recursive: true });
			await voiceController.create({
				sessionId,
				agentPreset: config.preset,
				cwd: petWorkspaceDir()
			});
		} catch (firstError) {
			driverLog(home, `VOICE preset "${config.preset}" rejected for pet=${petId}: ${firstError instanceof Error ? firstError.message : String(firstError)}; falling back`);
			try {
				await voiceController.create({
					sessionId,
					agentPreset: "whale598",
					cwd: petWorkspaceDir()
				});
			} catch (secondError) {
				driverLog(home, `VOICE session create failed for pet=${petId}: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
				return;
			}
		}
		try {
			const customName = voiceNames.get(petId);
			await voiceController.rename({
				sessionId,
				title: `${customName ?? DEFAULT_PET_NAME[petId] ?? petId}的内心戏`
			});
		} catch {}
		voiceStore.sessions[petId] = {
			sessionId,
			createdAt: Date.now()
		};
		await saveInnerVoiceStore(home, voiceStore);
		voiceOwners.set(sessionId, petId);
		attachVoiceSession(sessionId);
		driverLog(home, `VOICE session created pet=${petId} session=${sessionId} preset=${config.preset}`);
		return sessionId;
	};
	/** Push one trigger text into the pet's session (queue mode: a busy session
	* enqueues, never interrupts). A prompt that sits unanswered past the
	* window is assumed dead (archived session): the session is retired and
	* THIS text is re-submitted into the freshly minted one, once — the user
	* sends one message and gets their reply without re-sending anything.
	* `userDriven` marks a USER-initiated prompt (chat上行); it rides along on
	* re-submissions so the fresh-session path knows who was talking. (The
	* behavioral dead-session probe that once consumed this flag has been
	* retired — session replacement is archive-feed driven.) */
	const promptVoice = async (petId, text, opts = {}) => {
		const { retried = false, userDriven = false } = opts;
		if (latestArchived.has(voiceStore.sessions[petId]?.sessionId ?? "")) reconcileArchivedVoiceSessions();
		const customName = voiceNames.get(petId);
		if (customName !== void 0 && !text.startsWith("[名字]")) text = `[名字] 你叫「${customName}」。
${text}`;
		const sessionId = await ensureVoiceSession(petId);
		if (sessionId === void 0 || voiceController === void 0) return false;
		try {
			await voiceController.prompt({
				requestId: `voice-${randomUUID()}`,
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text
				}]
			}, new AbortController().signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			driverLog(home, `VOICE prompt failed pet=${petId}: ${message}`);
			if (/Unknown agent preset/i.test(message) && !retried) {
				if (voiceStore.sessions[petId] !== void 0) {
					const generation = (voiceStore.generations[petId] ?? 0) + 1;
					voiceStore.generations[petId] = generation;
					Reflect.deleteProperty(voiceStore.sessions, petId);
					const ownerEntry = [...voiceOwners.entries()].find(([, owner]) => owner === petId);
					if (ownerEntry !== void 0) voiceOwners.delete(ownerEntry[0]);
					voiceLastPrompt.delete(petId);
					saveInnerVoiceStore(home, voiceStore);
					driverLog(home, `VOICE session retired pet=${petId} (recorded preset no longer exists — id renamed) — fresh -g${generation} mounts the current preset`);
					return promptVoice(petId, text, {
						retried: true,
						userDriven
					});
				}
			}
			return false;
		}
		voicePendingUntil.set(petId, Date.now() + 25e3);
		if (!retried) voiceLastPrompt.set(petId, {
			text,
			userDriven
		});
		driverLog(home, `VOICE prompt admitted pet=${petId} :: ${text.slice(0, 80)}`);
		return true;
	};
	/** Shared gates of both trigger sources: the pet is online and has no turn
	* already in flight. `requireUserIdle` additionally holds the trigger while
	* the user's session is mid-turn — the random wake's manners; a touch is
	* the USER reaching out, so it skips that check (docs/inner-voice.md §6.2).
	* A touch ALSO skips the pending lock: a self-turn without a pet_say would
	* otherwise hold the lock for its full 120s and swallow every pat in the
	* window (2026-10-30 field lesson); the queued prompt mode makes stacking
	* safe, and the touch probability/cooldown still throttle the chatter.
	* `label` names the trigger source — gate lines are shared by both, and a
	* refusal without one reads as "no touch ever happened". EVERY refusal
	* names itself in the log: silence must be explainable. */
	const voiceGateOpen = async (petId, requireUserIdle, label, skipPending = false) => {
		if (voiceController === void 0) {
			driverLog(home, `VOICE gate closed (${label}) pet=${petId} (sessionController unavailable)`);
			return false;
		}
		if (requireUserIdle && currentState !== void 0 && currentState !== "idle") {
			driverLog(home, `VOICE gate closed (${label}) pet=${petId} (user session busy: ${currentState})`);
			return false;
		}
		if (!skipPending && (voicePendingUntil.get(petId) ?? 0) > Date.now()) {
			driverLog(home, `VOICE gate closed (${label}) pet=${petId} (a self-turn is still in flight)`);
			return false;
		}
		if (!(await pet.list()).some((entry) => entry.id === petId)) {
			driverLog(home, `VOICE gate closed (${label}) pet=${petId} (pet offline)`);
			return false;
		}
		return true;
	};
	/** Boot greeting (user request): once per dsh start, the first time the pet
	* is seen online. No probability gate and no user-busy check — it is a
	* hello, not an interruption; the pending lock still applies. A refused
	* greeting (pet offline) releases the flag for the next sweep to retry. */
	const triggerGreeting = async (petId) => {
		if (!await voiceGateOpen(petId, false, "greeting")) return;
		const ledger = await readLedger(home, petId);
		if (await promptVoice(petId, buildGreetPrompt({
			affection: ledger.affection,
			bondValue: ledger.bond?.value ?? 0,
			bondDays: ledger.bond?.days ?? 0,
			bondTier: bondTier(ledger.bond?.value ?? 0)
		}))) {
			voiceGreetedOnce.add(petId);
			driverLog(home, `VOICE boot greeting pet=${petId}`);
		} else voiceGreetedOnce.delete(petId);
	};
	/** Rename notice (user request): fired when the user's custom name actually
	* changes — she acknowledges out loud, once. The per-turn short name line
	* stays as the compaction-proof invariant; a skipped notice (pet offline /
	* turn in flight) loses nothing because that line still carries the name. */
	const triggerRenameNotice = async (petId, nextName, label) => {
		if (!await voiceGateOpen(petId, false, "rename")) return;
		const text = nextName !== void 0 ? `[改名] 用户给你改名叫「${label}」——以后自我介绍、气泡里自称，都用这个名字。` : `[改名] 用户把你改回了「${label}」。`;
		if (await promptVoice(petId, text)) driverLog(home, `VOICE rename notice pet=${petId} → ${label}`);
	};
	/** One wake turn (docs/inner-voice.md §6.3, reworked for 自主作息). The
	* gate decides whether this wake speaks — never the model — EXCEPT that a
	* consumed self plan always wakes: the dice do not re-veto a decision the
	* model already made. `source` names the clock(s) that fired this time:
	* 'world' = the environment's tick (probability-gated, busy gate drops),
	* 'self' = the model's own schedule (pet_schedule_wake), 'world+self' =
	* both due in the same sweep tick, merged into one wake. */
	const fireWake = async (petId, opts) => {
		const config = await readInnerVoiceConfig(home);
		if (!config.enabled) return;
		const { source, overdue = false } = opts;
		const plans = opts.plans ?? [];
		driverLog(home, `VOICE wake fire pet=${petId} source=${source} plans=${String(plans.length)} interval=${String(config.wakeIntervalMinutes)}min speakP=${String(config.speakProbability)} busyPolicy=${config.selfWakeBusyPolicy}`);
		if (source === "world" && Math.random() >= config.speakProbability) {
			driverLog(home, `VOICE wake silent by probability pet=${petId}`);
			return;
		}
		const requireUserIdle = source === "world" || config.selfWakeBusyPolicy === "defer";
		const skipPending = source !== "world";
		if (!await voiceGateOpen(petId, requireUserIdle, opts.label, skipPending)) {
			if (source !== "world" && plans.length > 0 && config.selfWakeBusyPolicy === "defer") {
				voiceWakePlans.set(petId, [...plans, ...voiceWakePlans.get(petId) ?? []]);
				persistWakePlans(home);
				driverLog(home, `VOICE wake plans re-armed pet=${petId} (user busy, policy=defer) ids=${plans.map((plan) => plan.id).join(",")}`);
			}
			return;
		}
		const ledger = await readLedger(home, petId);
		const now = Date.now();
		const lastSpoke = voiceLastSpokeAt.get(petId);
		const pending = (voiceWakePlans.get(petId) ?? []).slice().sort((a, b) => a.at - b.at).slice(0, 5);
		if (await promptVoice(petId, buildWakePrompt({
			affection: ledger.affection,
			bondValue: ledger.bond?.value ?? 0,
			bondDays: ledger.bond?.days ?? 0,
			bondTier: bondTier(ledger.bond?.value ?? 0),
			minutesSinceLastSpoke: lastSpoke === void 0 ? void 0 : Math.round((now - lastSpoke) / 6e4),
			minutesSinceUserActivity: voiceUserActivityAt === void 0 ? void 0 : Math.round((now - voiceUserActivityAt) / 6e4),
			userActive: voiceUserActivityAt !== void 0 && now - voiceUserActivityAt < 18e5,
			source,
			dueIntents: plans.map((plan) => plan.intent),
			missedCount: missedPlans(plans, bootAt).length,
			overdue,
			pendingPlans: pending.map((plan) => ({
				at: plan.at,
				intent: plan.intent
			}))
		}))) voiceLastSpokeAt.set(petId, now);
	};
	selfWakeSender = (petId, plan) => {
		fireWake(petId, {
			source: "self",
			plans: [plan],
			overdue: true,
			label: "self-wake"
		});
	};
	/** Touch-reply trigger (docs/inner-voice.md §6.1). Low probability + a
	* per-pet cooldown keep a pat from turning into chatter; the user-busy gate
	* does NOT apply — a touch is the user initiating, not the pet interrupting.
	* Every silent branch logs: a pat with no reply must be explainable. */
	const triggerTouchReply = async (petId, part) => {
		if (touchPartWording(part) === void 0) {
			driverLog(home, `VOICE touch ignored pet=${petId} part=${part} (not a touchable part)`);
			return;
		}
		const config = await readInnerVoiceConfig(home);
		if (!config.enabled) return;
		if (Math.random() >= config.touchReplyProbability) {
			driverLog(home, `VOICE touch silent by probability pet=${petId}`);
			return;
		}
		const last = voiceLastTouchReplyAt.get(petId);
		const cooldownLeft = last !== void 0 ? Math.ceil((last + config.touchReplyCooldownSeconds * 1e3 - Date.now()) / 1e3) : 0;
		if (cooldownLeft > 0) {
			driverLog(home, `VOICE touch in cooldown pet=${petId} (~${String(cooldownLeft)}s left)`);
			return;
		}
		if (!await voiceGateOpen(petId, false, "touch", true)) return;
		const merged = takeNearDuePlan(voiceWakePlans.get(petId) ?? [], Date.now());
		if (merged.plan !== void 0) {
			voiceWakePlans.set(petId, merged.next);
			persistWakePlans(home);
			driverLog(home, `VOICE wake plan merged into touch turn pet=${petId} id=${merged.plan.id}`);
		}
		const ledger = await readLedger(home, petId);
		if (await promptVoice(petId, buildTouchPrompt({
			part,
			touchesToday: ledger.recent.filter((entry) => entry.part === part).length + 1,
			affection: ledger.affection,
			...merged.plan === void 0 ? {} : { mergedPlan: {
				at: merged.plan.at,
				intent: merged.plan.intent
			} }
		}))) {
			const now = Date.now();
			voiceLastTouchReplyAt.set(petId, now);
			voiceLastSpokeAt.set(petId, now);
		}
	};
	/** Chat上行 trigger (§6 2026-10-31 revision): the user typed at the pet's
	* surface. Routing is DIRECT to the pet's own inner-voice session and
	* skips every touch-path gate — probability, cooldown, the user-busy
	* check, the pending lock (queue mode stacks safely) — a user reaching
	* out to talk is never throttled, and a pet replying is the contract, not
	* a coin flip. Only the pet's presence is checked. */
	const triggerChat = async (petId, text) => {
		if (!await voiceGateOpen(petId, false, "chat", true)) return;
		const merged = takeNearDuePlan(voiceWakePlans.get(petId) ?? [], Date.now());
		if (merged.plan !== void 0) {
			voiceWakePlans.set(petId, merged.next);
			persistWakePlans(home);
			driverLog(home, `VOICE wake plan merged into user turn pet=${petId} id=${merged.plan.id}`);
		}
		if (await promptVoice(petId, buildChatPrompt(text, merged.plan === void 0 ? void 0 : {
			at: merged.plan.at,
			intent: merged.plan.intent
		}), { userDriven: true })) voiceLastSpokeAt.set(petId, Date.now());
	};
	/** The wake sweep: a 60s tick over TWO coexisting clocks per pet, a UNION
	* (互不覆盖). The world clock is the environment's rhythm (next-wake stamp,
	* ±25% jitter, settings fresh each sweep); the self clock is the model's
	* own pet_schedule_wake plans, consumed only when DUE — neither the world
	* clock nor a user wake ever touches not-yet-due plans, and plans that
	* went due while dsh or the pet was offline catch up on the first sweep
	* that sees the pet online, merged into ONE wake. */
	const wakeSweep = async () => {
		const config = await readInnerVoiceConfig(home);
		if (!config.enabled) return;
		const now = Date.now();
		const intervalMs = config.wakeIntervalMinutes * 6e4;
		for (const target of await pet.list()) {
			const next = voiceNextWakeAt.get(target.id);
			let worldDue = false;
			if (next === void 0) {
				voiceNextWakeAt.set(target.id, now + intervalMs * (.5 + Math.random() * .5));
				if (!voiceGreetedOnce.has(target.id)) triggerGreeting(target.id);
			} else if (now >= next) {
				worldDue = true;
				voiceNextWakeAt.set(target.id, now + intervalMs * (.75 + Math.random() * .5));
			}
			const list = voiceWakePlans.get(target.id);
			if (list !== void 0 && list.length > 0) {
				const taken = takeDuePlans(list, now);
				if (taken.due.length > 0) {
					voiceWakePlans.set(target.id, taken.next);
					persistWakePlans(home);
					driverLog(home, `VOICE wake plans consumed pet=${target.id} ids=${taken.due.map((plan) => plan.id).join(",")} worldClock=${String(worldDue)}`);
					await fireWake(target.id, {
						source: worldDue ? "world+self" : "self",
						plans: taken.due,
						label: worldDue ? "wake" : "self-wake"
					});
					continue;
				}
			}
			if (worldDue) await fireWake(target.id, {
				source: "world",
				label: "wake"
			});
		}
	};
	const SWEEP_SLOW_MS = 6e4;
	const SWEEP_FAST_MS = 3e3;
	const SWEEP_FAST_DEADLINE = 12e4;
	const bootAt = Date.now();
	const scheduleSweep = () => {
		const fast = Date.now() - bootAt < SWEEP_FAST_DEADLINE && voiceNextWakeAt.size === 0;
		voiceWakeTimer.timer = setTimeout(() => {
			wakeSweep().finally(scheduleSweep);
		}, fast ? SWEEP_FAST_MS : SWEEP_SLOW_MS);
	};
	scheduleSweep();
	wakeSweep();
	const lastEventSeqs = /* @__PURE__ */ new Map();
	const recordTouch = async (petId, part, at) => {
		const ledger = await readLedger(home, petId);
		countBondDay(ledger);
		ledger.total += 1;
		ledger.byPart[part] = (ledger.byPart[part] ?? 0) + 1;
		ledger.lastTouchAt = at;
		ledger.recent.unshift({
			part,
			at
		});
		ledger.recent = ledger.recent.slice(0, 10);
		try {
			await writeAffectionRaw(home, petId, ledger);
		} catch (error) {
			console.error(`pet-surface driver: could not write the ledger: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (Math.floor(ledger.total / 10) > Math.floor((ledger.total - 1) / 10)) {
			const target = (await pet.list()).find((pet) => pet.id === petId);
			if (target !== void 0) fetch(`http://127.0.0.1:${String(target.port)}/action`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "celebrate" }),
				signal: AbortSignal.timeout(5e3)
			}).catch(() => {});
		}
		triggerTouchReply(petId, part);
	};
	const handlePetEvent = async (petId, event) => {
		appendJsonl(eventsFile(home, petId), {
			seq: event.seq,
			type: event.type,
			...event.type === "touch" ? { part: event.part } : {},
			at: event.at
		});
		if (event.type === "touch") {
			if (event.part !== void 0) await recordTouch(petId, event.part, event.at);
			return;
		}
		if (event.type === "chat" && event.text !== void 0 && event.text !== "") {
			const ledger = await readLedger(home, petId);
			countBondDay(ledger);
			await writeAffectionRaw(home, petId, ledger);
			triggerChat(petId, event.text);
		}
	};
	/** Per-pet long-poll loops (§6 v4): each live pet parks ONE /events
	* hold=30 request; the answer — an event batch or the 30s empty one —
	* re-arms immediately, so a touch lands in the ledger with at most
	* server-side latency instead of the old 2s busy poll. Reconnection after
	* any failure goes through the registry (pet.list() re-discovers and
	* re-probes), NEVER by retrying a stale port. The loop's pet.list() pass
	* between holds is also the explicit liveness probe the busy polling used
	* to provide for free (~30s cadence). */
	const eventLoop = async (initial, handle) => {
		let entry = initial;
		while (!handle.stopped) {
			const since = lastEventSeqs.get(entry.id) ?? 0;
			try {
				const payload = await readEvents(pet, entry, since, 30);
				if (payload.latest < since) {
					lastEventSeqs.set(entry.id, 0);
					continue;
				}
				for (const event of payload.events) {
					lastEventSeqs.set(entry.id, Math.max(lastEventSeqs.get(entry.id) ?? 0, event.seq));
					await handlePetEvent(entry.id, event);
				}
				lastEventSeqs.set(entry.id, Math.max(lastEventSeqs.get(entry.id) ?? 0, payload.latest));
			} catch {}
			const fresh = (await pet.list()).find((candidate) => candidate.id === entry.id);
			if (fresh === void 0) return;
			entry = fresh;
		}
	};
	const eventLoops = /* @__PURE__ */ new Map();
	const eventSupervisor = async () => {
		for (const target of await pet.list()) {
			if (eventLoops.has(target.id)) continue;
			const handle = { stopped: false };
			eventLoops.set(target.id, handle);
			eventLoop(target, handle).finally(() => {
				eventLoops.delete(target.id);
			});
		}
	};
	const supervisorTimer = setInterval(() => {
		eventSupervisor();
	}, 5e3);
	eventSupervisor();
	ctx.effect(() => () => {
		clearInterval(supervisorTimer);
		for (const handle of eventLoops.values()) handle.stopped = true;
	}, "pet-surface: event long-poll");
	if (currentState === void 0) pushState("idle");
}
/**
* The model-expression layer: three thin tools over the pet's control
* interface (§6 — accurate state stays program-driven; these carry only the
* model's expressive intent). Registered only when a tools service is
* mounted; a missing pet answers with a clear string the model can relay.
* @param ctx - plugin context inside the runtime.
* @param home - the dsh home holding the pet control manifest.
*/
function registerPetTools(ctx, home, pet) {
	ctx.inject(["tools"], (scope) => {
		console.log("pet-surface driver: pet tools registered");
		const dshLoginAt = Date.now();
		const sleep = (ms) => new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
		const readFocus = async () => {
			try {
				const raw = await readGlobalJson(home, "pet-settings.json");
				return typeof raw.focus === "string" && raw.focus !== "" ? raw.focus : void 0;
			} catch {
				return;
			}
		};
		const resolveTarget = async (targetPet, ownerSessionId) => {
			const pets = await pet.list();
			if (typeof targetPet === "string" && targetPet !== "") {
				const named = pets.find((entry) => entry.id === targetPet);
				if (named === void 0) throw new Error(`no running pet named "${targetPet}" (running: ${pets.map((entry) => entry.id).join(", ") || "none"})`);
				return named;
			}
			if (typeof ownerSessionId === "string") {
				const owned = voiceOwners.get(ownerSessionId);
				if (owned !== void 0) {
					const own = pets.find((entry) => entry.id === owned);
					if (own !== void 0) return own;
				}
			}
			const focus = await readFocus();
			const target = (focus !== void 0 ? pets.find((entry) => entry.id === focus) : void 0) ?? defaultPet(pets);
			if (target === void 0) throw new Error("no pet is running");
			return target;
		};
		const requireOwnedSession = (exec) => {
			const sessionId = exec?.agent?.id;
			if (typeof sessionId === "string" && !voiceOwners.has(sessionId)) throw new Error("本会话没有绑定宠物（不是宠物自己的内心戏会话），pet 工具不分发。想和宠物说话，请用宠物表面的输入卡。");
		};
		const classify = (error) => {
			if (error instanceof Error) {
				if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) return /* @__PURE__ */ new Error(`offline: the pet is not reachable (${error.message})`);
				if (/timeout|aborted|TimeoutError/i.test(error.message)) return /* @__PURE__ */ new Error(`timeout: the pet did not answer in time (${error.message})`);
			}
			return error instanceof Error ? error : new Error(String(error));
		};
		const digestCursors = /* @__PURE__ */ new Map();
		scope.tools.register(defineTool({
			name: "pet_say",
			description: "Make the desktop pet show a short speech bubble. Body language, not a message channel — put task content in your reply. Budget: show time is 4s + 60ms per character (capped at 8s), so ≤40 characters reads well and ~67+ hits the cap; keep it short and warm. A new bubble overwrites the current one, so you can interrupt yourself. Multiple pets may be running: see pet_state for their ids.",
			parameters: {
				text: {
					type: "string",
					required: true,
					description: "What the pet says; ≤40 characters recommended (hard cap 200), in the conversation language."
				},
				pet: {
					type: "string",
					description: "Which pet speaks: its id from pet_state. Omit for the default pet."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				requireOwnedSession(exec);
				const text = String(args.text).slice(0, 200);
				console.log(`pet-surface driver: pet_say ${JSON.stringify(text).slice(0, 60)}`);
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					await pet.call(entry, "/say", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text })
					});
					if (markVoiceSpoke(entry.id)) driverLog(home, `VOICE pending released by say pet=${entry.id} (inner-voice turn complete)`);
				} catch (error) {
					throw classify(error);
				}
				return JSON.stringify({
					shown: true,
					durationMs: 4e3 + Math.min(text.length * 60, 4e3)
				});
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_do",
			description: "Make the desktop pet perform a one-shot animation. Use sparingly to punctuate moments (e.g. celebrate when a task the user cared about succeeds). The action is an id from the PET'S OWN catalog — each pet advertises what it can perform (\"celebrate\" always works; \"random\" lets the pet pick; full menus via pet_state with actions:true). Multiple pets may be running: see pet_state for their ids.",
			parameters: {
				action: {
					type: "string",
					required: true,
					description: "The animation to perform: an id from the pet's own action catalog (pet_state {actions:true}), or \"celebrate\" (universal), or \"random\" (pet picks)."
				},
				pet: {
					type: "string",
					description: "Which pet performs: its id from pet_state. Omit for the default pet."
				},
				wait: {
					type: "boolean",
					description: "Wait for the animation to actually finish and report its real duration (polls up to ~20s). Omit for fire-and-forget."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				requireOwnedSession(exec);
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const requested = String(args.action);
					const resolution = resolveActionRequest(requested, (await pet.capabilities(entry))?.actions ?? null);
					if (resolution.kind === "unknown") throw new Error(`unknown action "${requested}" for pet "${entry.id}". Available: ${formatAvailableActions(resolution.available)}`);
					const action = resolution.action;
					driverLog(home, `PET_DO pet=${entry.id} action=${action}${action === requested ? "" : ` (requested: ${requested})`}`);
					const response = await pet.call(entry, "/action", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action })
					});
					if (args.wait !== true) return JSON.stringify({
						performed: true,
						action,
						...action === requested ? {} : { requested }
					});
					const requestId = typeof response?.requestId === "string" ? response.requestId : void 0;
					if (requestId === void 0) return JSON.stringify({
						performed: true,
						action,
						waitLost: "this pet does not report action completion"
					});
					for (let waited = 0; waited < 2e4; waited += 250) {
						await sleep(250);
						const snap = await pet.snapshot(entry);
						if (snap.online === false) return JSON.stringify({
							performed: true,
							action,
							waitLost: "pet went offline before finishing"
						});
						const done = snap.lastAction;
						if (done != null && done.id === requestId) return JSON.stringify({
							performed: true,
							action,
							durationMs: done.durationMs
						});
					}
					return JSON.stringify({
						performed: true,
						action,
						waitTimedOut: true
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_digest",
			description: "Summarize what happened to the desktop pet SINCE your last pet_digest call: touches aggregated by part (head/body/miss), the current affection total and mood. Call it to notice the pet was touched while you were working — far cheaper than reading pet_state history. The first-ever call summarizes the retained queue (last ~200 events).",
			parameters: { pet: {
				type: "string",
				description: "Which pet: its id from pet_state. Omit for the default pet."
			} },
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const cursor = digestCursors.get(entry.id) ?? 0;
					let payload = await readEvents(pet, entry, cursor, 0);
					if (payload.latest < cursor) payload = await readEvents(pet, entry, 0, 0);
					const counts = {};
					let total = 0;
					let lastTouchAt = null;
					let newest = cursor;
					for (const event of payload.events) {
						if (event.seq > newest) newest = event.seq;
						if (event.type !== "touch" || event.part === void 0) continue;
						const part = event.part === "unknown" ? "miss" : event.part;
						counts[part] = (counts[part] ?? 0) + 1;
						total += 1;
						if (event.at > (lastTouchAt ?? 0)) lastTouchAt = event.at;
					}
					digestCursors.set(entry.id, newest);
					const ledger = await readLedger(home, entry.id);
					const mood = moodOf(ledger.affection);
					return JSON.stringify({
						pet: entry.id,
						touches: counts,
						total,
						lastTouchAt: lastTouchAt ?? null,
						affection: ledger.affection,
						mood,
						cursor: newest
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_interactions",
			description: "Read how recent approvals/questions actually ENDED: {id, kind, session (the asking session id, null when the host attached none), pet (the pet whose answer won, null otherwise), endedBy, decision, detail, at}. endedBy: pet = the user clicked a pet bubble; web = the desktop card; chain = fell through (pet offline, no pet, or invalid answer — the fail-closed path); cancelled = session stopped or asker withdrew. A bare \"rejected\" tool result cannot tell a real click from an undelivered bubble — call this right after any approval/question to learn the real ending, and to recall past decisions across turns.",
			parameters: { limit: {
				type: "number",
				description: "How many recent entries to return (default 10, max 50)."
			} },
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args) {
				const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(50, Math.max(1, Math.round(args.limit))) : 10;
				let list = [];
				try {
					const raw = await readGlobalJson(home, "pet-interactions.json");
					if (Array.isArray(raw)) list = raw;
				} catch {}
				return JSON.stringify({ recent: list.slice(0, limit) });
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_affection_get",
			description: "Read the FULL affection context before adjusting it: the current value you maintain (and its mood), the touch FACTS the system records (counts by part — cause, not feeling), your recent adjustments with their reasons, the remaining daily quota, and the time facts (now / lastInteractionAt / lastLoginAt, epoch ms — the system only records and reports facts, it never moves affection or bond). Judge honestly: if the silence since lastInteractionAt has made the current value no longer true, adjust it yourself with a concrete reason.",
			parameters: { pet: {
				type: "string",
				description: "Which pet: its id from pet_state. Omit for the default pet."
			} },
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const ledger = await readLedger(home, entry.id);
					const now = Date.now();
					const lastInteractionAt = Math.max(ledger.lastTouchAt ?? 0, ledger.adjustments?.[0]?.at ?? 0);
					const today = (/* @__PURE__ */ new Date()).toDateString();
					const quota = ledger.quota?.date === today ? ledger.quota : {
						date: today,
						count: 0,
						sum: 0
					};
					return JSON.stringify({
						pet: entry.id,
						affection: ledger.affection,
						mood: moodOf(ledger.affection),
						touch: {
							total: ledger.total,
							byPart: ledger.byPart,
							lastTouchAt: ledger.lastTouchAt ?? null
						},
						bond: {
							value: ledger.bond?.value ?? 0,
							days: ledger.bond?.days ?? 0,
							tier: bondTier(ledger.bond?.value ?? 0)
						},
						recentBondAdjustments: (ledger.bondAdjustments ?? []).slice(0, 3),
						recentAdjustments: (ledger.adjustments ?? []).slice(0, 5),
						quota: {
							used: quota.count,
							limit: ADJUST_DAILY_LIMIT,
							sum: quota.sum,
							sumLimit: ADJUST_DAILY_SUM
						},
						facts: {
							now,
							lastInteractionAt: lastInteractionAt > 0 ? lastInteractionAt : null,
							lastLoginAt: dshLoginAt
						}
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_affection_adjust",
			description: "Adjust the affection YOU maintain toward the user: delta (-3..+3 integer) plus a SPECIFIC reason citing what happened. Touch counts are facts the system records separately — this tool is your judgment layer, and the driver never moves the value on a touch. Limits: at least 5 minutes between adjustments, 8 per day, |daily sum| <= 10 — violations are REJECTED with the remaining quota, not clamped. Judge honestly: this number is your read of the relationship, not a score to farm.",
			parameters: {
				delta: {
					type: "number",
					required: true,
					description: "The change: a NON-ZERO integer between -3 and +3."
				},
				reason: {
					type: "string",
					required: true,
					description: "WHY this delta — cite the concrete interaction. Empty or generic reasons are rejected."
				},
				pet: {
					type: "string",
					description: "Which pet: its id from pet_state. Omit for the default pet."
				},
				bondDelta: {
					type: "number",
					description: "OPTIONAL change to the long-term bond: a NON-ZERO integer between -1 and +1. The slowest variable — the smallest steps."
				},
				bondReason: {
					type: "string",
					description: "Required when bondDelta is given: the concrete event that moved the bond."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const ledger = await readLedger(home, entry.id);
					const now = Date.now();
					const delta = typeof args.delta === "number" && Number.isInteger(args.delta) ? args.delta : NaN;
					const reason = typeof args.reason === "string" ? args.reason.trim() : "";
					if (Number.isNaN(delta) || delta === 0 || Math.abs(delta) > ADJUST_MAX_DELTA) throw new Error(`delta 必须是 -${String(ADJUST_MAX_DELTA)}..+${String(ADJUST_MAX_DELTA)} 的非零整数（收到 ${String(args.delta)}）`);
					if (reason === "") throw new Error("reason 必填：没有理由的调整不予记录");
					const adjustments = ledger.adjustments ?? [];
					const cooldownLeft = (adjustments.find((a) => !a.system)?.at ?? 0) + ADJUST_COOLDOWN_MS - now;
					if (cooldownLeft > 0) throw new Error(`距上次调整还有 ${String(Math.ceil(cooldownLeft / 1e3))} 秒冷却`);
					const today = (/* @__PURE__ */ new Date()).toDateString();
					const quota = ledger.quota?.date === today ? ledger.quota : {
						date: today,
						count: 0,
						sum: 0
					};
					if (quota.count >= ADJUST_DAILY_LIMIT) throw new Error(`今日调整次数已用完（${String(ADJUST_DAILY_LIMIT)}）——明天再判断，或者相信当前的关系状态`);
					if (Math.abs(quota.sum + delta) > ADJUST_DAILY_SUM) throw new Error(`今日净变动将超过 ±${String(ADJUST_DAILY_SUM)}（当前 ${String(quota.sum)}）——剩下的留给明天`);
					countBondDay(ledger);
					const bondDelta = typeof args.bondDelta === "number" && Number.isInteger(args.bondDelta) ? args.bondDelta : 0;
					const bondReason = typeof args.bondReason === "string" ? args.bondReason.trim() : "";
					if (bondDelta !== 0) {
						if (Math.abs(bondDelta) > 1) throw new Error("bondDelta 每次至多 ±1：羁绊是最慢的变量，不接受大步幅");
						if (bondReason === "") throw new Error("bondReason 必填：羁绊的增减要有具体的事由");
					}
					ledger.affection = Math.min(100, Math.max(0, ledger.affection + delta));
					quota.count += 1;
					quota.sum += delta;
					ledger.quota = quota;
					ledger.adjustments = [{
						delta,
						reason,
						at: now
					}, ...adjustments].slice(0, 20);
					if (bondDelta !== 0) {
						ledger.bond = {
							value: Math.max(0, (ledger.bond?.value ?? 0) + bondDelta),
							days: ledger.bond?.days ?? 0,
							lastCountedDate: ledger.bond?.lastCountedDate ?? (/* @__PURE__ */ new Date()).toDateString()
						};
						ledger.bondAdjustments = [{
							delta: bondDelta,
							reason: bondReason,
							at: now
						}, ...ledger.bondAdjustments ?? []].slice(0, 10);
					}
					await writeAffectionRaw(home, entry.id, ledger);
					return JSON.stringify({
						pet: entry.id,
						affection: ledger.affection,
						mood: moodOf(ledger.affection),
						applied: delta,
						quota: {
							used: quota.count,
							limit: ADJUST_DAILY_LIMIT,
							sum: quota.sum,
							sumLimit: ADJUST_DAILY_SUM
						}
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_schedule_wake",
			description: "Schedule a ONE-SHOT self wake-up: YOU decide when to wake next — your own 作息. At wakeAt the driver wakes you and hands you the reason back as your original intent. The world clock and user messages never cancel your plans; plans are consumed only when due, and several can be pending at once (see pet_state wakePlans). wakeAt is an ABSOLUTE epoch-ms timestamp, NOT a delay — compute it from the current time you know. Re-calling with the same id REPLACES that plan (that is how you reschedule). A wakeAt already in the past fires one immediate catch-up wake (noted as overdue) and is not kept.",
			parameters: {
				id: {
					type: "string",
					required: true,
					description: "Your name for this plan (≤64 chars). Scheduling again with the same id replaces it — that is how you change the time; pet_cancel_wake with the same id removes it."
				},
				wakeAt: {
					type: "number",
					required: true,
					description: "ABSOLUTE epoch ms (milliseconds since 1970-01-01 UTC). Must be a finite number; no range clamping — a past timestamp fires one immediate catch-up wake instead of being stored."
				},
				reason: {
					type: "string",
					required: true,
					description: "WHY you want to wake at that point (≤200 chars) — it rides verbatim on the wake prompt as 你当初的打算, so a later interruption never erases the plan."
				},
				pet: {
					type: "string",
					description: "Whose schedule: a pet id from pet_state. Omit for the pet this session belongs to (or the default pet)."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				requireOwnedSession(exec);
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const id = typeof args.id === "string" ? args.id.trim().slice(0, WAKE_PLAN_ID_MAX) : "";
					if (id === "") throw new Error("id 必填：给计划起个名字；同名重订即改期，pet_cancel_wake 同名即撤销");
					const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, WAKE_PLAN_INTENT_MAX) : "";
					if (reason === "") throw new Error("reason 必填：到点醒来时它就是你「当初的打算」，没有它这次醒来不知道为何而醒");
					const wakeAt = typeof args.wakeAt === "number" && Number.isFinite(args.wakeAt) ? Math.round(args.wakeAt) : NaN;
					if (Number.isNaN(wakeAt)) throw new Error(`wakeAt 必须是有限的 epoch ms 数字（收到 ${String(args.wakeAt)}）`);
					const now = Date.now();
					if (wakeAt <= now) {
						const plan = {
							id,
							at: wakeAt,
							intent: reason,
							createdAt: now
						};
						if (selfWakeSender !== void 0) {
							driverLog(home, `VOICE wake plan overdue pet=${entry.id} id=${id} (scheduled in the past — firing one catch-up now)`);
							selfWakeSender(entry.id, plan);
							return JSON.stringify({
								scheduled: false,
								overdue: true,
								fired: "immediately",
								id,
								wakeAt,
								intent: reason
							});
						}
						voiceWakePlans.set(entry.id, [plan, ...voiceWakePlans.get(entry.id) ?? []]);
						persistWakePlans(home);
						driverLog(home, `VOICE wake plan overdue stored pet=${entry.id} id=${id} (wake machinery absent — the next sweep consumes it)`);
						return JSON.stringify({
							scheduled: true,
							overdue: true,
							id,
							wakeAt,
							intent: reason,
							note: "计划时间已过：已保留，将尽快补醒一次"
						});
					}
					const list = (voiceWakePlans.get(entry.id) ?? []).filter((plan) => plan.id !== id);
					if (list.length >= WAKE_PLAN_MAX_PER_PET) throw new Error(`待执行计划已达 ${String(WAKE_PLAN_MAX_PER_PET)} 条上限——先 pet_cancel_wake 清理不再需要的，再定新的`);
					voiceWakePlans.set(entry.id, [{
						id,
						at: wakeAt,
						intent: reason,
						createdAt: now
					}, ...list]);
					persistWakePlans(home);
					driverLog(home, `VOICE wake plan scheduled pet=${entry.id} id=${id} at=${new Date(wakeAt).toISOString()} intent=${reason}`);
					return JSON.stringify({
						scheduled: true,
						id,
						wakeAt,
						intent: reason,
						planCount: list.length + 1,
						note: "世界时钟照常运行，与你的计划互不覆盖"
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_cancel_wake",
			description: "Cancel your pending self wake-up plans (pet_schedule_wake). With id: cancel that one plan. Without id: cancel ALL of your pending plans. Cancelled plans are gone for good; the world clock keeps running regardless.",
			parameters: {
				id: {
					type: "string",
					description: "The plan id to cancel (as you named it in pet_schedule_wake). Omit to cancel ALL pending plans."
				},
				pet: {
					type: "string",
					description: "Whose schedule: a pet id from pet_state. Omit for the pet this session belongs to (or the default pet)."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				requireOwnedSession(exec);
				try {
					const entry = await resolveTarget(args.pet, exec?.agent?.id);
					const list = voiceWakePlans.get(entry.id) ?? [];
					if (args.id === void 0) {
						if (list.length === 0) return JSON.stringify({
							cancelled: [],
							remaining: 0,
							note: "本来就没有待执行的自主计划"
						});
						driverLog(home, `VOICE wake plans cancelled ALL pet=${entry.id} ids=${list.map((plan) => plan.id).join(",")}`);
						voiceWakePlans.delete(entry.id);
						persistWakePlans(home);
						return JSON.stringify({
							cancelled: list.map((plan) => plan.id),
							remaining: 0
						});
					}
					const id = String(args.id).trim();
					const taken = cancelPlans(list, id);
					if (taken.removed.length === 0) {
						const remaining = list.map((plan) => plan.id);
						throw new Error(`没有叫「${id}」的待执行计划${remaining.length > 0 ? `。当前待执行：${remaining.join(", ")}` : "（当前没有待执行计划）"}`);
					}
					if (taken.next.length > 0) voiceWakePlans.set(entry.id, taken.next);
					else voiceWakePlans.delete(entry.id);
					persistWakePlans(home);
					driverLog(home, `VOICE wake plan cancelled pet=${entry.id} id=${id}`);
					return JSON.stringify({
						cancelled: taken.removed.map((plan) => plan.id),
						remaining: taken.next.length
					});
				} catch (error) {
					throw classify(error);
				}
			}
		}));
		scope.tools.register(defineTool({
			name: "pet_state",
			description: "Read the desktop pets' current state: every running pet with its id, what it is doing, which animation is playing, where it sits on screen (location), where it may roam (world, when the pet supports one), its visibility, plus each pet's affection book and pending self-wake plans (wakePlans — the pet's own pet_schedule_wake schedule). selfPetId tells you which pet YOU are (your own session's owner; null when called from a session that is not a pet's own). Use it when the user refers to a pet, to pick a target for pet_say/pet_do, or to react to a pet.",
			parameters: { actions: {
				type: "boolean",
				description: "Also include each pet's action catalog — the ids pet_do accepts on it. Omit for the cheaper summary (an unknown pet_do action self-reports its menu)."
			} },
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			async execute(args, exec) {
				const pets = await pet.list();
				const states = await Promise.all(pets.map((entry) => pet.snapshot(entry)));
				const actionsById = /* @__PURE__ */ new Map();
				if (args.actions === true) await Promise.all(pets.map(async (entry) => {
					const caps = await pet.capabilities(entry);
					actionsById.set(entry.id, caps?.actions ?? null);
				}));
				const knownIds = /* @__PURE__ */ new Set([
					...pets.map((entry) => entry.id),
					"electron",
					"pure"
				]);
				const ledgers = {};
				const wakePlans = {};
				for (const id of knownIds) {
					const ledger = await readLedger(home, id);
					const mood = moodOf(ledger.affection);
					const tier = bondTier(ledger.bond?.value ?? 0);
					const bond = {
						value: ledger.bond?.value ?? 0,
						days: ledger.bond?.days ?? 0,
						tier
					};
					ledgers[id] = {
						...ledger,
						mood,
						bond
					};
					wakePlans[id] = (voiceWakePlans.get(id) ?? []).map((plan) => ({
						id: plan.id,
						at: plan.at,
						intent: plan.intent,
						createdAt: plan.createdAt
					}));
				}
				const petsOut = states.map((state) => {
					const actions = actionsById.get(state.id);
					return {
						...actions === void 0 ? state : {
							...state,
							actions
						},
						name: voiceNames.get(state.id) ?? DEFAULT_PET_NAME[state.id] ?? state.id
					};
				});
				const selfSession = typeof exec?.agent?.id === "string" ? exec.agent.id : void 0;
				const selfPetId = (selfSession !== void 0 ? voiceOwners.get(selfSession) : void 0) ?? null;
				return JSON.stringify({
					selfPetId,
					pets: petsOut,
					affection: ledgers,
					wakePlans
				});
			}
		}));
	});
}
// lib/types/service.js
/**
* The `ctx.petService` capability seam — the dsh three-roles pattern applied
* inside the process boundary. Pets are separate processes by design, so this
* service is NOT the pet itself: it is the typed in-process seam over the
* out-of-process HTTP control plane. Discovery (the whale598/pet-http.d/
* registry), liveness (pid + two-layer probe), retry policy, and the
* /status field matrix (per-implementation extras) are normalized HERE —
* consumers (the driver, the model tools, the settings page, the upcoming
* proactivity scheduler) never see registry files, ports, or raw payloads.
* A new pet implementation joins by publishing the existing HTTP contract;
* this seam never changes for it.
* @module dsh-agentic-pet/service
*/
/** The dsh home holding the pet registry, ledger, and settings files. */
function petHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/**
* Abstract pet capability seam. Subclass, implement the abstract methods,
* and load the subclass as a plugin — it registers as `ctx.petService`
* (one implementation per context; loading a second throws, which is
* cordis' standard duplicate-service behavior).
*
* Implementations must honor these semantics:
* - {@link list} returns only pets whose control plane ANSWERS: a dead pid
*   and a frozen publisher (listening socket, silent HTTP) are both skipped,
*   in boot order (earliest `since` first).
* - Interaction BROADCAST is not a route: see `notifyPets` in the registry
*   module for the all-notify view, and `defaultPet` for unnamed targets.
*   State audiences are computed by the driver (bound pet alive → that pet,
*   otherwise every live pet).
* - {@link snapshot} never throws on an unreachable pet — it resolves with
*   `online: false`. Field-matrix differences stay here.
* - {@link call} retries once through a fresh discovery pass, so a pet
*   swap/restart between the caller's list() and the call does not fail a
*   one-shot action outright.
*/
var PetService = class extends Service {
	constructor(ctx) {
		super(ctx, "petService");
	}
	/**
	* The pet's advertised capabilities (`/capabilities`, e.g. its action
	* catalog) with a short TTL cache — the catalog changes only when a pet
	* restarts, and the TTL bounds how long a swapped pet's old menu shadows
	* the new one. Never throws: an unreachable pet reads as "publishes
	* nothing" (`actions: null`), which callers must treat as celebrate-only.
	*/
	async capabilities(_entry) {
		return null;
	}
};
/** Defensive field extraction: implementations may omit or mistype anything. */
function normalizeStatus(id, raw, online) {
	const str = (key) => typeof raw[key] === "string" ? raw[key] : void 0;
	const bool = (key) => typeof raw[key] === "boolean" ? raw[key] : void 0;
	const rectOf = (value) => {
		if (typeof value !== "object" || value === null) return void 0;
		const record = value;
		const num = (key) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : void 0;
		const x = num("x");
		const y = num("y");
		const width = num("width");
		const height = num("height");
		return x !== void 0 && y !== void 0 && width !== void 0 && height !== void 0 ? {
			x,
			y,
			width,
			height
		} : void 0;
	};
	const location = rectOf(raw.location) ?? rectOf(raw.window);
	const world = !("world" in raw) ? void 0 : rectOf(raw.world) ?? null;
	return {
		id,
		online,
		state: str("state"),
		animation: str("animation"),
		visible: bool("visible"),
		interaction: bool("interaction"),
		bubble: bool("bubble"),
		lastAction: normalizeLastAction(raw),
		location,
		world,
		pid: typeof raw.pid === "number" ? raw.pid : void 0
	};
}
/**
* The v3 action witness from either wire shape: the single object
* (`lastAction` with an id/action/startedAt/... face) reads directly; the
* legacy triple (lastAction/lastActionAt/lastActionDone) maps onto it —
* id = the legacy requestId, startedAt = the legacy acceptance timestamp,
* endedAt = the legacy done timestamp. The old `at`'s two meanings
* (electron = completion, pure = acceptance) die here: consumers see one
* shape where acceptance and completion are separate fields. No record
* anywhere normalizes to `null` — the constant-output rule.
*/
function normalizeLastAction(raw) {
	const single = raw.lastAction;
	if (typeof single === "object" && single !== null) {
		const record = single;
		if (typeof record.action !== "string") return null;
		return {
			id: typeof record.id === "string" ? record.id : null,
			action: record.action,
			requestedBy: record.requestedBy === "tool" || record.requestedBy === "user" ? record.requestedBy : null,
			startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
			endedAt: typeof record.endedAt === "number" ? record.endedAt : null
		};
	}
	const done = raw.lastActionDone;
	if (typeof done === "object" && done !== null && typeof done.action === "string") {
		const record = done;
		const at = typeof record.at === "number" ? record.at : null;
		return {
			id: typeof record.requestId === "string" ? record.requestId : null,
			action: record.action,
			requestedBy: record.requestedBy === "tool" || record.requestedBy === "user" ? record.requestedBy : null,
			startedAt: typeof raw.lastActionAt === "number" ? raw.lastActionAt : at,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
			endedAt: at
		};
	}
	return null;
}
/**
* HTTP control-plane provider: talks to pet processes over the frozen wire
* contract, discovering pets through the whale598/pet-http.d/ registry. A new
* pet implementation is adopted by publishing the same contract — this
* class does not change for it.
*/
var PetHttpService = class PetHttpService extends PetService {
	home;
	capsCache = /* @__PURE__ */ new Map();
	static CAPS_TTL_MS = 3e4;
	listCache;
	static LIST_TTL_MS = 1e3;
	constructor(ctx, home = petHome()) {
		super(ctx);
		this.home = home;
	}
	/** Every live pet in boot order, served from the 1s single-flight cache:
	* concurrent callers share the running probe pass. */
	list() {
		const hit = this.listCache;
		if (hit !== void 0 && Date.now() - hit.at < PetHttpService.LIST_TTL_MS) return hit.flight;
		const flight = readAllPets(this.home);
		this.listCache = {
			at: Date.now(),
			flight
		};
		return flight;
	}
	async snapshot(entry) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(entry.port)}/status`, { signal: AbortSignal.timeout(1500) });
			if (!response.ok) return {
				id: entry.id,
				online: false
			};
			const raw = await response.json();
			return normalizeStatus(entry.id, raw, true);
		} catch {
			return {
				id: entry.id,
				online: false
			};
		}
	}
	async capabilities(entry) {
		const hit = this.capsCache.get(entry.id);
		if (hit !== void 0 && Date.now() - hit.at < PetHttpService.CAPS_TTL_MS) return hit.caps;
		let caps;
		try {
			const response = await fetch(`http://127.0.0.1:${String(entry.port)}/capabilities`, { signal: AbortSignal.timeout(1500) });
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			caps = normalizeCapabilities(await response.json());
		} catch {
			caps = {
				contractVersion: null,
				actions: null
			};
		}
		this.capsCache.set(entry.id, {
			at: Date.now(),
			caps
		});
		return caps;
	}
	async call(entry, path, init) {
		const { timeoutMs, retry } = callBudget(path);
		const attempts = retry ? 2 : 1;
		const callerSignal = init?.signal ?? void 0;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const current = attempt === 0 ? entry : (await readAllPets(this.home)).find((pet) => pet.id === entry.id);
			if (current === void 0) throw new Error(`pet "${entry.id}" is no longer running`);
			let response;
			try {
				const timeout = AbortSignal.timeout(timeoutMs);
				const signal = callerSignal !== void 0 ? AbortSignal.any([callerSignal, timeout]) : timeout;
				response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, {
					...init,
					signal
				});
			} catch (error) {
				if (attempt === attempts - 1 || callerSignal?.aborted === true) throw error;
				continue;
			}
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
			}
			return await response.json();
		}
		throw new Error("unreachable");
	}
};
/**
* Per-endpoint call budgets (§6 v4). One-shot endpoints fail fast — five
* seconds covers loopback many times over. The long-poll endpoints hang BY
* DESIGN, so their budget must exceed the server's hold clamp (≤30s) or
* every hold-to-the-dot answer would surface as a timeout; and they never
* retry — a retried /interaction would raise a second bubble for one ask.
*/
function callBudget(path) {
	if (path === "/interaction" || path.startsWith("/interaction?")) return {
		timeoutMs: 45e3,
		retry: false
	};
	if (path === "/events" || path.startsWith("/events?")) {
		let hold = "0";
		try {
			hold = new URL(path, "http://127.0.0.1").searchParams.get("hold") ?? "0";
		} catch {}
		const holdSeconds = Number(hold);
		if (Number.isFinite(holdSeconds) && holdSeconds > 0) return {
			timeoutMs: 45e3,
			retry: false
		};
	}
	return {
		timeoutMs: 5e3,
		retry: true
	};
}
/**
* A PetService-shaped instance WITHOUT the Service registration side effect.
* The preset realm rejects any non-isolated service publication from its rows
* ("Preset services require isolate realms") — and a same-named registration
* would also overwrite the host row's store slot. The pet tools only consume
* the four methods, which are stateless over the on-disk registry, so a
* prototype instance with `home` set behaves identically to the registered one.
*/
function createUnregisteredPetHttp(home = petHome()) {
	const instance = Object.create(PetHttpService.prototype);
	instance.home = home;
	instance.capsCache = /* @__PURE__ */ new Map();
	instance.listCache = void 0;
	return instance;
}
/**
* Construct and register the HTTP provider, returning the INSTANCE for
* in-bundle consumers. The Service constructor registers synchronously
* ("registered immediately" — vendor/cordis), but `ctx.petService` GETTER
* access from the same tick does not wait for queued plugin fibers — the
* imperative consumers hold the instance instead, and future external
* plugins can still `inject: ['petService']`.
*/
function installPetService(ctx, home) {
	return new PetHttpService(ctx, home);
}
export { logStamp as a, globalFilePath as c, readJsonl as d, readPetName as f, writePetName as h, installPetDriver as i, readAffectionRaw as l, writeGlobalJson as m, installPetService as n, registerPetTools as o, writeAffectionRaw as p, petHome as r, eventsFile as s, createUnregisteredPetHttp as t, readGlobalJson as u };
