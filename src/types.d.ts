declare module "https-proxy-agent";
declare module "crypto" {
  export function randomUUID(): string;
}
declare module "util" {
  export function format(fmt: string, ...args: any[]): string;
}
