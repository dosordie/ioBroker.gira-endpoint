"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GIRA_CO_FORMATS = exports.CO_META_STATE_DEFINITIONS = void 0;
exports.getCoMetaFormat = getCoMetaFormat;
exports.getCoMetaFormatText = getCoMetaFormatText;
exports.getCoMetaValueType = getCoMetaValueType;
exports.CO_META_STATE_DEFINITIONS = Object.freeze([
    ["metaFormatText", "string", "Gira format description"],
    ["metaValueType", "string", "Gira value type"],
]);
exports.GIRA_CO_FORMATS = Object.freeze({
    1: "1 Bit",
    2: "8 Bit (0..100)",
    3: "8 Bit (RTR)",
    4: "16 Bit Gleitkomma",
    5: "2 Bit",
    9: "4 Byte",
    10: "8 Bit unsigned / DALI",
    11: "8 Bit signed",
    12: "16 Bit unsigned",
    13: "16 Bit signed",
    14: "32 Bit unsigned / Sammelrückmeldeobjekt",
    15: "32 Bit signed",
    16: "4 Bit",
    17: "3 Byte",
    20: "3 Byte Zeit",
    21: "3 Byte Datum",
    22: "14 Byte String",
});
function getCoMetaFormat(meta) {
    if (meta?.format === null || meta?.format === undefined || meta?.format === "")
        return undefined;
    const format = Number(meta.format);
    return Number.isFinite(format) ? format : undefined;
}
function getCoMetaFormatText(meta) {
    const format = getCoMetaFormat(meta);
    return format === undefined ? undefined : exports.GIRA_CO_FORMATS[format];
}
function getCoMetaValueType(meta) {
    const format = getCoMetaFormat(meta);
    if (format === 1)
        return "boolean";
    if (format === 22)
        return "string";
    return format !== undefined && exports.GIRA_CO_FORMATS[format] ? "number" : "unknown";
}
