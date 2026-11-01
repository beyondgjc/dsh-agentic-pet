import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
//#region ../../../vendor/cosmokit/src/misc.ts
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
//#endregion
//#region ../../../vendor/cosmokit/src/volatile.ts
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
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
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
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
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
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
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
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
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
//#endregion
//#region ../../core/scope/src/store.ts
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
//#endregion
//#region ../../core/scope/src/index.ts
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
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
//#endregion
//#region ../../typert/protocol/src/remote-error.ts
/**
* One Remote call failure: a real Error carrying its stable code and typed
* details. Owners throw it at the failure point; the Host Gateway encodes it
* onto the wire unchanged; the Client face rebuilds an instance for the
* `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
* Discrimination is always by `code`, never by instanceof.
*/
var RemoteError = class extends Error {
	code;
	details;
	/** Structural marker: cross-realm/bundle identification never uses instanceof. */
	isDSHRemoteError = true;
	/**
	* @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
	* @param message - human diagnostic carried across the wire.
	* @param details - structured payload typed by the code.
	* @param options - standard Error options (`cause` survives in-process only).
	*/
	constructor(code, message, details, options) {
		super(message, options);
		this.code = code;
		this.details = details;
		this.name = "RemoteError";
	}
};
//#endregion
//#region ../../typert/protocol/src/index.ts
/**
* Remote decorators and explicit Gateway bindings backed by versioned
* descriptors carried on decorated class prototypes. Strict reflection
* remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/**
* Bind one visible Service field to a Cordis key and Remote namespace. A
* service that owns a Cordis Context also gives its tree `ctx.invocation`,
* `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
* a Host composition to read it.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	const ctx = Reflect.get(service, "ctx");
	if (Context.is(ctx)) provideInvocationAccessor(ctx);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
/**
* Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
* reflect service's "cannot get property" error; a call-derived Context shadows
* the accessor with its own property. The first Remote Service constructed in a
* tree registers it on the root, where it outlives any one Service.
*/
function provideInvocationAccessor(ctx) {
	if (Object.hasOwn(ctx.root.reflect.props, "invocation")) return;
	ctx.root.accessor("invocation", { get: () => void 0 });
}
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, { exportName: methodExportOrOptions });
	}
	if (typeof methodExportOrOptions === "object") return remoteDecorator({ kind: "direct" }, markerOptions(methodExportOrOptions, REMOTE_OPTION_KEYS, "Remote options require name, mode: \"stream\", or resources"));
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
const REMOTE_OPTION_KEYS = new Set([
	"name",
	"mode",
	"resources"
]);
/** Validate one decorator options object against its accepted keys and select the marker fields. */
function markerOptions(options, accepted, requirement) {
	const keys = Reflect.ownKeys(options);
	if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !accepted.has(key)) || Object.hasOwn(options, "mode") && options.mode !== "stream") throw new TypeError(`typert-protocol: ${requirement}`);
	const { mode, name, resources } = options;
	if (name !== void 0) validateName("Remote export name", name);
	return {
		...mode === void 0 ? {} : { mode },
		...name === void 0 ? {} : { exportName: name },
		...resources === void 0 ? {} : { resources: resourceReaders(resources) }
	};
}
/** Freeze declared readers into the marker record; a misdeclared reader fails at decoration. */
function resourceReaders(resources) {
	const readers = {};
	for (const [kind, reader] of Object.entries(resources)) {
		if (typeof reader !== "function") throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`);
		readers[kind] = reader;
	}
	if (Object.keys(readers).length === 0) throw new TypeError("typert-protocol: Remote resources require at least one reader");
	return Object.freeze(readers);
}
function remoteDecorator(invocation, options = {}) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, options);
	};
}
function readRemoteMethodDescriptor(prototype) {
	const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	if (property === void 0) return void 0;
	const descriptor = property.value;
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError("typert-protocol: Remote method descriptor must be an object");
	const version = Reflect.get(descriptor, "version");
	if (version !== 1) throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`);
	const methods = Reflect.get(descriptor, "methods");
	if (!Array.isArray(methods)) throw new TypeError("typert-protocol: Remote method descriptor methods must be an array");
	return descriptor;
}
function addMarkerInitializer(context, invocation, options = {}) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, options);
	});
}
function mark(prototype, method, invocation, { mode, exportName, resources }) {
	const descriptor = readRemoteMethodDescriptor(prototype);
	const marker = Object.freeze({
		method,
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation),
		...resources === void 0 ? {} : { resources }
	});
	const current = descriptor?.methods.find((candidate) => candidate.method === method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && current.resources === marker.resources && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...descriptor?.methods ?? [], marker])
		})
	});
}
function sameInvocation(left, right) {
	if (left.kind === "direct") return right.kind === "direct";
	if (right.kind === "direct") return false;
	return left.context === right.context;
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
//#endregion
//#region ../../util/values/src/partial-json.ts
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
//#endregion
//#region ../../util/values/src/index.ts
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/** Whether a realm-owned intrinsic prototype has a native constructor matching this engine's representation. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object);
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
* Validate and detach lossless JSON in one read per property.
* @param value - candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
* @param value - candidate value to test.
* @returns whether the value survives a JSON round trip without loss.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
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
//#endregion
//#region ../../llm/llm/src/message.ts
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
//#endregion
//#region ../../util/timeout/src/index.ts
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region ../../llm/llm/src/error.ts
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`) distinct from the
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
//#endregion
//#region ../../llm/llm/src/retry-policy.ts
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
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
const NORMAL_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const ALWAYS_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const BACKOFF_KEYS = new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
function validateKeys(value, allowed, path) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`);
}
function resolveBackoff(config, path) {
	if (config !== void 0) validateKeys(config, BACKOFF_KEYS, path);
	const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > 2147483647) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > 2147483647) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
	return Object.freeze({
		initialDelayMs,
		maxDelayMs,
		jitterRatio
	});
}
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
function resolveRetryPolicy(config, path) {
	if (config === void 0) return Object.freeze({
		mode: "normal",
		maxRetries: DEFAULT_MAX_RETRIES,
		retryableCodes: DEFAULT_RETRYABLE_CODES,
		...resolveBackoff(void 0, `${path}.backoff`)
	});
	switch (config.mode) {
		case "normal": {
			validateKeys(config, NORMAL_POLICY_KEYS, path);
			const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
			const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
			if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
			if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`);
			if (retryableCodes.some((code) => typeof code !== "string" || code.length === 0)) throw new Error(`${path}.retryableCodes must contain only non-empty strings`);
			if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`);
			return Object.freeze({
				mode: "normal",
				maxRetries,
				retryableCodes: Object.freeze([...retryableCodes]),
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		}
		case "always":
			validateKeys(config, ALWAYS_POLICY_KEYS, path);
			return Object.freeze({
				mode: "always",
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		default: throw new Error(`${path}.mode must be "normal" or "always"`);
	}
}
//#endregion
//#region ../../llm/llm/src/call-config.ts
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
function callConfigEquals(a, b) {
	if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
	if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop;
	return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
//#endregion
//#region ../../llm/llm/src/adapter-failure.ts
/**
* Normalization for values thrown by a final LLM adapter boundary.
*
* @module @deepseek-ai/dsh-llm/adapter-failure
*/
/**
* Detach serializable provider facts from a value thrown by an adapter.
* @param value - arbitrary value thrown during adapter dispatch or iteration.
* @returns immutable provider-neutral facts suitable for a terminal finish chunk.
* @internal
*/
function normalizeLlmFailure(value) {
	const error = value instanceof Error ? value : new HarnessError(thrownMessage(value), "UNKNOWN", { cause: value });
	const carried = ownFailureSnapshot(error);
	if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;
	return Object.freeze({
		message: errorMessage(error),
		code: harnessErrorCode(error)
	});
}
/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value) {
	try {
		const message = String(value);
		return message.length > 0 ? message : "LLM adapter failed";
	} catch (_hostileThrownValue) {
		return "LLM adapter failed";
	}
}
/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor !== void 0 && "value" in descriptor ? descriptor.value : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "failure");
		return descriptor !== void 0 && "value" in descriptor ? failureSnapshot(descriptor.value) : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const candidate = value;
		const message = candidate.message;
		const code = candidate.code;
		const status = candidate.status;
		const providerRetryAfterMs = candidate.providerRetryAfterMs;
		const requestId = candidate.requestId;
		const offloadImages = candidate.offloadImages;
		if (typeof message !== "string" || message.length === 0 || typeof code !== "string" || code.length === 0 || status !== void 0 && (!Number.isInteger(status) || status < 100 || status > 599) || providerRetryAfterMs !== void 0 && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) || requestId !== void 0 && (typeof requestId !== "string" || requestId.length === 0) || offloadImages !== void 0 && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0)) return void 0;
		return Object.freeze({
			message,
			code,
			...status === void 0 ? {} : { status },
			...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
			...requestId === void 0 ? {} : { requestId },
			...offloadImages === void 0 ? {} : { offloadImages }
		});
	} catch (_sdkFailureGetter) {
		return;
	}
}
/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error) {
	try {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch (_sdkMessageGetter) {}
	return "LLM adapter failed";
}
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
	return error instanceof HarnessError ? error.code : "UNKNOWN";
}
//#endregion
//#region ../../llm/llm/src/content.ts
function quoted(value) {
	return JSON.stringify(value);
}
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
/**
* True when typed model content contains an image block. This is the one image
* walk shared by every image policy (capability gating, text-only
* serialization, compaction survey), so a consumer cannot silently diverge.
* @param content - typed model content blocks.
* @returns whether any block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image");
}
/**
* True when typed model content contains a file block.
* Reads current content on every call without retaining scan results.
* @param content - typed model content blocks.
* @returns whether any block is a file.
*/
function contentHasFile(content) {
	for (const block of content) if (block.type === "file") return true;
	return false;
}
/**
* Stable model-facing handle for one durable file reference: the address of
* the verbatim stored copy and the instruction to read it on demand. This is
* the only representation a provider ever receives for a file.
* @param ref - durable verbatim file reference.
* @param readonlyPath - execution-world path of the stored copy, when resolvable.
* @returns deterministic handle text naming the file, its size, and its address.
*/
function fileHandleText(ref, readonlyPath) {
	const digest = String(ref.attachmentId).slice(7, 15);
	const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`;
	if (readonlyPath === void 0) return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`;
	return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`;
}
/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(blocks, resolvePath) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "file") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: fileHandleText(block.attachment, resolvePath(block.attachment))
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectFilesToText(messages, resolvePath) {
	if (!messages.some((message) => contentHasFile(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceFilesWithHandles(message.content, resolvePath);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: textOnlyImageText(block.attachment)
			});
			continue;
		}
		next?.push(block);
	}
	return next ?? blocks;
}
function projectImagesForTextModel(messages) {
	if (!messages.some((message) => contentHasImage(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceImagesForTextModel(message.content);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
function withoutDeveloperMessages(messages) {
	const retained = messages.filter((message) => message.role !== "developer");
	return retained.length === messages.length ? messages : retained;
}
function toolDeclarations(tools, mode, history) {
	const declarations = new Map(history.tools.map((tool) => [tool.name, tool]));
	for (const update of history.updates) for (const tool of update.additions) if (!declarations.has(tool.name)) declarations.set(tool.name, {
		...tool,
		deferLoading: true
	});
	switch (mode) {
		case "in-history": return declarations;
		case "addition-only": {
			const activeNames = new Set(tools?.map((tool) => tool.name));
			for (const name of declarations.keys()) if (!activeNames.has(name)) declarations.delete(name);
			return declarations;
		}
		/* v8 ignore next 2 -- closed-union exhaustiveness guard */
		default: return assertNever(mode);
	}
}
/**
* Construct provider declarations from session-folded history without changing logged active tools.
* Unsupported routes and incomplete history use current declarations without developer updates.
* Explicitly deferred baseline tools become available only after their first retained addition.
* @param messages - complete request inputs, or the prefix selected for an auxiliary call.
* @param tools - currently active tool schemas.
* @param toolUpdate - the resolved route's update mode.
* @param history - immutable state folded from committed headers and developer messages.
* @returns provider declarations and the corresponding filtered history.
*/
function projectToolUpdates(messages, tools, toolUpdate, history) {
	if (toolUpdate === void 0) {
		let immediateTools = tools;
		if (tools?.some((tool) => tool.deferLoading === true)) immediateTools = tools.map(({ deferLoading: _loading, ...tool }) => tool);
		return {
			messages: withoutDeveloperMessages(messages),
			tools: immediateTools
		};
	}
	if (history === void 0) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const messageIds = new Set(messages.flatMap((message) => message.role === "developer" ? [message.id] : []));
	if (history.updates.some((update) => !messageIds.has(update.messageId))) return {
		messages: withoutDeveloperMessages(messages),
		tools
	};
	const declarations = toolDeclarations(tools, toolUpdate, history);
	const updateIds = new Set(history.updates.map((update) => update.messageId));
	const offered = new Set(history.tools.filter((tool) => !tool.deferLoading).map((tool) => tool.name));
	const projectedMessages = [];
	for (const message of messages) {
		if (message.role !== "developer") {
			projectedMessages.push(message);
			continue;
		}
		if (!updateIds.has(message.id)) continue;
		const content = message.content.filter((block) => {
			switch (block.type) {
				case "tool-addition":
					if (!declarations.has(block.toolName) || offered.has(block.toolName)) return false;
					offered.add(block.toolName);
					return true;
				case "tool-removal":
					if (toolUpdate !== "in-history") return false;
					return offered.delete(block.toolName);
				default: return true;
			}
		});
		if (content.length === 0) continue;
		if (content.length === message.content.length) projectedMessages.push(message);
		else projectedMessages.push({
			...message,
			content
		});
	}
	return {
		messages: projectedMessages.length === messages.length && projectedMessages.every((message, index) => message === messages[index]) ? messages : projectedMessages,
		tools: [...declarations.values()]
	};
}
//#endregion
//#region ../../llm/llm/src/attribution.ts
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `docs/subsystems/llm-streaming.md#appidentity--app-attribution`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
//#endregion
//#region ../../llm/llm/src/index.ts
/**
* LLM service: adapter registry with a waterfall-interceptable streaming call
* API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
* provider backends, and `BlockAssembler` for chunk assembly.
*
* @module @deepseek-ai/dsh-llm
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId },
			...options?.offloadImages === void 0 ? {} : { offloadImages: options.offloadImages }
		});
	}
};
(() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listProviders_decorators;
	let _listConfigurableProviders_decorators;
	let _remoteDiscoverModels_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			__esDecorate(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listConfigurableProviders_decorators, {
				kind: "method",
				name: "listConfigurableProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listConfigurableProviders" in obj,
					get: (obj) => obj.listConfigurableProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _remoteDiscoverModels_decorators, {
				kind: "method",
				name: "remoteDiscoverModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDiscoverModels" in obj,
					get: (obj) => obj.remoteDiscoverModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		adapters = (__runInitializers(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		constructor(ctx) {
			super(ctx, "llm");
		}
		/** Notify topology observers without letting one broken listener veto the commit. */
		emitAdaptersUpdated() {
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				this.warnAdaptersListenerFailure(error);
			}
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnAdaptersListenerFailure(error) {
			this.ctx.logger.warn("llm: an llm/adapters-updated listener failed");
			this.ctx.logger.warn(error);
		}
		/**
		* Register an adapter for the given provider routes. Throws `LlmError` with code
		* `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
		* Disposed with the fiber.
		* @param providers - every provider route this adapter should serve.
		* @param adapter - the adapter that streams calls for those providers.
		* @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
		*/
		registerAdapter(providers, adapter) {
			const owned = /* @__PURE__ */ new Set();
			let released = false;
			const dispose = this.ctx.effect(function* () {
				if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
				this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
				yield () => {
					released = true;
					for (const provider of owned) this.adapters.delete(provider);
					owned.clear();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerAdapter()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
				this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
			};
			return handle;
		}
		/**
		* Validate one candidate route set for `adapter`, treating routes this
		* registration already holds as available. Nothing is mutated: a rejected
		* candidate leaves the registry exactly as it was.
		*/
		prepareRoutes(providers, adapter, owned) {
			const unique = /* @__PURE__ */ new Set();
			const registrations = [];
			for (const provider of providers) {
				if (provider.length === 0) throw new LlmError("adapter provider names must be non-empty", "INVALID_ADAPTER");
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
				unique.add(provider);
				const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
				registrations.push({
					adapter,
					provider: {
						id: info.id,
						name: info.name
					},
					retryPolicy
				});
			}
			return registrations;
		}
		/**
		* Swap this registration's routes for the prepared ones in one synchronous
		* section, so no observer can see the registry between the release and the
		* re-registration. The route set's one mutation point is also where
		* `llm/adapters-updated` is published, so a `replace` announces itself
		* exactly like a first registration.
		*/
		commitRoutes(owned, registrations) {
			for (const provider of owned) this.adapters.delete(provider);
			owned.clear();
			for (const registration of registrations) {
				this.adapters.set(registration.provider.id, registration);
				owned.add(registration.provider.id);
			}
			this.emitAdaptersUpdated();
		}
		/**
		* Describe provider routes with a registered adapter.
		* @returns detached provider metadata in registration order.
		*/
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
		/**
		* Declare provider routes an adapter plugin can activate through
		* configuration. Registration is all-or-nothing: an empty list, invalid
		* entry, or a provider already declared by any registration throws
		* `LlmError` without registering the rest. Disposed with the fiber.
		* @param entries - every configurable provider this plugin owns.
		* @returns a handle that withdraws all of them, and can atomically replace them.
		*/
		registerConfigurableProviders(entries) {
			let held = [];
			let disposed = false;
			/**
			* Validate a candidate set in full against everything this registration
			* does not already hold, then publish it. Nothing is written until the
			* whole set passes, so a refused candidate leaves the current entries in
			* place — the property that makes `replace` a swap rather than a
			* delete-then-add that can strand the directory empty.
			*/
			const commit = (candidates) => {
				const detached = [];
				const own = new Set(held.map((entry) => entry.provider));
				for (const entry of candidates) {
					if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) throw new LlmError("configurable providers need a non-empty provider, displayName, and settingsNs", "INVALID_DIRECTORY");
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push(detachDirectoryEntry(entry));
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (disposed) throw new LlmError("this configurable-provider registration was disposed", "REGISTRATION_DISPOSED");
				commit(next);
			};
			return handle;
		}
		/**
		* List every declared configurable provider, registered or dormant.
		* @returns detached directory entries in declaration order.
		*/
		listConfigurableProviders() {
			return [...this.directory.values()].map(detachDirectoryEntry);
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint and must honor the supplied signal.
		* @returns the disposer that withdraws the offer.
		*/
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				seen.add(model.id);
				models.push({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
					...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }
				});
			}
			return models;
		}
		/**
		* Remote adapter for one draft provider interrogation.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation supplied by the Remote carrier.
		* @returns advertised models in endpoint order.
		* @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
		*/
		async remoteDiscoverModels(settingsNs, request, signal) {
			try {
				return await this.discoverModels(settingsNs, request, signal);
			} catch (error) {
				throw new RemoteError("llm/model-discovery-rejected", error instanceof Error ? error.message : String(error), {
					settingsNs,
					...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
				}, { cause: error });
			}
		}
		/**
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve provider-side request-image pricing for one exact route, or
		* `undefined` when the provider is unregistered or declares none. Unknown
		* providers degrade to `undefined` rather than throwing because callers
		* price durable history whose route may no longer be mounted.
		* @param provider - provider route named by a request header.
		* @param model - exact model id named by the same header.
		* @returns the owning adapter's image pricing for the route, when declared.
		*/
		imageRequestPricing(provider, model) {
			return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
		}
		/**
		* Resolve the image projection for an exact registered model route.
		* @param provider - registered provider route.
		* @param model - exact model id.
		* @param image - normalized image reference.
		* @returns dimensions and byte target used by the adapter's request serializer.
		*/
		imageRequestTarget(provider, model, image) {
			return this.registration(provider).adapter.imageRequestTarget(provider, model, image);
		}
		/**
		* Resolve the exact text one durable file occurrence contributes to every
		* provider request in the current execution environment.
		* @param ref - durable verbatim file reference from model history.
		* @returns the same deterministic handle text used at adapter dispatch.
		*/
		fileRequestText(ref) {
			return fileHandleText(ref, this.fileReadPath(ref));
		}
		/** Detach typed adapter-owned modality metadata. */
		detachedModalities(modalities) {
			return modalities === void 0 ? void 0 : [...modalities];
		}
		/**
		* Discover models advertised by one registered provider. Catalog membership
		* does not constrain core routing. Catalog-driven entry points may restrict
		* selection and submission to the advertised models.
		* @param provider - registered provider route to inspect.
		* @returns detached model metadata in adapter-preferred order.
		*/
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities }
				};
			});
		}
		/**
		* Resolve and validate all metadata from the adapter that owns one exact
		* route. The result is detached from adapter-owned objects; catalog
		* membership remains advisory and does not control request routing.
		* @param provider - registered provider route to inspect.
		* @param model - exact model id passed to the adapter.
		* @param signal - optional cancellation for adapter-owned asynchronous lookup.
		* @returns exact model identity plus available context and reasoning metadata.
		*/
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
		/** Validate and detach one adapter-returned exact model result. */
		normalizeModelInfo(registration, model, resolved) {
			const provider = registration.provider.id;
			if (typeof resolved.provider !== "string" || resolved.provider !== provider || typeof resolved.id !== "string" || resolved.id !== model || typeof resolved.name !== "string" || resolved.name.length === 0 || resolved.description !== void 0 && typeof resolved.description !== "string") throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const context = resolved.context;
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
			const inputModalities = this.detachedModalities(resolved.inputModalities);
			const systemPromptUpdate = resolved.systemPromptUpdate;
			if (systemPromptUpdate !== void 0 && systemPromptUpdate !== "in-history") throw new LlmError(`adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const toolUpdate = resolved.toolUpdate;
			if (toolUpdate !== void 0 && toolUpdate !== "in-history" && toolUpdate !== "addition-only") throw new LlmError(`adapter returned invalid tool update mode for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const defaultMaxTokens = resolved.defaultMaxTokens;
			if (defaultMaxTokens !== void 0 && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, "INVALID_MODEL_MAX_TOKENS");
			const info = {
				provider,
				id: model,
				name: resolved.name,
				...resolved.description === void 0 ? {} : { description: resolved.description },
				...inputModalities === void 0 ? {} : { inputModalities },
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
				...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens },
				...resolved.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
				...resolved.toolUpdate === void 0 ? {} : { toolUpdate: resolved.toolUpdate }
			};
			const reasoning = resolved.reasoning;
			if (reasoning === void 0) return info;
			if (reasoning.efforts.length === 0) throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			const seen = /* @__PURE__ */ new Set();
			const efforts = reasoning.efforts.map((effort) => {
				if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
				seen.add(effort.id);
				return {
					id: effort.id,
					name: effort.name,
					...effort.description === void 0 ? {} : { description: effort.description }
				};
			});
			if (reasoning.defaultEffort !== void 0 && !seen.has(reasoning.defaultEffort)) throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			return {
				...info,
				reasoning: {
					efforts,
					...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort }
				}
			};
		}
		/**
		* Validate a conversation call config against its exact model capability and
		* materialize adapter-configured defaults. Unsupported explicit efforts
		* reject before provider I/O; no clamping or aliasing is performed. This
		* standalone query does not bind a later dispatch; use {@link prepareCall}
		* when logging and streaming must share one adapter registration.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a detached config only when a default must be materialized.
		*/
		async resolveCallConfig(config, signal) {
			return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
		}
		async resolveCallFor(registration, config, signal) {
			const info = await this.resolveModelInfoFor(registration, config.model, signal);
			return this.resolveCallWithInfo(config, info);
		}
		/** Validate request controls against one already-bound exact model result. */
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = {
						...defaulted,
						reasoningEffort: effective
					};
				}
			}
			return {
				config: resolvedConfig,
				...info.context === void 0 ? {} : { context: info.context },
				modelInfo: info
			};
		}
		/**
		* Resolve one call under its current adapter registration. The returned
		* one-shot handle keeps that registration across header logging and dispatch,
		* so HMR cannot combine one adapter's capability result with another adapter.
		* An optional synchronous callback selects concrete controls using captured
		* model metadata. Defaults and validation apply to its result. Callback
		* failures and cancellation reject preparation before dispatch.
		* @param config - provider/model route and optional concrete request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @param configure - pure control selection, called once before defaults and validation.
		* @returns a prepared config and its registration-bound stream entry point.
		*/
		async prepareCall(config, signal, configure) {
			signal?.throwIfAborted();
			const { provider, model, ...controls } = config;
			const registration = this.registration(provider);
			const adapterCall = await registration.adapter.prepareCall(provider, model, signal);
			signal?.throwIfAborted();
			const modelInfo = this.normalizeModelInfo(registration, model, adapterCall.model);
			const proposed = configure === void 0 ? config : {
				...configure(deepFreeze(structuredClone(controls)), deepFreeze(modelInfo)),
				provider,
				model
			};
			signal?.throwIfAborted();
			const resolved = this.resolveCallWithInfo(proposed, modelInfo);
			const resolvedConfig = deepFreeze(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze({
				...proposed.reasoningEffort === void 0 && resolvedConfig.reasoningEffort !== void 0 ? { reasoningEffort: true } : {},
				...proposed.maxTokens === void 0 && resolvedConfig.maxTokens !== void 0 ? { maxTokens: true } : {}
			});
			let dispatched = false;
			return Object.freeze({
				config: resolvedConfig,
				retryPolicy: registration.retryPolicy,
				adapterDefaults,
				...context === void 0 ? {} : { context },
				...modelInfo.inputModalities === void 0 ? {} : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
				...modelInfo.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: modelInfo.systemPromptUpdate },
				...modelInfo.toolUpdate === void 0 ? {} : { toolUpdate: modelInfo.toolUpdate },
				stream: (options) => {
					if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
					if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
					dispatched = true;
					return this.streamWithRegistration(options, {
						registration,
						config: resolvedConfig,
						modelInfo,
						dispatch: (options) => adapterCall.stream(options)
					});
				}
			});
		}
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
		/** Remove replay state whose historical route is owned by another adapter. */
		forAdapter(options, adapter) {
			const messages = options.messages.map((message) => {
				if (message.role !== "assistant") return message;
				const source = message.source;
				if (source.replayState === void 0) return message;
				if (this.adapters.get(source.provider)?.adapter === adapter) return message;
				return freezeMessage({
					...message,
					source: {
						kind: "model",
						provider: source.provider,
						model: source.model
					}
				});
			});
			if (messages.every((message, index) => message === options.messages[index])) return options;
			const filtered = {
				...options,
				messages
			};
			return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
		}
		/**
		* Resolve the current execution-world read path of one durable file
		* reference through the mounted attachment and filesystem providers.
		*/
		fileReadPath(ref) {
			let hostPath;
			try {
				hostPath = this.ctx.get("attachments")?.fileHostPath(ref);
			} catch {
				return;
			}
			if (hostPath === void 0) return void 0;
			return this.ctx.get("fs")?.processPathFromHostPath(hostPath);
		}
		/**
		* Final adapter boundary. Adapter selection, dispatch, iterator construction,
		* and iteration failures become one terminal failure chunk. Middleware and
		* downstream consumer failures remain thrown plugin or consumer errors.
		*/
		async *adapterStream(options, prepared) {
			let iterator;
			try {
				const registration = prepared?.registration ?? this.registration(options.provider);
				const adapter = registration.adapter;
				let modelInfo;
				let resolvedConfig;
				let dispatch;
				if (prepared === void 0) {
					const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
					modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
					resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
					dispatch = (options) => adapterCall.stream(options);
				} else {
					modelInfo = prepared.modelInfo;
					resolvedConfig = prepared.config;
					dispatch = prepared.dispatch;
				}
				if (prepared !== void 0 && !callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				let projectedMessages = resolvedOptions.messages;
				if (projectedMessages.some((message) => contentHasFile(message.content))) projectedMessages = projectFilesToText(projectedMessages, (ref) => this.fileReadPath(ref));
				if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content))) projectedMessages = projectImagesForTextModel(projectedMessages);
				const projectedTools = projectToolUpdates(projectedMessages, resolvedOptions.tools, modelInfo.toolUpdate, resolvedOptions.toolHistory);
				projectedMessages = projectedTools.messages;
				let projectedOptions = resolvedOptions;
				if (projectedMessages !== resolvedOptions.messages || projectedTools.tools !== resolvedOptions.tools) {
					projectedOptions = {
						...resolvedOptions,
						messages: projectedMessages,
						...projectedTools.tools === void 0 ? {} : { tools: projectedTools.tools }
					};
					if (Object.isFrozen(resolvedOptions)) deepFreeze(projectedOptions);
				}
				iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
			} catch (error) {
				yield adapterFailureChunk(error, options.signal);
				return;
			}
			let completed = false;
			try {
				while (true) {
					let item;
					try {
						const next = await iterator.next();
						item = next.done ? { done: true } : {
							done: false,
							value: next.value
						};
					} catch (error) {
						completed = true;
						yield adapterFailureChunk(error, options.signal);
						return;
					}
					if (item.done) {
						completed = true;
						return;
					}
					yield item.value;
				}
			} finally {
				if (!completed) {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, cleanup, and consumer failures
		* remain thrown.
		* @param options - the full request; `options.provider` selects the adapter.
		* @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
		*/
		stream(options) {
			return this.streamWithRegistration(options);
		}
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
	};
})();
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return {
		type: "finish",
		reason: signal?.aborted || failure.code === "ABORTED" ? {
			kind: "aborted",
			failure
		} : {
			kind: "error",
			failure
		}
	};
}
/** Copy a directory entry, including its arrays, so neither side can mutate the other's copy. */
function detachDirectoryEntry(entry) {
	const { nativeAuth } = entry;
	return {
		...entry,
		settingsPath: [...entry.settingsPath],
		...entry.baseURLEnv === void 0 ? {} : { baseURLEnv: [...entry.baseURLEnv] },
		...nativeAuth === void 0 ? {} : { nativeAuth: {
			...nativeAuth,
			env: [...nativeAuth.env]
		} }
	};
}
//#endregion
//#region ../../core/tools/src/executor.ts
/** Model tool descriptions and complete batch execution owned by plugins. @module */
/** The selected provider is missing or unloaded; another provider must not take its calls. */
var ToolExecutorUnavailableError = class extends HarnessError {
	constructor() {
		super("The selected tool executor is unavailable. Load an executor in this composition before running the agent.", "TOOL_EXECUTOR_UNAVAILABLE");
		this.name = "ToolExecutorUnavailableError";
	}
};
//#endregion
//#region ../../core/tools/src/json-schema.ts
/**
* Enforced JSON Schema subset shared by tool outputs, generated PTC mode
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
const CONSTRAINT_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = new Set([
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
//#endregion
//#region ../../core/tools/src/schema.ts
/** Unified JSON-value schema DSL, inference, compilation, and tool definition helpers. @module dsh-tools/schema */
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
		case "one-of":
			destination.target[destination.index] = node;
			break;
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
	const userProjectContent = options.projectContent;
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
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
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
* Omit execution and presentation callbacks from a tool definition.
* @param definition - visible capability or executor-owned transport.
* @param detachParameters - copy parameters for a caller-owned inspection result.
* @returns the model-facing schema fields.
*/
function projectToolSchema(definition, detachParameters) {
	const { name, description, parameters, deferLoading } = definition;
	const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
	if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
	return {
		name,
		description,
		parameters: detached,
		...deferLoading === true ? { deferLoading } : {}
	};
}
//#endregion
//#region ../../core/tools/src/contracts.ts
/** Tool definitions and invocation data shared by registries and executors. @module */
/** Reserved model-facing program transport name. */
const RUN_CODE_NAME = "run_code";
/** Failure to determine a tool's step-time availability. */
var ToolActivationError = class extends HarnessError {
	/**
	* Preserve a condition failure without treating it as normal unavailability.
	* @param name - tool whose condition rejected.
	* @param cause - underlying condition failure.
	*/
	constructor(name, cause) {
		super(`cannot resolve availability of tool "${name}"`, "TOOL_ACTIVATION_FAILED", { cause });
		this.name = "ToolActivationError";
	}
};
//#endregion
//#region ../../core/tools/src/index.ts
/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty();
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
};
var GuardLayer = class {
	guards = new AnonymousEntries();
	isEmpty() {
		return this.guards.isEmpty();
	}
};
(class extends Service {
	static inject = ["systemPrompt"];
	static Config = Schema.object({
		mode: Schema.never().description("Removed. Mount a native or PTC tool executor instead."),
		maxParallelSubCalls: Schema.never().description("Moved to the PTC tool executor configuration.")
	});
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	scoped = /* @__PURE__ */ new WeakMap();
	root;
	guards = new ScopedLayers(() => new GuardLayer(), () => {});
	constructor(ctx) {
		super(ctx, "tools");
		ctx.systemPrompt.tools(({ scope, toolSet }) => {
			const description = this.selectExecutor(scope).describe(this.definitions(scope, toolSet));
			return {
				...description,
				knownNames: description.knownNames ?? [...this.view(scope).knownNames]
			};
		});
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @param options - optional step-time activation condition.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition, options = {}) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {
			definition,
			when: options.when
		}), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
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
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Resolve visible tools and pre-restriction names. Restrictions across the
	* scope chain intersect over inherited global and ancestor tools; the viewing
	* scope's own registrations remain exempt. Nearer registrations shadow
	* farther ones. Pre-restriction names support restriction and prompt-order validation.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration);
		}
		const visible = /* @__PURE__ */ new Map();
		const registrations = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, registration] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) {
				visible.set(name, registration.definition);
				registrations.set(name, registration);
			}
		}
		if (own !== void 0) for (const [name, registration] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, registration.definition);
			registrations.set(name, registration);
		}
		return {
			visible,
			registrations,
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
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope, toolSet) {
		return toolSet === void 0 ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name);
	}
	/**
	* Resolve the definition a call may execute. With a step's admitted set, the
	* set decides; without one, conditional registrations are unavailable.
	* @param name - the tool name as registered.
	* @param scope - the calling agent; omitted = the global view.
	* @param toolSet - step admission, or omitted for a call outside a model step.
	* @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
	*/
	executable(name, scope, toolSet) {
		if (toolSet !== void 0) return toolSet.view(scope).get(name);
		const view = this.view(scope);
		return view.registrations.get(name)?.when === void 0 ? view.visible.get(name) : void 0;
	}
	/**
	* Resolve conditions once for this step without changing shared registrations.
	* Cancellation or a rejected condition publishes no partial selection. Removed
	* registrations cannot be restored by a late condition result.
	* @param context - preparing agent, captured model selection, and cancellation.
	* @returns the complete selection; the caller disposes it after its tool batch settles.
	*/
	async resolve(context) {
		const { agent, signal } = context;
		signal.throwIfAborted();
		const view = this.view(agent);
		const admitted = /* @__PURE__ */ new Map();
		for (const [name, definition] of view.visible) {
			const registration = view.registrations.get(name);
			let enabled;
			try {
				enabled = registration?.when === void 0 || await registration.when(context);
			} catch (cause) {
				signal.throwIfAborted();
				throw new ToolActivationError(name, cause);
			}
			signal.throwIfAborted();
			if (enabled) admitted.set(name, definition);
		}
		let closed = false;
		return Object.freeze({
			dispose: () => {
				closed = true;
			},
			view: (scope) => {
				const visible = /* @__PURE__ */ new Map();
				if (closed || scope !== agent) return visible;
				const current = this.view(agent);
				for (const [name, definition] of admitted) if (current.visible.get(name) === definition && current.registrations.get(name) === view.registrations.get(name)) visible.set(name, definition);
				return visible;
			}
		});
	}
	/**
	* Read the visible capability definitions for descriptions and program bindings.
	* @param scope - viewing Agent or preset; omitted selects the global view.
	* @param toolSet - step admission; omit only to inspect registered definitions.
	* @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
	*/
	definitions(scope, toolSet) {
		return toolSet === void 0 ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()];
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param toolSet - step admission, or omitted for registered-definition inspection.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope, toolSet) {
		return this.definitions(scope, toolSet).map((definition) => projectToolSchema(definition, true));
	}
	/**
	* Provide the executor for the calling scope; an unscoped contribution is the deployment default.
	* Rendering any executor-owned section requires the viewing scope's selection to remain available.
	* @param executor - initialized provider owned by the contributing plugin.
	* @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
	*/
	setExecutor(executor) {
		const scope = scopeOf(this.ctx);
		if ((scope === void 0 ? this.root : this.scoped.get(scope))?.executor !== void 0) throw new Error("Only one tool executor may be registered in each scope");
		const record = { executor };
		return this.ctx.effect(function* () {
			for (const section of executor.sections ?? []) yield this.ctx.systemPrompt.section({
				name: section.name,
				order: section.order,
				...section.interpolate === void 0 ? {} : { interpolate: section.interpolate },
				text: ({ scope, toolSet }) => {
					if (this.selectExecutor(scope) !== executor) return "";
					return typeof section.text === "function" ? section.text(this.definitions(scope, toolSet)) : section.text;
				}
			});
			if (scope === void 0) this.root = record;
			else this.scoped.set(scope, record);
			yield () => {
				record.executor = void 0;
			};
		}.bind(this), "tools.setExecutor()");
	}
	/**
	* Resolve the nearest scoped provider, or the deployment default.
	* @param scope - Agent or preset scope; omitted selects only the root contribution.
	* @returns the selected executor; throws when it is missing or unloaded.
	*/
	selectExecutor(scope) {
		let record;
		for (const key of scopeChainOf(scope)) {
			record = this.scoped.get(key);
			if (record !== void 0) break;
		}
		record ??= this.root;
		const executor = record?.executor;
		if (executor === void 0) throw new ToolExecutorUnavailableError();
		return executor;
	}
	/**
	* Delegate a raw call batch to its Agent's provider or the deployment default.
	* Select at dispatch; accepted batches settle through that provider even if it unloads.
	* @param input - original calls, optional owning Agent, and optional logging step.
	* @returns the selected executor's settled batch; unavailable selections reject.
	*/
	async execute(input) {
		return this.selectExecutor(input.agent).execute(input);
	}
	/**
	* Register a monotonic denial in the calling scope.
	* @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
	* @returns the effect disposer that removes this guard.
	*/
	guard(guard) {
		return this.guards.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()" });
	}
	/**
	* Check global and inherited guards after pre-execute policy and approval resolve.
	* @param exec - invocation whose guards are checked before dispatch.
	* @returns the first denial reason, or undefined when no guard denies.
	*/
	checkGuards(exec) {
		for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) for (const guard of layer.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
});
//#endregion
//#region lib/types/actions.js
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
//#endregion
//#region lib/types/petdata.js
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
	await mkdir(petDataDir(home, petId), { recursive: true });
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
//#endregion
//#region lib/types/inner-voice.js
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
			boundSessions: {}
		};
	}
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
/** The wake prompt. Time context is injected by the preset's time-context
* row; the leading tag doubles as the durable trigger marker in the log. */
function buildWakePrompt(facts) {
	const lastSpoke = facts.minutesSinceLastSpoke === void 0 ? "这是你今天第一次醒来" : `你上次开口是 ${String(facts.minutesSinceLastSpoke)} 分钟前`;
	const user = facts.userActive ? `用户最近正在会话中工作（${String(facts.minutesSinceUserActivity ?? 0)} 分钟内有动静）` : "用户最近没有活动";
	return [
		"[自主唤醒]",
		`好感 ${String(facts.affection)}（${moodOf(facts.affection)}）；羁绊 ${facts.bondTier}（一起过了 ${String(facts.bondDays)} 天）；${lastSpoke}；${user}。`,
		"醒来想到什么就说一句（pet_say），想配动作就 pet_do；也可以只是安静待着（两者都不调，正文写「…」）。"
	].join(" ");
}
function buildTouchPrompt(facts) {
	return [
		"[被触摸]",
		`用户刚摸了你的${touchPartWording(facts.part) ?? "身体"}（今天第 ${String(facts.touchesToday)} 次，好感 ${String(facts.affection)}，${moodOf(facts.affection)}）。`,
		"回应一句（pet_say）或做个反应（pet_do）。"
	].join(" ");
}
/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
* pet's surface. The text rides verbatim — the pet answers through pet_say
* (and may pet_do); it is a conversation turn, not a touch reaction. Length
* clamps to the contract's 2000-character ceiling. */
function buildChatPrompt(text) {
	return `[用户对你说] ${text.slice(0, 2e3)}`;
}
//#endregion
//#region lib/types/registry.js
/**
* The pet registry: a directory of per-pet control manifests, replacing the
* last-writer-wins single files whose races caused repeated swap incidents
* (a dying carrier's late write burying a live pet's registration). Each pet
* implementation owns its own file under whale598/pet-http.d/ (legacy
* pet-http.d/ still scanned) and re-asserts it on a
* cadence; entries whose publisher pid is dead expire by omission. The
* driver reads the whole table and routes per the multi-pet design: the
* session's bound pet if alive, else the default pet (first alive entry),
* plus an all-notify broadcast mode for interactions.
* @module dsh-agentic-pet/registry
*/
const REGISTRY_DIR = `${WHALE_DIR}/pet-http.d`;
const LEGACY_REGISTRY_DIR = "pet-http.d";
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
/** Read every live entry in the registry. Dead-pid entries are skipped —
* they expire by omission the next time their file is rewritten — and so are
* silent entries (pid alive, control plane unresponsive). */
async function readLivePets(home) {
	const candidates = /* @__PURE__ */ new Map();
	for (const dir of [join(home, REGISTRY_DIR), join(home, LEGACY_REGISTRY_DIR)]) {
		let names = [];
		try {
			names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const name of names) {
			const id = name.slice(0, -5);
			if (id !== "" && !candidates.has(id)) candidates.set(id, join(dir, name));
		}
	}
	const live = [];
	for (const [id, file] of candidates) try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		const port = typeof raw.port === "number" ? raw.port : NaN;
		const pid = typeof raw.pid === "number" ? raw.pid : NaN;
		if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
		try {
			process.kill(pid, 0);
		} catch {
			continue;
		}
		if (!await probeControlPlane(port)) continue;
		live.push({
			id,
			port,
			pid,
			since: typeof raw.since === "number" ? raw.since : 0
		});
	} catch {}
	return live;
}
/** Legacy single-file manifests folded into the registry: the electron
* carrier's dedicated file and the pure pet's shared file, identity-validated
* and probe-validated, so pre-registry publishers stay drivable. */
const LEGACY_SOURCES = [{
	id: "electron",
	file: "pet-http-electron.json",
	identity: "electron"
}, {
	id: "pure",
	file: "pet-http.json",
	identity: "python"
}];
/** Every live pet: registry entries plus legacy single-file manifests folded
* under their pet ids (registry entries win on id collision). */
async function readAllPets(home) {
	const pets = await readLivePets(home);
	for (const { id, file, identity } of LEGACY_SOURCES) {
		if (pets.some((pet) => pet.id === id)) continue;
		try {
			const manifest = JSON.parse(await readFile(join(home, file), "utf8"));
			if (manifest.pet !== identity) continue;
			if (typeof manifest.port !== "number" || typeof manifest.pid !== "number") continue;
			try {
				process.kill(manifest.pid, 0);
			} catch {
				continue;
			}
			if (!await probeControlPlane(manifest.port)) continue;
			pets.push({
				id,
				port: manifest.port,
				pid: manifest.pid,
				since: 0
			});
		} catch {}
	}
	return pets;
}
/**
* Resolve the pet that should carry STATE for the given session, per the
* multi-pet design: the session's bound pet when alive, else the default pet
* (the first live entry — de facto "first started"). Single-pet deployments
* degenerate correctly: one live entry is both bound and default.
* @returns the entry, or undefined when no pet is alive.
*/
function routePet(pets, boundPetId) {
	if (boundPetId !== void 0) {
		const bound = pets.find((pet) => pet.id === boundPetId);
		if (bound !== void 0) return bound;
	}
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
//#endregion
//#region lib/types/driver.js
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
const ADJUST_COOLDOWN_MS = 5 * 6e4;
const ADJUST_DAILY_LIMIT = 8;
const ADJUST_DAILY_SUM = 10;
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
	const pushState = async (state) => {
		currentState = state;
		const target = await pet.route(boundPetId);
		if (target === void 0) return;
		const autonomy = await readAutonomy();
		const autonomyKey = JSON.stringify(autonomy);
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
				})
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
			const changedPets = new Set([...prevNames.keys(), ...voiceNames.keys()]);
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
		const original = request.signal;
		const decision = new AbortController();
		request.signal = original === void 0 ? decision.signal : AbortSignal.any([original, decision.signal]);
		const arms = notifyPets(await pet.list()).map((pet) => ({
			pet,
			ask: startAskPet(pet, body, original)
		}));
		let recorded = false;
		const record = (endedBy, decision, detail) => {
			if (recorded) return;
			recorded = true;
			driverLog(home, `INTERACTION ${iid} ${kind} endedBy=${endedBy}${detail !== void 0 ? ` (${detail})` : ""}`);
			recordInteraction({
				id: iid,
				kind,
				endedBy,
				decision,
				detail
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
			record("pet", winner.answer.answer);
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
		if (await promptVoice(petId, nextName !== void 0 ? `[改名] 用户给你改名叫「${label}」——以后自我介绍、气泡里自称，都用这个名字。` : `[改名] 用户把你改回了「${label}」。`)) driverLog(home, `VOICE rename notice pet=${petId} → ${label}`);
	};
	/** Random-wake trigger (docs/inner-voice.md §6.3). The gate decides whether
	* this wake speaks — never the model. */
	const triggerWake = async (petId) => {
		const config = await readInnerVoiceConfig(home);
		if (!config.enabled) return;
		driverLog(home, `VOICE wake tick pet=${petId} interval=${String(config.wakeIntervalMinutes)}min speakP=${String(config.speakProbability)}`);
		if (Math.random() >= config.speakProbability) {
			driverLog(home, `VOICE wake silent by probability pet=${petId}`);
			return;
		}
		if (!await voiceGateOpen(petId, true, "wake")) return;
		const ledger = await readLedger(home, petId);
		const now = Date.now();
		const lastSpoke = voiceLastSpokeAt.get(petId);
		if (await promptVoice(petId, buildWakePrompt({
			affection: ledger.affection,
			bondValue: ledger.bond?.value ?? 0,
			bondDays: ledger.bond?.days ?? 0,
			bondTier: bondTier(ledger.bond?.value ?? 0),
			minutesSinceLastSpoke: lastSpoke === void 0 ? void 0 : Math.round((now - lastSpoke) / 6e4),
			minutesSinceUserActivity: voiceUserActivityAt === void 0 ? void 0 : Math.round((now - voiceUserActivityAt) / 6e4),
			userActive: voiceUserActivityAt !== void 0 && now - voiceUserActivityAt < 30 * 6e4
		}))) voiceLastSpokeAt.set(petId, now);
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
		const ledger = await readLedger(home, petId);
		if (await promptVoice(petId, buildTouchPrompt({
			part,
			touchesToday: ledger.recent.filter((entry) => entry.part === part).length + 1,
			affection: ledger.affection
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
		if (await promptVoice(petId, buildChatPrompt(text), { userDriven: true })) voiceLastSpokeAt.set(petId, Date.now());
	};
	/** The wake sweep: a 60s tick checks each online pet's next-wake stamp.
	* Cadence comes from settings fresh each sweep, with ±25% jitter so two
	* pets never wake in lockstep; an interval change re-arms naturally. */
	/** The wake sweep: a 60s tick checks each online pet's next-wake stamp.
	* Cadence comes from settings fresh each sweep, with ±25% jitter so two
	* pets never wake in lockstep; an interval change re-arms naturally. */
	const wakeSweep = async () => {
		const config = await readInnerVoiceConfig(home);
		if (!config.enabled) return;
		const now = Date.now();
		const intervalMs = config.wakeIntervalMinutes * 6e4;
		for (const target of await pet.list()) {
			const next = voiceNextWakeAt.get(target.id);
			if (next === void 0) {
				voiceNextWakeAt.set(target.id, now + intervalMs * (.5 + Math.random() * .5));
				if (!voiceGreetedOnce.has(target.id)) triggerGreeting(target.id);
				continue;
			}
			if (now < next) continue;
			voiceNextWakeAt.set(target.id, now + intervalMs * (.75 + Math.random() * .5));
			await triggerWake(target.id);
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
				body: JSON.stringify({ action: "celebrate" })
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
			const target = (focus !== void 0 ? pets.find((entry) => entry.id === focus) : void 0) ?? routePet(pets, void 0);
			if (target === void 0) throw new Error("no pet is running");
			return target;
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
			description: "Read how recent approvals/questions actually ENDED: {id, kind, endedBy, decision, detail, at}. endedBy: pet = the user clicked a pet bubble; web = the desktop card; chain = fell through (pet offline, no pet, or invalid answer — the fail-closed path); cancelled = session stopped or asker withdrew. A bare \"rejected\" tool result cannot tell a real click from an undelivered bubble — call this right after any approval/question to learn the real ending, and to recall past decisions across turns.",
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
			name: "pet_state",
			description: "Read the desktop pets' current state: every running pet with its id, what it is doing, which animation is playing, where it sits on screen (location), where it may roam (world, when the pet supports one), its visibility, plus each pet's affection book. Use it when the user refers to a pet, to pick a target for pet_say/pet_do, or to react to a pet.",
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
			async execute(args) {
				const pets = await pet.list();
				const states = await Promise.all(pets.map((entry) => pet.snapshot(entry)));
				const actionsById = /* @__PURE__ */ new Map();
				if (args.actions === true) await Promise.all(pets.map(async (entry) => {
					const caps = await pet.capabilities(entry);
					actionsById.set(entry.id, caps?.actions ?? null);
				}));
				const knownIds = new Set([
					...pets.map((entry) => entry.id),
					"electron",
					"pure"
				]);
				const ledgers = {};
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
				return JSON.stringify({
					defaultPet: pets[0]?.id ?? null,
					pets: petsOut,
					affection: ledgers
				});
			}
		}));
	});
}
//#endregion
//#region lib/types/service.js
/**
* The `ctx.petService` capability seam — the dsh three-roles pattern applied
* inside the process boundary. Pets are separate processes by design, so this
* service is NOT the pet itself: it is the typed in-process seam over the
* out-of-process HTTP control plane. Discovery (pet-http.d/ registry plus
* legacy folding), liveness (pid + two-layer probe), retry policy, and the
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
*   and a frozen publisher (listening socket, silent HTTP) are both skipped.
* - {@link route} resolves the STATE carrier for a session: the named bound
*   pet when alive, else the default pet (the first live entry — de facto
*   "first started"). Interaction BROADCAST is not a route; see
*   `notifyPets` in the registry module for the all-notify view.
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
* contract, folding legacy single-file manifests into the registry. A new
* pet implementation is adopted by publishing the same contract — this
* class does not change for it.
*/
var PetHttpService = class PetHttpService extends PetService {
	home;
	capsCache = /* @__PURE__ */ new Map();
	static CAPS_TTL_MS = 3e4;
	constructor(ctx, home = petHome()) {
		super(ctx);
		this.home = home;
	}
	list() {
		return readAllPets(this.home);
	}
	async route(boundPetId) {
		return routePet(await this.list(), boundPetId);
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
		for (let attempt = 0; attempt < attempts; attempt++) {
			const current = attempt === 0 ? entry : (await readAllPets(this.home)).find((pet) => pet.id === entry.id);
			if (current === void 0) throw new Error(`pet "${entry.id}" is no longer running`);
			try {
				const timeout = AbortSignal.timeout(timeoutMs);
				const callerSignal = init?.signal ?? void 0;
				const signal = callerSignal !== void 0 ? AbortSignal.any([callerSignal, timeout]) : timeout;
				const response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, {
					...init,
					signal
				});
				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
				}
				return await response.json();
			} catch (error) {
				if (attempt === attempts - 1) throw error;
			}
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
//#endregion
export { logStamp as a, globalFilePath as c, readJsonl as d, readPetName as f, writePetName as h, installPetDriver as i, readAffectionRaw as l, writeGlobalJson as m, installPetService as n, registerPetTools as o, writeAffectionRaw as p, petHome as r, eventsFile as s, createUnregisteredPetHttp as t, readGlobalJson as u };
