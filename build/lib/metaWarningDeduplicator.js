"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaWarningDeduplicator = void 0;
/** Suppresses repeated, identical metadata fetch warnings for a CO. */
class MetaWarningDeduplicator {
    constructor() {
        this.warnings = new Map();
    }
    shouldWarn(key, message) {
        if (this.warnings.get(key) === message)
            return false;
        this.warnings.set(key, message);
        return true;
    }
    reset(key) {
        this.warnings.delete(key);
    }
}
exports.MetaWarningDeduplicator = MetaWarningDeduplicator;
