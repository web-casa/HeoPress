/**
 * The official codemods, oldest first (HeoPress P13 task 2.2). A release with a plugin API breaking change adds one
 * here and lists the change in its release notes; `heopress-ext codemod` runs the ones a plugin needs, in order.
 */
import type { Codemod } from './framework';
import { addExtensionPointRanges } from './add-extension-point-ranges';
import { lumibaseToHeopress } from './lumibase-to-heopress';

export const CODEMODS: readonly Codemod[] = [lumibaseToHeopress, addExtensionPointRanges];

export { runCodemods, type CodemodReport } from './framework';
