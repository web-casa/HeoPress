/** The plugin bundle as one ES module (code only; nothing written). */
export function bundle(): Promise<string>;
/** The manifest with the template and component sources of templates/. */
export function manifest(): Promise<Record<string, unknown>>;
/** Whether heopress-extension.json is up to date with templates/. */
export function manifestIsCurrent(): Promise<boolean>;
