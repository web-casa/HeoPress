/**
 * @heopress/public-site — what the public may see and where (HeoPress P06 design §0, Q1): host and path
 * resolution, the path space, the redirect engine and permalink paths. No HTTP and no database access of
 * its own: callers supply the data through `PublicReadPort` (the CMS from its tables, the rendering
 * service from the public projection).
 */
export * from './redirect-engine';
export * from './path-space';
export * from './permalink-path';
export * from './space';
export * from './resolve-path';
export { isSystemPathSegment } from './system-paths';
export { BUILTIN_THEME, BUILTIN_THEME_ID } from './theme/builtin.ts';
export { checkExtensionTemplates, checkTheme, extensionStubs, type ThemeIssue } from './theme/check.ts';
export { STARTER_THEMES, type StarterName } from './theme/starters.ts';
export { RenderError, RenderPool, type RenderJob, type RenderPoolOptions } from './theme/pool.ts';
export { headHtml as seoHeadHtml, type PreviewPolicy, type SystemContent } from './theme/postprocess.ts';
export { assertViewModel, ViewModelError } from './theme/validate.ts';
export { assetUrl, type ThemeAsset } from './theme/engine.ts';
export { runThemeChecks, sampleOutput, THEME_CHECKS_VERSION, type ThemeCheckResult } from './theme/smoke.ts';
export { withSponsoredRel } from './theme/sponsored.ts';
export { htmlToMarkdown, markdownCopyDifference, markdownUrlOf, plainFieldOf, textToMarkdown } from './markdown.ts';
export { anchorsOf, linksOf, type FoundLink } from './links.ts';
export {
  BRANCH_PREVIEW_COOKIE,
  BRANCH_PREVIEW_EXCHANGE_PREFIX,
  branchPreviewCookieOf,
  signBranchPreviewCookie,
  verifyBranchPreviewCookie,
  type BranchPreviewClaims,
} from './branch-preview-cookie.ts';
