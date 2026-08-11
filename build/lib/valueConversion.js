"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTextEncoding = normalizeTextEncoding;
exports.encodeUidValue = encodeUidValue;
exports.decodeAckValue = decodeAckValue;
exports.decodeCoValue = decodeCoValue;
function normalizeTextEncoding(textEncoding) {
    return textEncoding === "latin1" ? "latin1" : "utf8";
}
function encodeUidValue(val, boolMode, textEncoding = "utf8", metaValueType = "unknown") {
    let method = "set";
    if (val === null || val === undefined) {
        return { uidValue: undefined, ackVal: val, method };
    }
    if (metaValueType === "string") {
        const ackVal = String(val);
        return {
            uidValue: Buffer.from(ackVal, normalizeTextEncoding(textEncoding)).toString("base64"),
            ackVal,
            method,
            encoding: "base64",
        };
    }
    if (metaValueType === "boolean") {
        const ackVal = typeof val === "string" ? val !== "0" && val !== "false" : Boolean(val);
        return { uidValue: ackVal ? "1" : "0", ackVal, method };
    }
    if (metaValueType === "number") {
        const ackVal = typeof val === "number" ? val : Number(val);
        return { uidValue: String(ackVal), ackVal, method };
    }
    let uidValue = val;
    let ackVal = val;
    if (boolMode) {
        if (typeof uidValue === "boolean") {
            ackVal = uidValue;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "number") {
            ackVal = uidValue !== 0;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "string") {
            if (uidValue === "true" || uidValue === "false") {
                ackVal = uidValue === "true";
                uidValue = ackVal ? "1" : "0";
            }
            else if (uidValue === "toggle") {
                uidValue = "1";
                method = "toggle";
            }
            else if (!isNaN(Number(uidValue))) {
                const num = Number(uidValue);
                ackVal = num !== 0;
                uidValue = num ? "1" : "0";
            }
            else {
                ackVal = uidValue;
                uidValue = Buffer.from(uidValue, normalizeTextEncoding(textEncoding)).toString("base64");
            }
        }
    }
    else {
        if (typeof uidValue === "boolean") {
            ackVal = uidValue ? 1 : 0;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "string") {
            if (uidValue === "true" || uidValue === "false") {
                ackVal = uidValue === "true" ? 1 : 0;
                uidValue = uidValue === "true" ? "1" : "0";
            }
            else if (uidValue === "toggle") {
                uidValue = "1";
                method = "toggle";
            }
            else if (isNaN(Number(uidValue))) {
                uidValue = Buffer.from(uidValue, normalizeTextEncoding(textEncoding)).toString("base64");
            }
        }
    }
    return { uidValue: String(uidValue), ackVal, method };
}
function decodeAckValue(val, boolMode) {
    if (boolMode) {
        if (typeof val === "number")
            return { value: val !== 0, type: "boolean" };
        if (typeof val === "string")
            return { value: val !== "0", type: "boolean" };
        return { value: Boolean(val), type: "boolean" };
    }
    else {
        if (typeof val === "boolean")
            return { value: val ? 1 : 0, type: "number" };
        if (typeof val === "number")
            return { value: val, type: "number" };
        if (typeof val === "string")
            return { value: val, type: "string" };
        return { value: val, type: "mixed" };
    }
}
function decodeCoValue(rawValue, boolMode, textEncoding = "utf8", metaValueType = "unknown") {
    if (metaValueType === "string") {
        return {
            value: Buffer.from(String(rawValue ?? ""), "base64").toString(normalizeTextEncoding(textEncoding)),
            type: "string",
        };
    }
    if (metaValueType === "boolean") {
        return decodeAckValue(rawValue, true);
    }
    if (metaValueType === "number") {
        const value = Number(rawValue);
        return Number.isNaN(value) ? decodeCoValue(rawValue, boolMode, textEncoding) : { value, type: "number" };
    }
    if (boolMode || typeof rawValue !== "string") {
        return decodeAckValue(rawValue, boolMode);
    }
    const num = Number(rawValue);
    if (!isNaN(num)) {
        return { value: num, type: "number" };
    }
    return {
        value: Buffer.from(rawValue, "base64").toString(normalizeTextEncoding(textEncoding)),
        type: "string",
    };
}
