/** Suppresses repeated, identical metadata fetch warnings for a CO. */
export class MetaWarningDeduplicator {
  private readonly warnings = new Map<string, string>();

  public shouldWarn(key: string, message: string): boolean {
    if (this.warnings.get(key) === message) return false;
    this.warnings.set(key, message);
    return true;
  }

  public reset(key: string): void {
    this.warnings.delete(key);
  }
}
