import { namespacesOf } from './namespaces';

/** The en Studio namespaces, one chunk loaded only when the interface is in this language (P07a task 13.3). */
export default namespacesOf(import.meta.glob<{ default: Record<string, unknown> }>('../en/*.json', { eager: true }));
